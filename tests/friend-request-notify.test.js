// tests/friend-request-notify.test.js
//
// Reproduce + verify the reported bug: "after turning notifications OFF then ON,
// a friend request sends no FCM."
//
// Strategy: drive the REAL controllers (sendFriendRequest, set/getNotificationSetting)
// and the REAL notifyUser against the live local DB. Stub admin.messaging().send
// to count calls + capture tokens (no real push). Seed two fresh users, run the
// six scenarios, then restore DB baseline in finally.
//
// Run:  node tests/friend-request-notify.test.js

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const admin = require('../firebaseAdmin');
const friendController = require('../controllers/friendController');
const userController = require('../controllers/userController');

// ----------------------------------------------------------------------------
// FCM stub: patch .send on the messaging() singleton. We capture every call.
// ----------------------------------------------------------------------------
const messaging = admin.messaging();
const originalSend = messaging.send.bind(messaging);
let fcmCalls = []; // [{ token, message }]
messaging.send = async (message) => {
  fcmCalls.push({ token: message?.token, message });
  return 'stub-message-id'; // pretend success, no real push
};
function resetSpy() { fcmCalls = []; }

// ----------------------------------------------------------------------------
// Minimal Express req/res mocks
// ----------------------------------------------------------------------------
function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

async function callSendFriendRequest(senderId, receiverId) {
  const req = { authData: { id: senderId }, params: { userId: String(receiverId) } };
  const res = makeRes();
  await friendController.sendFriendRequest(req, res);
  return res;
}

async function callSetNotification(userId, body) {
  const req = { authData: { id: userId }, body };
  const res = makeRes();
  await userController.setNotificationSetting(req, res);
  return res;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
const results = []; // { n, name, pass, detail }
function record(n, name, pass, detail) {
  results.push({ n, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  #${n} ${name}${detail ? ' -- ' + detail : ''}`);
}

async function deleteFriendshipBetween(a, b) {
  await prisma.friendship.deleteMany({
    where: {
      OR: [
        { requesterId: a, receiverId: b },
        { requesterId: b, receiverId: a },
      ],
    },
  });
}

async function countFriendReqNotifs(userId, sinceId) {
  return prisma.notification.count({
    where: { userId, type: 'FRIEND_REQUEST', ...(sinceId ? { id: { gt: sinceId } } : {}) },
  });
}

let A, B; // seeded users
const TAG = `test-frnotif-${Date.now()}`;

async function main() {
  // --------------------------------------------------------------------------
  // Diagnostic: does the live User table have notificationEnabled?
  // --------------------------------------------------------------------------
  let hasColumn = null;
  let columnInfo = null;
  try {
    const cols = await prisma.$queryRawUnsafe('SHOW COLUMNS FROM `User` LIKE \'notificationEnabled\'');
    hasColumn = Array.isArray(cols) && cols.length > 0;
    columnInfo = cols?.[0] || null;
  } catch (e) {
    hasColumn = `ERROR: ${e.message}`;
  }

  // --------------------------------------------------------------------------
  // Seed two fresh users with non-null fcmToken, no friendship/block
  // --------------------------------------------------------------------------
  A = await prisma.user.create({
    data: {
      username: `${TAG}-A`,
      email: `${TAG}-a@example.com`,
      password: 'x',
      firstName: 'Alice',
      lastName: 'Sender',
      fcmToken: 'fcm-token-A',
      notificationEnabled: true,
    },
  });
  B = await prisma.user.create({
    data: {
      username: `${TAG}-B`,
      email: `${TAG}-b@example.com`,
      password: 'x',
      firstName: 'Bob',
      lastName: 'Receiver',
      fcmToken: 'fcm-token-B',
      notificationEnabled: true,
    },
  });

  // ===== Scenario 1: baseline happy path =====================================
  {
    resetSpy();
    const before = await countFriendReqNotifs(B.id);
    const res = await callSendFriendRequest(A.id, B.id);
    const after = await countFriendReqNotifs(B.id);
    const ok =
      res.statusCode === 200 &&
      res.body?.message === 'Friend request sent.' &&
      fcmCalls.length === 1 &&
      fcmCalls[0].token === 'fcm-token-B' &&
      after === before + 1;
    record(1, 'Baseline happy path: 200 + FCM once w/ B token + in-app row',
      ok, `status=${res.statusCode} msg="${res.body?.message}" fcm=${fcmCalls.length} token=${fcmCalls[0]?.token} notifs ${before}->${after}`);
  }

  // ===== Scenario 2: THE GOTCHA — repeat without cleanup => 400, no FCM ======
  {
    resetSpy();
    const res = await callSendFriendRequest(A.id, B.id);
    const ok =
      res.statusCode === 400 &&
      /already sent/i.test(res.body?.error || '') &&
      fcmCalls.length === 0;
    record(2, 'Repeat w/o cleanup: 400 "already sent" + NO FCM (likely user-reported cause)',
      ok, `status=${res.statusCode} err="${res.body?.error}" fcm=${fcmCalls.length}`);
  }

  // ===== Scenario 3: toggle OFF (enabled:false) => fresh request suppressed ===
  {
    await deleteFriendshipBetween(A.id, B.id);
    const setRes = await callSetNotification(B.id, { enabled: false });
    const dbB = await prisma.user.findUnique({ where: { id: B.id }, select: { notificationEnabled: true } });
    resetSpy();
    const before = await countFriendReqNotifs(B.id);
    const res = await callSendFriendRequest(A.id, B.id);
    const after = await countFriendReqNotifs(B.id);
    const friendship = await prisma.friendship.findFirst({
      where: { requesterId: A.id, receiverId: B.id, status: 'PENDING' },
    });
    const ok =
      setRes.statusCode === 200 && dbB.notificationEnabled === false &&
      res.statusCode === 200 && !!friendship &&
      fcmCalls.length === 0 && after === before + 1;
    record(3, 'OFF {enabled:false}: friendship created, FCM suppressed, in-app saved',
      ok, `dbOff=${dbB.notificationEnabled} fcm=${fcmCalls.length} friendship=${!!friendship} notifs ${before}->${after}`);
  }

  // ===== Scenario 4: toggle ON (enabled:true) => fresh request FCM resumes ====
  {
    await deleteFriendshipBetween(A.id, B.id);
    const setRes = await callSetNotification(B.id, { enabled: true });
    const dbB = await prisma.user.findUnique({ where: { id: B.id }, select: { notificationEnabled: true } });
    resetSpy();
    const res = await callSendFriendRequest(A.id, B.id);
    const ok =
      setRes.statusCode === 200 && dbB.notificationEnabled === true &&
      res.statusCode === 200 &&
      fcmCalls.length === 1 && fcmCalls[0].token === 'fcm-token-B';
    record(4, 'ON {enabled:true} after OFF: FCM RESUMES w/ B token (CORE regression)',
      ok, `dbOn=${dbB.notificationEnabled} fcm=${fcmCalls.length} token=${fcmCalls[0]?.token}`);
  }

  // ===== Scenario 5: alternate key/string forms ==============================
  {
    // OFF with {notificationEnabled:false}
    await deleteFriendshipBetween(A.id, B.id);
    const offRes = await callSetNotification(B.id, { notificationEnabled: false });
    const dbOff = await prisma.user.findUnique({ where: { id: B.id }, select: { notificationEnabled: true } });
    resetSpy();
    const offReq = await callSendFriendRequest(A.id, B.id);
    const offFcm = fcmCalls.length;

    // ON with {enabled:"true"} (string)
    await deleteFriendshipBetween(A.id, B.id);
    const onRes = await callSetNotification(B.id, { enabled: 'true' });
    const dbOn = await prisma.user.findUnique({ where: { id: B.id }, select: { notificationEnabled: true } });
    resetSpy();
    const onReq = await callSendFriendRequest(A.id, B.id);
    const onFcm = fcmCalls.length;
    const onToken = fcmCalls[0]?.token;

    const ok =
      offRes.statusCode === 200 && dbOff.notificationEnabled === false &&
      offReq.statusCode === 200 && offFcm === 0 &&
      onRes.statusCode === 200 && dbOn.notificationEnabled === true &&
      onReq.statusCode === 200 && onFcm === 1 && onToken === 'fcm-token-B';
    record(5, 'Alt keys/strings: OFF {notificationEnabled:false} suppresses, ON {enabled:"true"} resumes',
      ok, `dbOff=${dbOff.notificationEnabled} offFcm=${offFcm} dbOn=${dbOn.notificationEnabled} onFcm=${onFcm} onToken=${onToken}`);
  }

  // ===== Scenario 6: fcmToken null edge ======================================
  {
    await deleteFriendshipBetween(A.id, B.id);
    await prisma.user.update({ where: { id: B.id }, data: { fcmToken: null, notificationEnabled: true } });
    resetSpy();
    const before = await countFriendReqNotifs(B.id);
    const res = await callSendFriendRequest(A.id, B.id);
    const after = await countFriendReqNotifs(B.id);
    const ok =
      res.statusCode === 200 &&
      fcmCalls.length === 0 &&
      after === before + 1;
    record(6, 'fcmToken=null + ON: NO FCM (no token) but in-app saved (separate cause)',
      ok, `fcm=${fcmCalls.length} notifs ${before}->${after}`);
    // restore token for cleanliness
    await prisma.user.update({ where: { id: B.id }, data: { fcmToken: 'fcm-token-B' } });
  }

  return { hasColumn, columnInfo };
}

(async () => {
  let diag = { hasColumn: null, columnInfo: null };
  let fatal = null;
  try {
    diag = await main();
  } catch (e) {
    fatal = e;
    console.error('FATAL during test run:', e);
  } finally {
    // ----- Restore baseline: delete seeded users + their friendships/notifs ---
    try {
      if (A && B) {
        await prisma.friendship.deleteMany({
          where: {
            OR: [
              { requesterId: A.id }, { receiverId: A.id },
              { requesterId: B.id }, { receiverId: B.id },
            ],
          },
        });
        await prisma.notification.deleteMany({ where: { userId: { in: [A.id, B.id] } } });
        await prisma.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
      }
      // verify cleanup
      const leftUsers = await prisma.user.count({ where: { username: { startsWith: TAG } } });
      const leftFriendships = (A && B)
        ? await prisma.friendship.count({ where: { OR: [{ requesterId: A.id }, { receiverId: A.id }, { requesterId: B.id }, { receiverId: B.id }] } })
        : 0;
      console.log(`\nCLEANUP: seeded users remaining=${leftUsers}, residual friendships=${leftFriendships} (expect 0/0)`);
    } catch (e) {
      console.error('CLEANUP ERROR:', e);
    }
    // restore FCM stub
    messaging.send = originalSend;

    // ----- Summary table -----
    console.log('\n==== RESULT TABLE ====');
    console.log('#  PASS  SCENARIO');
    for (const r of results) {
      console.log(`${r.n}  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
    }
    const allPass = results.length === 6 && results.every(r => r.pass);
    console.log(`\nOVERALL: ${allPass ? 'ALL PASS' : 'SOME FAILED'} (${results.filter(r => r.pass).length}/6)`);

    console.log('\n==== DIAGNOSTIC ====');
    console.log(`User.notificationEnabled column present in LIVE DB: ${diag.hasColumn}`);
    if (diag.columnInfo) console.log(`  column def: ${JSON.stringify(diag.columnInfo)}`);

    await prisma.$disconnect();
    process.exit(fatal || !allPass ? 1 : 0);
  }
})();
