/**
 * Item 10 — ban notification (community + group, ban + unban).
 *
 *   • banMember (community): creates Notification row with type=COMMUNITY_BANNED,
 *     title includes community name, description includes reason; sends FCM push
 *     to the banned user; flips notificationRedDot=true; respects per-user
 *     notificationEnabled toggle (FCM is skipped when off, in-app record stays)
 *   • unbanMember: type=COMMUNITY_UNBANNED, reinstatement copy
 *   • banGroupMember: type=GROUP_BANNED, same flow with chatId
 *   • unbanGroupMember: type=GROUP_UNBANNED
 *
 * Stubs Prisma + firebase-admin + utils/socket so the test runs without I/O.
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// Stub firebase-admin before notifyUser pulls it in.
const fbPath = require.resolve('../firebaseAdmin');
const fcmSent = [];
require.cache[fbPath] = {
  id: fbPath, filename: fbPath, loaded: true,
  exports: { messaging: () => ({ send: async (msg) => { fcmSent.push(msg); return 'fcm-id'; } }) },
};

// Stub socket.getIO — record emits
const socketPath = require.resolve('../utils/socket');
const socketEmits = [];
require.cache[socketPath] = {
  id: socketPath, filename: socketPath, loaded: true,
  exports: {
    getIO: () => ({ to: (room) => ({ emit: (event, payload) => socketEmits.push({ room, event, payload }) }) }),
    deleteOwnMessages: async () => [],
  },
};

// Stub realtime
const realtimePath = require.resolve('../utils/realtime');
const rtEmits = [];
require.cache[realtimePath] = {
  id: realtimePath, filename: realtimePath, loaded: true,
  exports: {
    toUser: (uid, ev, p) => rtEmits.push({ kind: 'user', uid, ev, p }),
    toUsers: () => {},
    toGroup: (cid, ev, p) => rtEmits.push({ kind: 'group', cid, ev, p }),
    toCommunity: (cid, ev, p) => rtEmits.push({ kind: 'community', cid, ev, p }),
    toFriends: () => {},
  },
};

// Stub Prisma — minimal shape across all calls in the ban handlers + notifyUser
const prismaClientPath = require.resolve('@prisma/client');
const db = {
  communities: new Map([[10, { id: 10, creatorId: 42, name: 'Brooklyn Devs' }]]),
  members: [
    { id: 1, userId: 99, communityId: 10 },
  ],
  chats: new Map([[50, {
    id: 50, isGroup: true, name: 'Friday Squad',
    users: [
      { userId: 42, role: 'ADMIN' },
      { userId: 99, role: 'MEMBER' },
    ],
  }]]),
  histories: [],
  cbans: [],
  chatBans: [],
  notifications: [],
  users: new Map([
    [42, { id: 42, notificationEnabled: true, fcmToken: null, notificationRedDot: false }],
    [99, { id: 99, notificationEnabled: true, fcmToken: 'fcm-token-99', notificationRedDot: false }],
  ]),
};
const fakePrisma = {
  community: {
    findUnique: async ({ where, select }) => {
      const c = db.communities.get(where.id);
      if (!c) return null;
      if (!select) return c;
      const out = {};
      for (const k of Object.keys(select)) if (select[k]) out[k] = c[k];
      return out;
    },
  },
  communityMember: {
    findFirst: async ({ where }) => db.members.find(m => m.userId === where.userId && m.communityId === where.communityId) || null,
    delete:    async ({ where }) => { db.members = db.members.filter(m => m.id !== where.id); },
    create:    async ({ data }) => { db.members.push({ id: db.members.length + 1, ...data }); },
  },
  userOnChat: {
    findFirst: async () => null,
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
  },
  communityHistory: {
    create: async ({ data }) => { db.histories.push(data); return {}; },
  },
  communityBan: {
    findFirst: async ({ where }) => db.cbans.find(b => b.communityId === where.communityId && b.userId === where.userId) || null,
    upsert: async ({ where, update, create }) => {
      const found = db.cbans.find(b => b.communityId === where.communityId_userId.communityId && b.userId === where.communityId_userId.userId);
      if (found) Object.assign(found, update);
      else db.cbans.push({ id: db.cbans.length + 1, ...create });
    },
    deleteMany: async ({ where }) => {
      const before = db.cbans.length;
      db.cbans = db.cbans.filter(b => !(b.communityId === where.communityId && b.userId === where.userId));
      return { count: before - db.cbans.length };
    },
  },
  chat: {
    findUnique: async ({ where, select, include }) => {
      const c = db.chats.get(where.id);
      if (!c) return null;
      if (!select && !include) return c;
      // Both 'select' and 'include' shapes — return the whole row, JSON-stringified-cloned.
      return JSON.parse(JSON.stringify(c));
    },
  },
  chatBan: {
    upsert: async ({ where, update, create }) => {
      const found = db.chatBans.find(b => b.chatId === where.chatId_userId.chatId && b.userId === where.chatId_userId.userId);
      if (found) Object.assign(found, update);
      else db.chatBans.push({ id: db.chatBans.length + 1, ...create });
    },
    deleteMany: async ({ where }) => {
      const before = db.chatBans.length;
      db.chatBans = db.chatBans.filter(b => !(b.chatId === where.chatId && b.userId === where.userId));
      return { count: before - db.chatBans.length };
    },
  },
  notification: {
    create: async ({ data }) => {
      const row = { id: db.notifications.length + 1, createdAt: new Date(), isRead: false, ...data };
      db.notifications.push(row);
      return row;
    },
  },
  user: {
    update: async ({ where, data }) => {
      const u = db.users.get(where.id);
      if (u) Object.assign(u, data);
      return u;
    },
    findUnique: async ({ where }) => db.users.get(where.id) || null,
  },
  $transaction: async (ops) => Promise.all(ops),
};
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

const community = require('../controllers/communityController');
const chat      = require('../controllers/chatController');

function req({ id, params, body }) { return { authData: { id }, params: params || {}, body: body || {} }; }
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // ---------- 1. Community ban — record + FCM + dot + socket ----------
  console.log('\n[1] banMember — Notification row + FCM + red-dot + socket');

  db.notifications = []; fcmSent.length = 0; socketEmits.length = 0; rtEmits.length = 0;
  db.cbans = []; db.members = [{ id: 1, userId: 99, communityId: 10 }];
  db.users.get(99).notificationRedDot = false;

  const r1 = res();
  await community.banMember(req({
    id: 42, params: { communityId: '10', userId: '99' },
    body: { reason: 'spam' },
  }), r1);
  eq('ban 200',                         r1.statusCode, 200);
  eq('1 notification row',              db.notifications.length, 1);
  eq('type=COMMUNITY_BANNED',           db.notifications[0]?.type, 'COMMUNITY_BANNED');
  eq('title includes community name',   db.notifications[0]?.title, 'Removed from Brooklyn Devs');
  ok('description has reason',          /Reason: spam/.test(db.notifications[0]?.description));
  eq('userId = banned user',            db.notifications[0]?.userId, 99);
  eq('actorId = admin',                 db.notifications[0]?.actorId, 42);
  eq('communityId in data',             db.notifications[0]?.data?.communityId, 10);
  eq('reason in data',                  db.notifications[0]?.data?.reason, 'spam');
  eq('red-dot flipped',                 db.users.get(99).notificationRedDot, true);
  // FCM sent (user has token + notificationEnabled true)
  eq('1 FCM sent',                      fcmSent.length, 1);
  eq('FCM token',                       fcmSent[0]?.token, 'fcm-token-99');
  eq('FCM title',                       fcmSent[0]?.notification?.title, 'Removed from Brooklyn Devs');
  eq('FCM data.type',                   fcmSent[0]?.data?.type, 'COMMUNITY_BANNED');
  eq('FCM data.communityId',            fcmSent[0]?.data?.communityId, '10');
  // Per-user socket emit (notifyUser fires 'notification' to user:99)
  ok("socket 'notification' to user:99", socketEmits.some(e => e.event === 'notification' && e.room === 'user:99'));

  // ---------- 2. FCM toggle OFF → no push but record + socket still fire ----------
  console.log('\n[2] notificationEnabled=false → FCM skipped, in-app stays');

  db.notifications = []; fcmSent.length = 0; socketEmits.length = 0;
  db.cbans = []; db.members = [{ id: 1, userId: 99, communityId: 10 }];
  db.users.get(99).notificationEnabled = false;
  db.users.get(99).notificationRedDot = false;

  const r2 = res();
  await community.banMember(req({ id: 42, params: { communityId: '10', userId: '99' }, body: {} }), r2);
  eq('ban 200',                          r2.statusCode, 200);
  eq('record still created',             db.notifications.length, 1);
  eq('red-dot still set',                db.users.get(99).notificationRedDot, true);
  eq('NO FCM sent',                      fcmSent.length, 0);
  ok("socket 'notification' still fires", socketEmits.some(e => e.event === 'notification' && e.room === 'user:99'));
  // restore for next tests
  db.users.get(99).notificationEnabled = true;

  // ---------- 3. Community unban — reinstatement record + push ----------
  console.log('\n[3] unbanMember — COMMUNITY_UNBANNED row + reinstatement push');

  db.notifications = []; fcmSent.length = 0;
  db.cbans = [{ id: 1, communityId: 10, userId: 99, bannedById: 42, reason: null }];

  const r3 = res();
  await community.unbanMember(req({ id: 42, params: { communityId: '10', userId: '99' } }), r3);
  eq('unban 200',                       r3.statusCode, 200);
  eq('1 notification row',              db.notifications.length, 1);
  eq('type=COMMUNITY_UNBANNED',         db.notifications[0]?.type, 'COMMUNITY_UNBANNED');
  ok('reinstatement title',             /Reinstated to Brooklyn Devs/.test(db.notifications[0]?.title));
  eq('FCM sent',                        fcmSent.length, 1);
  eq('FCM data.type',                   fcmSent[0]?.data?.type, 'COMMUNITY_UNBANNED');

  // ---------- 4. Group ban ----------
  console.log('\n[4] banGroupMember — GROUP_BANNED row + push + chatId');

  db.notifications = []; fcmSent.length = 0; socketEmits.length = 0;
  db.chatBans = [];
  // Reset chat 50 users (the ban removed them in test 1's chat — wait, that was community 10)
  db.chats.set(50, {
    id: 50, isGroup: true, name: 'Friday Squad',
    users: [{ userId: 42, role: 'ADMIN' }, { userId: 99, role: 'MEMBER' }],
  });

  const r4 = res();
  await chat.banGroupMember(req({ id: 42, params: { chatId: '50', userId: '99' }, body: { reason: 'noise' } }), r4);
  eq('group ban 200',                   r4.statusCode, 200);
  eq('1 notification row',              db.notifications.length, 1);
  eq('type=GROUP_BANNED',               db.notifications[0]?.type, 'GROUP_BANNED');
  ok('title includes group name',       /Removed from Friday Squad/.test(db.notifications[0]?.title));
  ok('description has reason',          /Reason: noise/.test(db.notifications[0]?.description));
  eq('chatId in data',                  db.notifications[0]?.data?.chatId, 50);
  eq('actorId',                         db.notifications[0]?.actorId, 42);
  eq('FCM sent',                        fcmSent.length, 1);
  eq('FCM data.type',                   fcmSent[0]?.data?.type, 'GROUP_BANNED');
  eq('FCM data.chatId',                 fcmSent[0]?.data?.chatId, '50');

  // ---------- 5. Group unban ----------
  console.log('\n[5] unbanGroupMember — GROUP_UNBANNED row + push');

  db.notifications = []; fcmSent.length = 0;
  db.chatBans = [{ id: 1, chatId: 50, userId: 99, bannedById: 42, reason: null }];
  // Re-add admin (banned them above)
  db.chats.set(50, {
    id: 50, isGroup: true, name: 'Friday Squad',
    users: [{ userId: 42, role: 'ADMIN' }],
  });

  const r5 = res();
  await chat.unbanGroupMember(req({ id: 42, params: { chatId: '50', userId: '99' } }), r5);
  eq('unban 200',                       r5.statusCode, 200);
  eq('1 notification row',              db.notifications.length, 1);
  eq('type=GROUP_UNBANNED',             db.notifications[0]?.type, 'GROUP_UNBANNED');
  ok('reinstatement title',             /Reinstated to Friday Squad/.test(db.notifications[0]?.title));
  eq('FCM sent',                        fcmSent.length, 1);

  // ---------- 6. notify failure must NOT block the ban itself ----------
  console.log('\n[6] notifyUser throw does not break the ban (notify is best-effort)');

  // Replace user.findUnique to make notifyUser throw on the user lookup
  const realFindUnique = fakePrisma.user.findUnique;
  fakePrisma.user.findUnique = async () => { throw new Error('simulated user lookup failure'); };
  db.notifications = []; fcmSent.length = 0;
  db.cbans = [];
  db.members = [{ id: 1, userId: 99, communityId: 10 }];

  const r6 = res();
  await community.banMember(req({ id: 42, params: { communityId: '10', userId: '99' }, body: {} }), r6);
  eq('ban still returns 200',           r6.statusCode, 200);
  eq('ban row still inserted',          db.cbans.length, 1);
  fakePrisma.user.findUnique = realFindUnique;

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
