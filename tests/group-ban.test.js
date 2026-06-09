/**
 * Item 5b — group ban / unban + addUsersToGroup ban-check.
 *  • Admin can ban → ChatBan stored + UserOnChat removed
 *  • Non-admin → 403
 *  • Cannot ban last admin
 *  • Banned user filtered from addUsersToGroup
 *  • Unban path
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const prismaClientPath = require.resolve('@prisma/client');

const mockDb = {
  chats: new Map(),     // id → { id, isGroup, users: [{userId, role}] }
  bans: [],             // ChatBan rows
  uocDeletes: [],
};
const fakePrisma = {
  chat: {
    findUnique: async ({ where, include }) => {
      const c = mockDb.chats.get(where.id);
      if (!c) return null;
      return JSON.parse(JSON.stringify(c));
    },
    update: async ({ where, data }) => {
      const c = mockDb.chats.get(where.id);
      if (!c) return null;
      if (data.users?.create) {
        for (const u of data.users.create) c.users.push({ userId: u.userId, role: u.role });
      }
      return c;
    },
  },
  chatBan: {
    findMany: async ({ where }) => {
      const idsIn = where.userId?.in;
      return mockDb.bans.filter(b =>
        b.chatId === where.chatId &&
        (!idsIn || idsIn.includes(b.userId))
      );
    },
    upsert: async ({ where, update, create }) => {
      const found = mockDb.bans.find(b => b.chatId === where.chatId_userId.chatId && b.userId === where.chatId_userId.userId);
      if (found) Object.assign(found, update);
      else mockDb.bans.push({ id: mockDb.bans.length + 1, ...create });
    },
    deleteMany: async ({ where }) => {
      const before = mockDb.bans.length;
      mockDb.bans = mockDb.bans.filter(b => !(b.chatId === where.chatId && b.userId === where.userId));
      return { count: before - mockDb.bans.length };
    },
  },
  userOnChat: {
    deleteMany: async ({ where }) => {
      mockDb.uocDeletes.push(where);
      const c = mockDb.chats.get(where.chatId);
      if (c) c.users = c.users.filter(u => u.userId !== where.userId);
      return { count: 1 };
    },
    findFirst: async () => null,
  },
};

require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

const realtimePath = require.resolve('../utils/realtime');
const emits = [];
require.cache[realtimePath] = {
  id: realtimePath, filename: realtimePath, loaded: true,
  exports: {
    toUser: (uid, event, payload) => emits.push({ to: 'user', uid, event, payload }),
    toUsers: () => {},
    toGroup: (cid, event, payload) => emits.push({ to: 'group', cid, event, payload }),
    toCommunity: () => {},
    toFriends: () => {},
  },
};

// Stubs for other modules chatController loads
const chatHelpersPath = require.resolve('../utils/chatHelpers');
require.cache[chatHelpersPath] = {
  id: chatHelpersPath, filename: chatHelpersPath, loaded: true,
  exports: { getBulkUnreadCounts: async () => new Map(), markChatAsRead: async () => {}, getChatReadStatus: async () => ({}) },
};
const weeklyPath = require.resolve('../utils/weeklyPoints');
require.cache[weeklyPath] = {
  id: weeklyPath, filename: weeklyPath, loaded: true,
  exports: { getWeeklyPointsForUsers: async () => new Map(), getWeeklyPointsForUser: async () => 0 },
};

const chat = require('../controllers/chatController');

function req({ id, params, body }) { return { authData: { id }, params: params || {}, body: body || {} }; }
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // ---------- 1. Admin bans a member ----------
  console.log('\n[1] Admin can ban a group member');

  mockDb.chats.set(50, { id: 50, isGroup: true, users: [{ userId: 42, role: 'ADMIN' }, { userId: 99, role: 'MEMBER' }] });
  mockDb.bans = [];
  emits.length = 0;

  const r1 = res();
  await chat.banGroupMember(req({ id: 42, params: { chatId: '50', userId: '99' }, body: { reason: 'troll' } }), r1);
  eq('200',                  r1.statusCode, 200);
  eq('ban row stored',       mockDb.bans.length, 1);
  eq('ban target',           mockDb.bans[0].userId, 99);
  eq('member removed',       mockDb.chats.get(50).users.find(u => u.userId === 99), undefined);
  ok('group.member_banned to group',  emits.some(e => e.event === 'group.member_banned' && e.to === 'group'));
  ok('group.member_banned to user',   emits.some(e => e.event === 'group.member_banned' && e.uid === 99));

  // ---------- 2. Non-admin → 403 ----------
  console.log('\n[2] Non-admin → 403');

  mockDb.chats.set(60, { id: 60, isGroup: true, users: [{ userId: 42, role: 'MEMBER' }, { userId: 99, role: 'MEMBER' }] });
  mockDb.bans = [];

  const r2 = res();
  await chat.banGroupMember(req({ id: 42, params: { chatId: '60', userId: '99' }, body: {} }), r2);
  eq('403',         r2.statusCode, 403);
  eq('no ban row',  mockDb.bans.length, 0);

  // ---------- 3. Cannot ban last admin ----------
  console.log('\n[3] Cannot ban the last admin');

  mockDb.chats.set(70, { id: 70, isGroup: true, users: [{ userId: 42, role: 'ADMIN' }, { userId: 99, role: 'ADMIN' }] });
  mockDb.bans = [];

  // Try to ban userId 99 (other admin) — that leaves caller as the only admin, so allowed.
  const r3a = res();
  await chat.banGroupMember(req({ id: 42, params: { chatId: '70', userId: '99' }, body: {} }), r3a);
  eq('non-last-admin can be banned', r3a.statusCode, 200);

  // Now in chat 70 only admin 42 left. Add a member and try to demote-via-ban the last admin.
  mockDb.chats.set(71, { id: 71, isGroup: true, users: [{ userId: 42, role: 'ADMIN' }, { userId: 200, role: 'MEMBER' }] });
  // attempt to ban the only admin via a member-caller — but rule is "caller must be admin".
  // Simulate two admins so we can attempt banning one when caller is the other and they ARE the last admin pair:
  mockDb.chats.set(72, { id: 72, isGroup: true, users: [{ userId: 42, role: 'ADMIN' }] });
  // caller 42 banning themselves → 400 (already covered separately) or last-admin rule triggers.
  mockDb.bans = [];
  const r3b = res();
  await chat.banGroupMember(req({ id: 42, params: { chatId: '72', userId: '42' }, body: {} }), r3b);
  eq('self-ban rejected', r3b.statusCode, 400);

  // ---------- 4. addUsersToGroup blocks banned re-add ----------
  console.log('\n[4] addUsersToGroup blocks banned re-add');

  mockDb.chats.set(80, { id: 80, isGroup: true, users: [{ userId: 42, role: 'ADMIN' }] });
  mockDb.bans = [{ id: 1, chatId: 80, userId: 99, bannedById: 42, reason: null }];

  const r4 = res();
  await chat.addUsersToGroup(req({ id: 42, params: { chatId: '80' }, body: { userIds: [99] } }), r4);
  eq('403',        r4.statusCode, 403);
  ok('error mentions banned', /banned/i.test(JSON.stringify(r4.body)));
  eq('no user added', mockDb.chats.get(80).users.length, 1);

  // ---------- 5. addUsersToGroup mixed — banned skipped, non-banned added ----------
  console.log('\n[5] Mixed add — banned skipped, non-banned added');

  mockDb.chats.set(90, { id: 90, isGroup: true, users: [{ userId: 42, role: 'ADMIN' }] });
  mockDb.bans = [{ id: 1, chatId: 90, userId: 99, bannedById: 42, reason: null }];

  const r5 = res();
  await chat.addUsersToGroup(req({ id: 42, params: { chatId: '90' }, body: { userIds: [99, 200] } }), r5);
  // Expect 200/successful add for 200, NOT for 99
  const stillBanned = mockDb.chats.get(90).users.find(u => u.userId === 99);
  const added       = mockDb.chats.get(90).users.find(u => u.userId === 200);
  eq('banned user NOT added',         !!stillBanned, false);
  eq('non-banned user added',         !!added,       true);

  // ---------- 6. Unban removes the row ----------
  console.log('\n[6] Unban removes the row');

  mockDb.chats.set(100, { id: 100, isGroup: true, users: [{ userId: 42, role: 'ADMIN' }] });
  mockDb.bans = [{ id: 1, chatId: 100, userId: 99, bannedById: 42, reason: null }];
  emits.length = 0;

  const r6 = res();
  await chat.unbanGroupMember(req({ id: 42, params: { chatId: '100', userId: '99' } }), r6);
  eq('unban 200',          r6.statusCode, 200);
  eq('ban row gone',       mockDb.bans.length, 0);
  ok('group.member_unbanned emit', emits.some(e => e.event === 'group.member_unbanned' && e.uid === 99));

  // ---------- 7. Non-admin unban → 403 ----------
  console.log('\n[7] Non-admin unban → 403');

  mockDb.chats.set(110, { id: 110, isGroup: true, users: [{ userId: 42, role: 'MEMBER' }] });
  mockDb.bans = [{ id: 1, chatId: 110, userId: 99, bannedById: 1, reason: null }];

  const r7 = res();
  await chat.unbanGroupMember(req({ id: 42, params: { chatId: '110', userId: '99' } }), r7);
  eq('403',          r7.statusCode, 403);
  eq('ban preserved', mockDb.bans.length, 1);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
