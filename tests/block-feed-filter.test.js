/**
 * Block-aware feed filtering — item 4.
 *
 * Two surfaces tested:
 *   (a) getMessages / getMessagesPaginated — load-time filter via prisma where
 *   (b) getMyChats / getMyGroupChats / getUnreadChats latestMessage preview —
 *       scrub blocked-sender content / imageUrl on the way out
 *
 * The socket newMessage fan-out is harder to unit-test without a live
 * socket.io instance and is exercised manually + via integration test later.
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// ---- Stub PrismaClient before requiring the controller ----
const prismaClientPath = require.resolve('@prisma/client');

let mockMessages = [];
let mockChats = [];
let mockBlocks = [];
let lastFindManyWhere = null;

const fakePrisma = {
  message: {
    findMany: async ({ where }) => {
      lastFindManyWhere = where;
      // Apply the same constraints in JS for return value
      let rows = mockMessages.filter((m) => m.chatId === where.chatId);
      if (where.id?.gt !== undefined) rows = rows.filter((m) => m.id > where.id.gt);
      if (where.senderId?.notIn) {
        rows = rows.filter((m) => !where.senderId.notIn.includes(m.senderId));
      }
      return rows.map((m) => ({
        ...m,
        sender: { id: m.senderId, username: `u${m.senderId}`, firstName: `User${m.senderId}`, lastName: '', minime: [] },
        chat: { users: [] },
      }));
    },
  },
  userOnChat: {
    findFirst: async ({ where }) => ({ clearedUpToMessageId: 0 }),
  },
  block: {
    findMany: async ({ where }) => {
      // Mock query: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] }
      const viewerId = where.OR[0].blockerId;
      return mockBlocks.filter((b) => b.blockerId === viewerId || b.blockedId === viewerId);
    },
  },
  chat: {
    findMany: async () => mockChats,
  },
  pointsLedger: { findMany: async () => [], groupBy: async () => [] },
  user: { findMany: async () => [] },
};

require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// Stub helpers chatController loads
const chatHelpersPath = require.resolve('../utils/chatHelpers');
require.cache[chatHelpersPath] = {
  id: chatHelpersPath, filename: chatHelpersPath, loaded: true,
  exports: {
    getBulkUnreadCounts: async () => new Map(),
    markChatAsRead: async () => {},
    getChatReadStatus: async () => ({}),
  },
};
const weeklyPath = require.resolve('../utils/weeklyPoints');
require.cache[weeklyPath] = {
  id: weeklyPath, filename: weeklyPath, loaded: true,
  exports: {
    getWeeklyPointsForUsers: async () => new Map(),
    getWeeklyPointsForUser: async () => 0,
  },
};

const chat = require('../controllers/chatController');

function req({ id, params, query }) { return { authData: { id }, params: params || {}, query: query || {} }; }
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // ---------- 1. getMessages filters blocked-sender ----------
  console.log('\n[1] getMessages — blocked sender filtered via prisma where');

  mockMessages = [
    { id: 1, chatId: 7, senderId: 100, content: 'hi from 100',  imageUrl: null, isSystem: false, expiresAt: null, createdAt: new Date() },
    { id: 2, chatId: 7, senderId: 200, content: 'hi from 200',  imageUrl: null, isSystem: false, expiresAt: null, createdAt: new Date() },
    { id: 3, chatId: 7, senderId: 100, content: 'hi from 100b', imageUrl: null, isSystem: false, expiresAt: null, createdAt: new Date() },
  ];
  mockBlocks = [{ blockerId: 42, blockedId: 100 }];

  const r1 = res();
  await chat.getMessages(req({ id: 42, params: { chatId: '7' } }), r1);
  const ids = (r1.body || []).map((m) => m.id);
  eq('only msg from non-blocked sender returned', ids, [2]);
  ok('where included senderId.notIn', !!lastFindManyWhere?.senderId?.notIn?.includes(100));

  // ---------- 2. Reverse-block (they blocked me) — filtered too ----------
  console.log('\n[2] Reverse-direction block also filtered');

  mockBlocks = [{ blockerId: 100, blockedId: 42 }]; // 100 blocked me
  const r2 = res();
  await chat.getMessages(req({ id: 42, params: { chatId: '7' } }), r2);
  eq('blocker-of-me messages filtered', (r2.body || []).map((m) => m.id), [2]);

  // ---------- 3. No blocks → no filter (existing behavior unchanged) ----------
  console.log('\n[3] No blocks → senderId filter not applied');

  mockBlocks = [];
  lastFindManyWhere = null;
  const r3 = res();
  await chat.getMessages(req({ id: 42, params: { chatId: '7' } }), r3);
  ok('senderId filter absent when no blocks', !lastFindManyWhere?.senderId);
  eq('all messages returned', (r3.body || []).length, 3);

  // ---------- 4. getMessagesPaginated mirrors behavior ----------
  console.log('\n[4] getMessagesPaginated also filters');

  mockBlocks = [{ blockerId: 42, blockedId: 100 }];
  const r4 = res();
  await chat.getMessagesPaginated(req({ id: 42, params: { chatId: '7' }, query: { page: '1', limit: '20' } }), r4);
  eq('paginated also filters', (r4.body || []).every((m) => m.sender.id !== 100), true);

  // ---------- 5. getMyChats preview scrubbed when last msg from blocked ----------
  console.log('\n[5] getMyChats latestMessage preview scrubbed for blocked sender');

  mockChats = [
    {
      id: 50, name: null, isGroup: false, isCommunity: false, isLocked: false,
      communityId: null, imageUrl: null, disappearingSeconds: null,
      updatedAt: new Date(), createdAt: new Date(), createdById: 42,
      users: [
        { userId: 42,  role: 'MEMBER', joinedAt: new Date(0), isMuted: false, lastSeenMessageId: null, lastDeliveredMessageId: null, clearedUpToMessageId: 0,
          user: { id: 42,  username: 'me',  firstName: 'Me',  lastName: '', totalPoints: 0, minime: [] } },
        { userId: 100, role: 'MEMBER', joinedAt: new Date(0), isMuted: false, lastSeenMessageId: null, lastDeliveredMessageId: null, clearedUpToMessageId: 0,
          user: { id: 100, username: 'blk', firstName: 'Blk', lastName: '', totalPoints: 0, minime: [] } },
      ],
      messages: [{ id: 999, content: 'dirty content', imageUrl: 's3://bad.jpg', createdAt: new Date(), senderId: 100 }],
      _count: { messages: 1 },
    },
  ];
  mockBlocks = [{ blockerId: 42, blockedId: 100 }];

  const r5 = res();
  await chat.getMyChats(req({ id: 42 }), r5);
  const chat50 = (r5.body || []).find((c) => c.id === 50);
  ok('chat 50 returned',                     !!chat50);
  eq('preview content scrubbed',             chat50?.latestMessage?.content, '[blocked]');
  eq('preview imageUrl scrubbed',            chat50?.latestMessage?.imageUrl, null);
  eq('preview senderId preserved',           chat50?.latestMessage?.senderId, 100);

  // ---------- 6. getMyChats preview unchanged for non-blocked sender ----------
  console.log('\n[6] getMyChats unchanged when sender not blocked');

  mockBlocks = [];
  const r6 = res();
  await chat.getMyChats(req({ id: 42 }), r6);
  const chat6 = (r6.body || []).find((c) => c.id === 50);
  eq('content preserved', chat6?.latestMessage?.content, 'dirty content');
  eq('imageUrl preserved', chat6?.latestMessage?.imageUrl, 's3://bad.jpg');

  // ---------- 7. getMyGroupChats also scrubs ----------
  console.log('\n[7] getMyGroupChats preview scrubbed for blocked sender');

  mockChats = [
    {
      id: 80, name: 'Group A', isGroup: true, isCommunity: false, isLocked: false,
      communityId: null, imageUrl: null, disappearingSeconds: null,
      updatedAt: new Date(), createdAt: new Date(), createdById: 42,
      users: [
        { userId: 42,  role: 'MEMBER', joinedAt: new Date(0), isMuted: false, lastSeenMessageId: null, lastDeliveredMessageId: null, clearedUpToMessageId: 0,
          user: { id: 42, username: 'me', firstName: 'Me', lastName: '', totalPoints: 0, minime: [] } },
        { userId: 100, role: 'MEMBER', joinedAt: new Date(0), isMuted: false, lastSeenMessageId: null, lastDeliveredMessageId: null, clearedUpToMessageId: 0,
          user: { id: 100, username: 'blk', firstName: 'Blk', lastName: '', totalPoints: 0, minime: [] } },
      ],
      messages: [{ id: 1001, content: 'group secret', imageUrl: null, createdAt: new Date(), senderId: 100 }],
      _count: { messages: 1 },
    },
  ];
  mockBlocks = [{ blockerId: 42, blockedId: 100 }];

  const r7 = res();
  await chat.getMyGroupChats(req({ id: 42 }), r7);
  const group80 = (r7.body || []).find((c) => c.id === 80);
  eq('group preview scrubbed', group80?.latestMessage?.content, '[blocked]');

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
