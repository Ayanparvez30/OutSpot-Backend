#!/usr/bin/env node
/**
 * Integration test: notification toggle FIX — full OFF -> ON -> NOTIFY cycle.
 *
 * REPORTED BUG
 * ------------
 * After a user turned notifications OFF then back ON, friend-request FCM did not
 * resume. Root cause: setNotificationSetting(req,res) was strict
 * (`typeof enabled !== 'boolean'` => 400). A client that sent the flag as a
 * string ("true"), as 1/0, or under the alternate key `notificationEnabled`
 * (instead of `enabled`) hit the 400 path, so the ON write silently never
 * persisted. notificationEnabled stayed false and notifyUser kept suppressing
 * the push. The controller was made LENIENT (coerceBool + alternate key) so the
 * ON always persists regardless of client payload shape.
 *
 * WHAT IS REAL vs STUBBED
 * -----------------------
 *   REAL : setNotificationSetting / getNotificationSetting (controllers/userController.js)
 *          notifyUser (utils/notificationService.js)
 *          live Prisma DB (User + Notification rows actually written/read)
 *   STUB : admin.messaging().send  — replaced by a spy so NO real push fires and
 *          we can count/inspect the targeted FCM token. Restored in finally.
 *
 * FCM STUB STRATEGY
 * -----------------
 * Both real modules do `require('../firebaseAdmin')` (cached singleton) and call
 * `admin.messaging().send(...)` at send time. `admin.messaging` is a getter and
 * cannot be reassigned, but `admin.messaging()` returns the per-app Messaging
 * SINGLETON. We patch that singleton's `.send`. Because the singleton is cached,
 * every caller hits our spy. We assert the spy IS exercised (>0) in the send
 * cases to prove the stub is wired and no real network call leaves the box.
 *
 * Usage: node tests/notification-toggle-cycle.test.js
 * Requires: DATABASE_URL + FIREBASE_* in .env (firebaseAdmin requires them).
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── FCM STUB (patch the cached Messaging singleton's .send) ───────────────────
const admin = require('../firebaseAdmin');

let sendCallCount = 0;
const sentTokens = [];
function resetSpy() { sendCallCount = 0; sentTokens.length = 0; }

const messagingSingleton = admin.messaging();          // cached per-app singleton
const realSend = messagingSingleton.send;              // keep to restore in finally
messagingSingleton.send = async (message) => {
  sendCallCount += 1;
  sentTokens.push(message && message.token);
  return 'stub-message-id';                            // mimic Firebase resolved value
};

// ── REAL modules under test (required AFTER the stub is installed) ────────────
const { notifyUser } = require('../utils/notificationService');
const {
  getNotificationSetting,
  setNotificationSetting,
} = require('../controllers/userController');

// ── Harness ───────────────────────────────────────────────────────────────────
const results = [];
function record(id, label, ok, expected, received) {
  results.push({ id, label, ok: !!ok, expected, received });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}`);
  if (!ok) console.log(`        expected: ${expected}\n        received: ${received}`);
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// Call REAL setNotificationSetting with the given body, return {status, body}.
async function callSet(userId, body) {
  const res = mockRes();
  await setNotificationSetting({ authData: { id: userId }, body }, res);
  return { status: res.statusCode, body: res.body };
}
// Read the persisted column straight from the DB (source of truth).
async function dbEnabled(userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId }, select: { notificationEnabled: true },
  });
  return u.notificationEnabled;
}
// Call REAL getNotificationSetting, return the normalized response flag.
async function callGet(userId) {
  const res = mockRes();
  await getNotificationSetting({ authData: { id: userId } }, res);
  return res.body && res.body.notificationEnabled;
}

const TAG = 'test-nottoggle-';

async function main() {
  const baseline = {
    users: await prisma.user.count(),
    notifications: await prisma.notification.count(),
  };
  console.log('\n=== Notification toggle FIX — OFF→ON→NOTIFY cycle ===');
  console.log('Baseline counts:', JSON.stringify(baseline));

  const created = { userIds: [] };

  let U;
  try {
    // ── Seed one user U with a non-null fcmToken ───────────────────────────────
    const uname = `${TAG}${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    U = await prisma.user.create({
      data: {
        username: uname,
        email: `${uname}@example.com`,
        password: 'x',
        notificationEnabled: true,
        fcmToken: `tok_${uname}`,
      },
    });
    created.userIds.push(U.id);
    const TOKEN = U.fcmToken;
    console.log(`Seeded user U id=${U.id} fcmToken=${TOKEN}`);

    // ════════════ PERSISTENCE / COERCION (assertions 1-7) ════════════
    // Helper: set + verify DB and (optionally) response flag.
    async function expectPersist(id, label, body, wantBool) {
      const r = await callSet(U.id, body);
      const db = await dbEnabled(U.id);
      const ok = r.status === 200 && db === wantBool && r.body
        && r.body.notificationEnabled === wantBool;
      record(id, label,
        ok,
        `status=200 db=${wantBool} resp.notificationEnabled=${wantBool}`,
        `status=${r.status} db=${db} resp=${JSON.stringify(r.body)}`);
    }

    // 1) {enabled:false} -> DB false, resp false
    await expectPersist('1', 'body {enabled:false} -> DB false, resp false',
      { enabled: false }, false);

    // 2) {enabled:true} (boolean) -> DB true, resp true
    await expectPersist('2', 'body {enabled:true} -> DB true, resp true',
      { enabled: true }, true);

    // 3) {enabled:"false"} (string) -> DB false  (string coercion)
    await expectPersist('3', 'body {enabled:"false"} (string) -> DB false',
      { enabled: 'false' }, false);

    // 4) {enabled:"true"} (string) -> DB true
    await expectPersist('4', 'body {enabled:"true"} (string) -> DB true',
      { enabled: 'true' }, true);

    // 5) {enabled:0} -> false, {enabled:1} -> true
    {
      const r0 = await callSet(U.id, { enabled: 0 });
      const db0 = await dbEnabled(U.id);
      const r1 = await callSet(U.id, { enabled: 1 });
      const db1 = await dbEnabled(U.id);
      const ok = r0.status === 200 && db0 === false && r0.body.notificationEnabled === false
        && r1.status === 200 && db1 === true && r1.body.notificationEnabled === true;
      record('5', 'body {enabled:0} -> false ; {enabled:1} -> true',
        ok,
        'enabled0: status=200 db=false ; enabled1: status=200 db=true',
        `enabled0: status=${r0.status} db=${db0} ; enabled1: status=${r1.status} db=${db1}`);
    }

    // 6) ALTERNATE KEY notificationEnabled (no `enabled`) — the real-world failure
    {
      const rT = await callSet(U.id, { notificationEnabled: true });
      const dbT = await dbEnabled(U.id);
      const rF = await callSet(U.id, { notificationEnabled: false });
      const dbF = await dbEnabled(U.id);
      const ok = rT.status === 200 && dbT === true && rT.body.notificationEnabled === true
        && rF.status === 200 && dbF === false && rF.body.notificationEnabled === false;
      record('6', 'ALTERNATE KEY {notificationEnabled:true/false} (no `enabled`) persists',
        ok,
        'true: status=200 db=true ; false: status=200 db=false',
        `true: status=${rT.status} db=${dbT} ; false: status=${rF.status} db=${dbF}`);
    }

    // 7) garbage / neither key -> 400, DB unchanged
    {
      // Put DB in a known state first.
      await callSet(U.id, { enabled: true });
      const before = await dbEnabled(U.id);
      const rGarbage = await callSet(U.id, { enabled: 'garbage' });
      const dbAfterGarbage = await dbEnabled(U.id);
      const rEmpty = await callSet(U.id, {});
      const dbAfterEmpty = await dbEnabled(U.id);
      const ok = rGarbage.status === 400 && rEmpty.status === 400
        && dbAfterGarbage === before && dbAfterEmpty === before;
      record('7', 'garbage / neither key -> 400 and DB unchanged',
        ok,
        `garbage=400 empty=400 db stays ${before}`,
        `garbage=${rGarbage.status} empty=${rEmpty.status} dbAfterGarbage=${dbAfterGarbage} dbAfterEmpty=${dbAfterEmpty}`);
    }

    // ════════════ FULL OFF→ON→NOTIFY CYCLE (assertions 8-10) ════════════

    // 8) OFF (boolean), then notifyUser -> FCM suppressed, in-app row still saved
    {
      await callSet(U.id, { enabled: false });
      resetSpy();
      const notif = await notifyUser(U.id, 'FRIEND_REQUEST', 'x', 'y', {});
      const rowSaved = !!notif && notif.userId === U.id
        && !!(await prisma.notification.findFirst({ where: { id: notif.id } }));
      const ok = sendCallCount === 0 && rowSaved;
      record('8', 'OFF -> notifyUser: FCM NOT called (suppressed), Notification row STILL saved',
        ok,
        'sendCount=0 ; rowSaved=true',
        `sendCount=${sendCallCount} ; rowSaved=${rowSaved}`);
    }

    // 9) CORE REGRESSION PROOF: ON (boolean), then notifyUser -> FCM RESUMES
    {
      await callSet(U.id, { enabled: true });
      resetSpy();
      const notif = await notifyUser(U.id, 'FRIEND_REQUEST', 'x', 'y', {});
      const sentToU = sendCallCount === 1 && sentTokens.includes(U.fcmToken);
      const rowSaved = !!notif && notif.userId === U.id;
      const ok = sentToU && rowSaved;
      record('9', 'ON -> notifyUser: FCM RESUMED, called once with U token (core regression proof)',
        ok,
        `sendCount=1 ; token=${U.fcmToken}`,
        `sendCount=${sendCallCount} ; tokens=${JSON.stringify(sentTokens)} ; rowSaved=${rowSaved}`);
      // Stub sanity: prove the spy is genuinely the send path (no real network).
      if (!(sendCallCount > 0)) {
        record('9b', 'STUB SANITY: admin.messaging().send spy invoked (no real Firebase call)',
          false, 'sendCount>0', `sendCount=${sendCallCount}`);
      }
    }

    // 10) Same cycle but via STRING off + ALTERNATE-KEY on (proves lenient parse
    //     fixes the bug for ANY client payload shape). This is the exact shape
    //     that triggered the original silent failure.
    {
      // OFF via string "false"
      await callSet(U.id, { enabled: 'false' });
      const dbOff = await dbEnabled(U.id);
      resetSpy();
      await notifyUser(U.id, 'FRIEND_REQUEST', 'x', 'y', {});
      const suppressed = sendCallCount === 0;

      // ON via ALTERNATE KEY notificationEnabled:true (no `enabled`)
      const rOn = await callSet(U.id, { notificationEnabled: true });
      const dbOn = await dbEnabled(U.id);
      resetSpy();
      await notifyUser(U.id, 'FRIEND_REQUEST', 'x', 'y', {});
      const resumed = sendCallCount === 1 && sentTokens.includes(U.fcmToken);

      const ok = dbOff === false && suppressed
        && rOn.status === 200 && dbOn === true && resumed;
      record('10', 'string-OFF then altKey-ON: suppressed while off, RESUMES after on',
        ok,
        'off: db=false send=0 ; on(altKey): status=200 db=true send=1 to U token',
        `off: db=${dbOff} send(suppressed window)=${suppressed ? 0 : 'NONZERO'} ; on: status=${rOn.status} db=${dbOn} resumedSendCount=${sendCallCount} tokens=${JSON.stringify(sentTokens)}`);
    }
  } catch (err) {
    console.error('\nFATAL during assertions:', err);
    record('ERR', 'unexpected exception', false, 'no exception', err.message);
  } finally {
    // ── Restore FCM stub ───────────────────────────────────────────────────────
    try { messagingSingleton.send = realSend; } catch (_) {}

    // ── Cleanup: delete EXACTLY what we seeded (FK-safe) ──────────────────────
    try {
      if (created.userIds.length) {
        await prisma.notification.deleteMany({ where: { userId: { in: created.userIds } } });
        await prisma.notification.deleteMany({ where: { actorId: { in: created.userIds } } });
        await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
      }
    } catch (cleanupErr) {
      console.error('CLEANUP ERROR:', cleanupErr);
    }

    const after = {
      users: await prisma.user.count(),
      notifications: await prisma.notification.count(),
    };
    const restored = after.users === baseline.users
      && after.notifications === baseline.notifications;

    console.log('\n──────────────────────────────────────────────');
    console.log('Baseline after cleanup:', JSON.stringify(after));
    console.log(`DB baseline restored EXACTLY: ${restored ? 'YES' : 'NO'}`);
    if (!restored) {
      console.log('  diff:', JSON.stringify({
        users: after.users - baseline.users,
        notifications: after.notifications - baseline.notifications,
      }));
    }

    const pass = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;

    console.log('\n════════════ RESULTS (1-10) ════════════');
    for (const r of results) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  [${r.id}] ${r.label}`);
      if (!r.ok) {
        console.log(`        expected: ${r.expected}`);
        console.log(`        received: ${r.received}`);
      }
    }
    console.log('─────────────────────────────────────────');
    console.log('REAL   : setNotificationSetting/getNotificationSetting (controllers/userController.js)');
    console.log('         notifyUser (utils/notificationService.js) + live Prisma DB');
    console.log('STUBBED : admin.messaging().send (Firebase) — spy, no real push left the box');
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
