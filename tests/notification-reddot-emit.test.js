/**
 * Notification red-dot + socket emit test.
 *
 * Verifies:
 *   1. notifyUser() creates the DB notification row
 *   2. notifyUser() sets User.notificationRedDot = true (closed-app survives)
 *   3. notifyUser() emits 'notification' to room user:<userId> via socket.io
 *   4. Emit failure does NOT block DB persist
 *   5. getNotificationRedDot returns the DB value
 *   6. resetNotificationRedDot flips it to false
 *
 * Stubs Prisma + firebase-admin + utils/socket.getIO.
 */

const path = require('path');

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, got, want) { assert(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// ---- Stub firebase-admin BEFORE the service requires it ----
const fbPath = require.resolve('../firebaseAdmin');
require.cache[fbPath] = {
  id: fbPath, filename: fbPath, loaded: true,
  exports: { messaging: () => ({ send: async () => 'msg-id-stub' }) },
};

// ---- Stub PrismaClient ----
const prismaClientPath = require.resolve('@prisma/client');
const mockDb = {
  notifications: [],
  users: new Map([[42, { id: 42, fcmToken: null, notificationEnabled: true, notificationRedDot: false }]]),
};
const fakePrisma = {
  notification: {
    create: async ({ data }) => {
      const row = { id: mockDb.notifications.length + 1, createdAt: new Date(), ...data };
      mockDb.notifications.push(row);
      return row;
    },
  },
  user: {
    update: async ({ where, data }) => {
      const u = mockDb.users.get(where.id);
      Object.assign(u, data);
      return u;
    },
    findUnique: async ({ where }) => mockDb.users.get(where.id) || null,
  },
};
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// ---- Stub utils/socket.getIO with a recorder ----
const socketPath = require.resolve('../utils/socket');
let emitRecord = [];
let ioBroken = false;
require.cache[socketPath] = {
  id: socketPath, filename: socketPath, loaded: true,
  exports: {
    getIO: () => {
      if (ioBroken) throw new Error('io not initialized');
      return {
        to: (room) => ({
          emit: (event, payload) => emitRecord.push({ room, event, payload }),
        }),
      };
    },
  },
};

// Now load the service.
const { notifyUser } = require('../utils/notificationService');
const notifCtrl = require('../controllers/notificationController');

function makeReq(userId) { return { authData: { id: userId } }; }
function makeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  console.log('\n[1] notifyUser — DB persist + dot + socket emit');

  emitRecord = [];
  const notif = await notifyUser(42, 'FRIEND_REQUEST', 'New friend request', 'X sent you a friend request', { actorId: 99 });

  eq('notification row inserted',           mockDb.notifications.length, 1);
  eq('notification.type stored',            mockDb.notifications[0].type, 'FRIEND_REQUEST');
  eq('notification.actorId stored',         mockDb.notifications[0].actorId, 99);
  eq('User.notificationRedDot = true',      mockDb.users.get(42).notificationRedDot, true);

  eq('socket emit recorded once',           emitRecord.length, 1);
  eq('socket emit room = user:42',          emitRecord[0]?.room, 'user:42');
  eq("socket emit event = 'notification'",  emitRecord[0]?.event, 'notification');
  assert("socket emit payload.hasUnread = true", emitRecord[0]?.payload?.hasUnread === true);

  // Return value
  eq('notifyUser returns the notification row', notif?.id, 1);

  // ---------- 2. Closed-app: socket emit fails, persist still happens ----------
  console.log('\n[2] Socket emit failure does NOT block persist');

  ioBroken = true;
  emitRecord = [];
  mockDb.users.get(42).notificationRedDot = false;

  await notifyUser(42, 'NEW_CHALLENGE', 'Hello', 'Body');

  eq('DB row inserted even when socket broken', mockDb.notifications.length, 2);
  eq('Dot set true even when socket broken',    mockDb.users.get(42).notificationRedDot, true);
  eq('No emit recorded (io was broken)',        emitRecord.length, 0);
  ioBroken = false;

  // ---------- 3. GET red-dot returns DB value ----------
  console.log('\n[3] GET /notifications/red-dot returns DB state');

  // Use the same prisma instance the controller already loaded — controller
  // grabs prisma at require time, so we need to ensure they share state.
  // (Since we stubbed the prismaClientPath before any require, controller's
  // PrismaClient() should be the same fakePrisma. But controller calls
  // prisma.user.findUnique with select, which our stub doesn't implement
  // — adapt the stub.)
  fakePrisma.user.findUnique = async ({ where, select }) => {
    const u = mockDb.users.get(where.id);
    if (!u) return null;
    if (!select) return u;
    const out = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = u[k];
    return out;
  };

  mockDb.users.get(42).notificationRedDot = true;
  const r1 = makeRes();
  await notifCtrl.getNotificationRedDot(makeReq(42), r1);
  eq('GET red-dot returns success',      r1.body?.success, true);
  eq('GET red-dot returns true value',   r1.body?.notificationRedDot, true);

  // ---------- 4. Reset endpoint flips to false ----------
  console.log('\n[4] POST /notifications/reset-red-dot flips dot off');

  const r2 = makeRes();
  await notifCtrl.resetNotificationRedDot(makeReq(42), r2);
  eq('Dot reset to false in DB',         mockDb.users.get(42).notificationRedDot, false);
  eq('Reset returns success',            r2.body?.success, true);

  const r3 = makeRes();
  await notifCtrl.getNotificationRedDot(makeReq(42), r3);
  eq('GET red-dot now returns false',    r3.body?.notificationRedDot, false);

  // ---------- 5. Next notify after reset re-arms the dot ----------
  console.log('\n[5] Next notification re-arms dot');

  emitRecord = [];
  await notifyUser(42, 'CHALLENGE_REMINDER', 'Ping', 'Body');
  eq('Dot re-armed to true',             mockDb.users.get(42).notificationRedDot, true);
  eq('New emit fired',                   emitRecord.length, 1);
  eq('New emit payload hasUnread=true',  emitRecord[0]?.payload?.hasUnread, true);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch(err => {
  console.error('TEST CRASH', err);
  process.exit(1);
});
