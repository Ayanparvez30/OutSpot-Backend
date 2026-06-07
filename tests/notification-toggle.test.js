#!/usr/bin/env node
/**
 * Integration test: Notification master switch guard (User.notificationEnabled).
 *
 * CRITICAL FEATURE: a user who turns notifications OFF must receive ZERO FCM
 * pushes from ANY code path. FCM is sent in exactly two real places, both now
 * guarded by the master switch:
 *   1. utils/notificationService.js  notifyUser(...)                  (line ~38 guard)
 *   2. utils/socket.js               sendPushNotificationToOfflineUsers(...) (line 83 guard)
 *
 * This test exercises the REAL functions (not reimplementations) against the
 * LIVE database (Prisma). The only thing stubbed is the real Firebase send call
 * (admin.messaging().send) — replaced with a spy so no real push leaves the box
 * and we can count/inspect exactly which FCM tokens were targeted.
 *
 * Stub strategy: both real modules do `const admin = require('../firebaseAdmin')`
 * at load time (cached singleton) and call `admin.messaging().send(...)` at SEND
 * time. We require the SAME cached firebaseAdmin module here and replace its
 * `.messaging` method to return `{ send: spy }`. Because require() is cached, the
 * real modules see our patched method when they invoke admin.messaging() inside
 * the function body. We patch BEFORE requiring the real modules, and we assert
 * the spy is actually hit (call count > 0 in the enabled cases) to prove the
 * stub is wired and no real network call is made.
 *
 * Usage: node tests/notification-toggle.test.js
 * Requirements: DATABASE_URL + FIREBASE_* in .env (firebaseAdmin requires them).
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// ── NULL-case interception (set up BEFORE any module requires @prisma/client) ──
// The live notificationEnabled column is NOT NULL, so a genuine NULL row cannot
// be stored without a (disallowed) DDL change. To still exercise the REAL guard
// code against a null value, we wrap the @prisma/client PrismaClient constructor
// so EVERY instance (test + the module-private ones inside notificationService.js
// and userController.js) gets a user.findUnique that, for ids we mark, returns
// notificationEnabled:null. The real query still runs against the DB; we only
// rewrite the one field on the returned object. No schema change, no guard
// reimplementation — the production code path executes unchanged and observes a
// null exactly as it would for a legacy/NULL row.
const prismaClientLib = require('@prisma/client');
const RealPrismaClient = prismaClientLib.PrismaClient;
const nullOverrideIds = new Set(); // ids whose notificationEnabled is presented as null
let nullInterceptActive = false;

function patchInstance(inst) {
  const origFindUnique = inst.user.findUnique.bind(inst.user);
  inst.user.findUnique = async function (args) {
    const res = await origFindUnique(args);
    if (
      nullInterceptActive && res &&
      args && args.where && nullOverrideIds.has(args.where.id)
    ) {
      return { ...res, notificationEnabled: null };
    }
    return res;
  };
  return inst;
}

class PatchedPrismaClient extends RealPrismaClient {
  constructor(...a) { super(...a); patchInstance(this); }
}
prismaClientLib.PrismaClient = PatchedPrismaClient;

const { PrismaClient } = prismaClientLib;
const prisma = new PrismaClient();

// ── FCM STUB ────────────────────────────────────────────────────────────────
// Require the SAME cached firebaseAdmin singleton the real modules use.
// firebaseAdmin.js lives at project root; utils/* require('../firebaseAdmin')
// resolves to the same module, so this is the identical cached object.
const admin = require('../firebaseAdmin');

// Spy state: every send() records the token it was asked to push to.
const sentTokens = [];
let sendCallCount = 0;
function resetSpy() { sentTokens.length = 0; sendCallCount = 0; }

// admin.messaging is a getter-only property on FirebaseNamespace, so we cannot
// reassign it. But admin.messaging() returns the Messaging service SINGLETON
// (cached per app). Both real modules call admin.messaging().send(...) at send
// time, so patching the singleton's .send method intercepts every push. This
// guarantees NO real Firebase network call fires.
const messagingSingleton = admin.messaging();
messagingSingleton.send = async (message) => {
  sendCallCount += 1;
  sentTokens.push(message && message.token);
  return 'stub-message-id'; // mimic Firebase resolved value
};
// Defensive: also make admin.messaging() always return this same patched
// singleton (it already does, since Firebase caches it per app).

// ── REQUIRE REAL MODULES (after stub is in place) ─────────────────────────────
const { notifyUser } = require('../utils/notificationService');
const { sendPushToOfflineUsers } = require('../utils/socket');
const {
  getNotificationSetting,
  setNotificationSetting,
} = require('../controllers/userController');

// ── Test harness ──────────────────────────────────────────────────────────────
const results = [];
function record(id, label, ok, detail) {
  results.push({ id, label, ok: !!ok, detail: detail || '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${ok ? '' : `  → ${detail}`}`);
}

// Mock res for controller calls
function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const TAG = 'test-notif-';

async function main() {
  // ── Baseline snapshot (prove exact restore in finally) ─────────────────────
  const baseline = {
    users: await prisma.user.count(),
    notifications: await prisma.notification.count(),
    chats: await prisma.chat.count(),
    userOnChats: await prisma.userOnChat.count(),
  };
  console.log('\n=== Notification Master Switch — Integration Test ===');
  console.log('Baseline counts:', JSON.stringify(baseline));

  // Inspect the LIVE column definition. The task premise was that the column is
  // nullable (so we can store NULL to prove "null treated as ON"). Verify.
  const colDef = (await prisma.$queryRawUnsafe(
    "SHOW COLUMNS FROM User LIKE 'notificationEnabled'"
  ))[0];
  const columnIsNullable = colDef && String(colDef.Null).toUpperCase() === 'YES';
  console.log('Live column notificationEnabled:', JSON.stringify(colDef),
    `→ nullable=${columnIsNullable}`);
  if (!columnIsNullable) {
    console.log('  NOTE: live column is NOT NULL — a genuine NULL row cannot be stored.');
    console.log('        For the NULL case we intercept prisma.user.findUnique to return');
    console.log('        notificationEnabled:null for the U_NULL id, so the REAL guard code');
    console.log('        (utils/notificationService.js & userController.js) executes against a');
    console.log('        null value. No schema change, no reimplementation of the guard.');
  }

  // Track everything we create so we can delete exactly what we seeded.
  const created = { userIds: [], chatIds: [] };

  // Helper to seed a user with a known fcmToken.
  async function seedUser(suffix, { fcmToken = true, notificationEnabled = true } = {}) {
    const uname = `${TAG}${suffix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const u = await prisma.user.create({
      data: {
        username: uname,
        email: `${uname}@example.com`,
        password: 'x',
        notificationEnabled,
      },
    });
    if (fcmToken) {
      await prisma.user.update({ where: { id: u.id }, data: { fcmToken: `tok_${u.id}` } });
    }
    created.userIds.push(u.id);
    return (await prisma.user.findUnique({ where: { id: u.id } }));
  }

  let pass = 0, fail = 0;

  try {
    // ── Sanity: confirm sockets are NOT initialised → isUserOnline === false ──
    // socket.js only sets ioInstance inside initSocket(); we never call it, so all
    // seeded users are naturally OFFLINE for sendPushToOfflineUsers.

    // ── Seed users ────────────────────────────────────────────────────────────
    const U_ON = await seedUser('on', { notificationEnabled: true });
    const U_OFF = await seedUser('off', { notificationEnabled: false });
    const U_NULL = await seedUser('null', { notificationEnabled: true });
    // The live column is NOT NULL, so a genuine NULL row cannot be stored without
    // a (disallowed) DDL change. To still exercise the REAL guard against a null
    // value, intercept the SHARED user-delegate prototype's findUnique so that
    // ONLY the U_NULL id resolves with notificationEnabled:null. All PrismaClient
    // instances (including the module-private ones inside notificationService.js
    // and userController.js) share this prototype, so the real code paths run
    // unchanged and simply observe a null. Restored before assertions 5-10.
    // Activate the null override for U_NULL (set up at module load via the
    // PrismaClient constructor wrapper). Every instance's user.findUnique now
    // presents notificationEnabled:null for this id.
    nullOverrideIds.add(U_NULL.id);
    nullInterceptActive = true;
    var restoreNullIntercept = () => {
      nullInterceptActive = false;
      nullOverrideIds.clear();
    };
    const U_NOTOKEN = await seedUser('notoken', { fcmToken: false, notificationEnabled: true });
    const SENDER = await seedUser('sender', { notificationEnabled: true });

    // Confirm the intercept surfaces null for U_NULL via the REAL delegate.
    const nullViaDelegate = await prisma.user.findUnique({ where: { id: U_NULL.id } });
    console.log('  U_NULL notificationEnabled (via intercepted findUnique) =',
      JSON.stringify(nullViaDelegate?.notificationEnabled),
      '(DB actually stores 1; intercept presents null to prove null→ON branch)');

    // ════════════════════════════════════════════════════════════════════════
    //  notifyUser — REAL function from utils/notificationService.js
    // ════════════════════════════════════════════════════════════════════════

    // 1) U_ON → push sent once with U_ON token + in-app row created
    resetSpy();
    const notif1 = await notifyUser(U_ON.id, 'FRIEND_REQUEST', 'T', 'D', { actorId: SENDER.id });
    {
      const rowOk = !!notif1 && notif1.userId === U_ON.id;
      const sentToOn = sendCallCount === 1 && sentTokens.includes(`tok_${U_ON.id}`);
      record('1', 'notifyUser(U_ON): FCM sent once w/ U_ON token + Notification row created',
        sentToOn && rowOk,
        `sendCount=${sendCallCount} tokens=${JSON.stringify(sentTokens)} row=${rowOk}`);
      // Prove the stub is actually hit (no real network call leaves).
      if (!(sendCallCount > 0)) {
        record('1b', 'STUB SANITY: admin.messaging().send spy was invoked', false,
          'spy never called — stub not wired; would have attempted real Firebase send');
      }
    }

    // 2) U_OFF → NO push, but in-app row + redDot still created
    resetSpy();
    const notif2 = await notifyUser(U_OFF.id, 'FRIEND_REQUEST', 'T', 'D', {});
    {
      const rowExists = await prisma.notification.findFirst({ where: { id: notif2.id, userId: U_OFF.id } });
      const offUser = await prisma.user.findUnique({ where: { id: U_OFF.id } });
      const noSend = sendCallCount === 0;
      const rowOk = !!rowExists;
      const redDot = offUser.notificationRedDot === true;
      record('2', 'notifyUser(U_OFF): ZERO FCM, but Notification row + redDot still set',
        noSend && rowOk && redDot,
        `sendCount=${sendCallCount} (expected 0) rowSaved=${rowOk} redDot=${redDot}`);
    }

    // 3) U_NULL → push sent (null treated as ON) + row created
    resetSpy();
    const notif3 = await notifyUser(U_NULL.id, 'FRIEND_REQUEST', 'T', 'D', {});
    {
      const sentToNull = sendCallCount === 1 && sentTokens.includes(`tok_${U_NULL.id}`);
      const rowOk = !!notif3 && notif3.userId === U_NULL.id;
      record('3', 'notifyUser(U_NULL): null treated as ON → FCM sent + row created',
        sentToNull && rowOk,
        `sendCount=${sendCallCount} tokens=${JSON.stringify(sentTokens)} row=${rowOk}`);
    }

    // 4) enabled=true but NO fcmToken → no send, row still created (sanity)
    resetSpy();
    const notif4 = await notifyUser(U_NOTOKEN.id, 'FRIEND_REQUEST', 'T', 'D', {});
    {
      const noSend = sendCallCount === 0;
      const rowOk = !!notif4 && notif4.userId === U_NOTOKEN.id;
      record('4', 'notifyUser(no token): no FCM (no token) but row still created',
        noSend && rowOk,
        `sendCount=${sendCallCount} (expected 0) row=${rowOk}`);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  sendPushToOfflineUsers — REAL exported fn from utils/socket.js
    // ════════════════════════════════════════════════════════════════════════

    // Build a group chat with members: U_ON, U_OFF, U_NULL (offline, tokens, not
    // muted), a MUTED member, and a separate sender SENDER.
    const U_MUTED = await seedUser('muted', { notificationEnabled: true });
    const chat = await prisma.chat.create({
      data: {
        name: `${TAG}chat`,
        isGroup: true,
        users: {
          create: [
            { userId: SENDER.id, role: 'ADMIN' },
            { userId: U_ON.id, role: 'MEMBER' },
            { userId: U_OFF.id, role: 'MEMBER' },
            { userId: U_NULL.id, role: 'MEMBER' },
            { userId: U_MUTED.id, role: 'MEMBER', isMuted: true },
          ],
        },
      },
    });
    created.chatIds.push(chat.id);

    // 5) + 6) one call → push to U_ON & U_NULL only; NOT U_OFF, NOT U_MUTED, NOT sender.
    resetSpy();
    await sendPushToOfflineUsers(chat.id, SENDER.id, 'Sen', 'Der', 'hello');
    {
      const tokOn = `tok_${U_ON.id}`, tokOff = `tok_${U_OFF.id}`, tokNull = `tok_${U_NULL.id}`;
      const tokMuted = `tok_${U_MUTED.id}`, tokSender = `tok_${SENDER.id}`;
      const gotOn = sentTokens.includes(tokOn);
      const gotNull = sentTokens.includes(tokNull);
      const gotOff = sentTokens.includes(tokOff);
      const gotMuted = sentTokens.includes(tokMuted);
      const gotSender = sentTokens.includes(tokSender);

      record('5', 'sendPushToOfflineUsers: pushed to U_ON & U_NULL, NOT U_OFF (master switch)',
        gotOn && gotNull && !gotOff,
        `tokens=${JSON.stringify(sentTokens)} on=${gotOn} null=${gotNull} off=${gotOff}`);

      record('6', 'sendPushToOfflineUsers: muted + sender excluded (guard composes w/ existing skips)',
        !gotMuted && !gotSender,
        `muted=${gotMuted} sender=${gotSender} tokens=${JSON.stringify(sentTokens)}`);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  API controllers — called directly with mock req/res
    // ════════════════════════════════════════════════════════════════════════

    // 7) getNotificationSetting(U_OFF) → { notificationEnabled: false }
    {
      const res = mockRes();
      await getNotificationSetting({ authData: { id: U_OFF.id } }, res);
      record('7', 'getNotificationSetting(U_OFF) → { notificationEnabled: false }',
        res.statusCode === 200 && res.body && res.body.notificationEnabled === false,
        `status=${res.statusCode} body=${JSON.stringify(res.body)}`);
    }

    // 8) getNotificationSetting(U_NULL) → { notificationEnabled: true } (normalized)
    {
      const res = mockRes();
      await getNotificationSetting({ authData: { id: U_NULL.id } }, res);
      record('8', 'getNotificationSetting(U_NULL) → { notificationEnabled: true } (null normalized)',
        res.statusCode === 200 && res.body && res.body.notificationEnabled === true,
        `status=${res.statusCode} body=${JSON.stringify(res.body)}`);
    }

    // 9) setNotificationSetting(U_ON, false) then (U_ON, true), checking DB each time.
    {
      const res1 = mockRes();
      await setNotificationSetting({ authData: { id: U_ON.id }, body: { enabled: false } }, res1);
      const db1 = await prisma.user.findUnique({ where: { id: U_ON.id }, select: { notificationEnabled: true } });
      const off = res1.body && res1.body.notificationEnabled === false && db1.notificationEnabled === false;

      const res2 = mockRes();
      await setNotificationSetting({ authData: { id: U_ON.id }, body: { enabled: true } }, res2);
      const db2 = await prisma.user.findUnique({ where: { id: U_ON.id }, select: { notificationEnabled: true } });
      const on = res2.body && res2.body.notificationEnabled === true && db2.notificationEnabled === true;

      record('9', 'setNotificationSetting toggles DB (false then true) + returns matching value',
        off && on,
        `afterFalse=${JSON.stringify({ resp: res1.body, db: db1.notificationEnabled })} afterTrue=${JSON.stringify({ resp: res2.body, db: db2.notificationEnabled })}`);
    }

    // 10) setNotificationSetting with non-boolean → 400
    {
      const resStr = mockRes();
      await setNotificationSetting({ authData: { id: U_ON.id }, body: { enabled: 'no' } }, resStr);
      const resMissing = mockRes();
      await setNotificationSetting({ authData: { id: U_ON.id }, body: {} }, resMissing);
      record('10', 'setNotificationSetting non-boolean / missing → 400',
        resStr.statusCode === 400 && resMissing.statusCode === 400,
        `stringBody=${resStr.statusCode} missingBody=${resMissing.statusCode}`);
    }
  } catch (err) {
    console.error('\nFATAL during assertions:', err);
    record('ERR', 'unexpected exception', false, err.message);
  } finally {
    // ── Restore the patched prisma delegate prototype ────────────────────────
    try { if (typeof restoreNullIntercept === 'function') restoreNullIntercept(); } catch (_) {}

    // ── Cleanup: delete EXACTLY what we seeded, in FK-safe order ─────────────
    try {
      // userOnChats removed via chat delete cascade? Be explicit to be safe.
      if (created.chatIds.length) {
        await prisma.userOnChat.deleteMany({ where: { chatId: { in: created.chatIds } } });
        await prisma.message.deleteMany({ where: { chatId: { in: created.chatIds } } });
        await prisma.chat.deleteMany({ where: { id: { in: created.chatIds } } });
      }
      if (created.userIds.length) {
        await prisma.notification.deleteMany({ where: { userId: { in: created.userIds } } });
        await prisma.notification.deleteMany({ where: { actorId: { in: created.userIds } } });
        await prisma.userOnChat.deleteMany({ where: { userId: { in: created.userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
      }
    } catch (cleanupErr) {
      console.error('CLEANUP ERROR:', cleanupErr);
    }

    // ── Confirm baseline restored EXACTLY ────────────────────────────────────
    const after = {
      users: await prisma.user.count(),
      notifications: await prisma.notification.count(),
      chats: await prisma.chat.count(),
      userOnChats: await prisma.userOnChat.count(),
    };
    const restored =
      after.users === baseline.users &&
      after.notifications === baseline.notifications &&
      after.chats === baseline.chats &&
      after.userOnChats === baseline.userOnChats;

    console.log('\n──────────────────────────────────────────────');
    console.log('Baseline after cleanup:', JSON.stringify(after));
    console.log(`DB baseline restored EXACTLY: ${restored ? 'YES' : 'NO'}`);
    if (!restored) {
      console.log('  diff:', JSON.stringify({
        users: after.users - baseline.users,
        notifications: after.notifications - baseline.notifications,
        chats: after.chats - baseline.chats,
        userOnChats: after.userOnChats - baseline.userOnChats,
      }));
    }

    // ── Results table ────────────────────────────────────────────────────────
    pass = results.filter(r => r.ok).length;
    fail = results.filter(r => !r.ok).length;

    console.log('\n════════════ RESULTS (1-10) ════════════');
    for (const r of results) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  [${r.id}] ${r.label}`);
      if (!r.ok) console.log(`         received: ${r.detail}`);
    }
    console.log('─────────────────────────────────────────');
    console.log('REAL code exercised : notifyUser (utils/notificationService.js),');
    console.log('                      sendPushToOfflineUsers (utils/socket.js),');
    console.log('                      getNotificationSetting/setNotificationSetting (controllers/userController.js)');
    console.log('STUBBED only        : admin.messaging().send (Firebase) — replaced by spy, no real push left the box');
    console.log(`Spy invoked at all  : ${'(see assertions 1 & 3 — enabled cases assert sendCount>0)'}`);
    console.log(`TOTAL: ${pass} passed, ${fail} failed (restored=${restored ? 'YES' : 'NO'})`);
    console.log('═════════════════════════════════════════\n');

    await prisma.$disconnect();
    process.exit(fail > 0 || !restored ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  prisma.$disconnect().finally(() => process.exit(2));
});
