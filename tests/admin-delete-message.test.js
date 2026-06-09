/**
 * Item 5c — admin-delete-message.
 *  • Group admin can delete any message in their group → messagesDeleted emitted
 *  • Community creator can delete any message in their community
 *  • Non-admin member → 403
 *  • DM context → 403 (use item 1 instead)
 *  • Message not found → 404
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const prismaClientPath = require.resolve('@prisma/client');

const mockDb = { messages: [] };
const fakePrisma = {
  message: {
    findUnique: async ({ where }) => mockDb.messages.find(m => m.id === where.id) || null,
    delete: async ({ where }) => { mockDb.messages = mockDb.messages.filter(m => m.id !== where.id); },
  },
};
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// Stub socket.getIO to a recorder
const socketPath = require.resolve('../utils/socket');
const emits = [];
require.cache[socketPath] = {
  id: socketPath, filename: socketPath, loaded: true,
  exports: {
    getIO: () => ({ to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }) }),
    deleteOwnMessages: async () => [],
  },
};

// Stub s3Cleanup
const s3Path = require.resolve('../utils/s3Cleanup');
const s3Calls = [];
require.cache[s3Path] = {
  id: s3Path, filename: s3Path, loaded: true,
  exports: { deleteS3IfOrphanBulk: async (urls) => { s3Calls.push(urls); return urls.length; } },
};

// Other stubs chatController loads
const chatHelpersPath = require.resolve('../utils/chatHelpers');
require.cache[chatHelpersPath] = { id: chatHelpersPath, filename: chatHelpersPath, loaded: true, exports: { getBulkUnreadCounts: async () => new Map(), markChatAsRead: async () => {}, getChatReadStatus: async () => ({}) } };
const weeklyPath = require.resolve('../utils/weeklyPoints');
require.cache[weeklyPath] = { id: weeklyPath, filename: weeklyPath, loaded: true, exports: { getWeeklyPointsForUsers: async () => new Map(), getWeeklyPointsForUser: async () => 0 } };
const realtimePath = require.resolve('../utils/realtime');
require.cache[realtimePath] = { id: realtimePath, filename: realtimePath, loaded: true, exports: { toUser: () => {}, toUsers: () => {}, toGroup: () => {}, toCommunity: () => {}, toFriends: () => {} } };

const chat = require('../controllers/chatController');

function req({ id, params }) { return { authData: { id }, params: params || {} }; }
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // ---------- 1. Group admin can delete any message ----------
  console.log('\n[1] Group admin deletes a non-self message');

  mockDb.messages = [{
    id: 500, chatId: 7, senderId: 99, imageUrl: 's3://x.jpg',
    chat: {
      id: 7, isGroup: true, isCommunity: false, communityId: null,
      community: null,
      users: [{ userId: 42, role: 'ADMIN' }, { userId: 99, role: 'MEMBER' }],
    },
  }];
  emits.length = 0; s3Calls.length = 0;

  const r1 = res();
  await chat.adminDeleteMessage(req({ id: 42, params: { messageId: '500' } }), r1);
  eq('returns 200',          r1.statusCode, 200);
  eq('msg row gone',         mockDb.messages.length, 0);
  eq('messagesDeleted emit', emits.length, 1);
  eq('emit room',            emits[0]?.room, 'chat_7');
  eq('emit event',           emits[0]?.event, 'messagesDeleted');
  eq('emit ids',             emits[0]?.payload?.messageIds, [500]);
  eq('s3 cleanup called',    s3Calls[0], ['s3://x.jpg']);

  // ---------- 2. Community creator deletes anyone's message ----------
  console.log('\n[2] Community creator deletes any message');

  mockDb.messages = [{
    id: 600, chatId: 8, senderId: 99, imageUrl: null,
    chat: {
      id: 8, isGroup: false, isCommunity: true, communityId: 200,
      community: { id: 200, creatorId: 42 },
      users: [{ userId: 42, role: 'MEMBER' }, { userId: 99, role: 'MEMBER' }],
    },
  }];
  emits.length = 0;

  const r2 = res();
  await chat.adminDeleteMessage(req({ id: 42, params: { messageId: '600' } }), r2);
  eq('200',                  r2.statusCode, 200);
  eq('row gone',             mockDb.messages.length, 0);
  eq('emit fired',           emits.length, 1);
  eq('emit room',            emits[0]?.room, 'chat_8');

  // ---------- 3. Non-admin member → 403 ----------
  console.log('\n[3] Non-admin member → 403');

  mockDb.messages = [{
    id: 700, chatId: 9, senderId: 99, imageUrl: null,
    chat: {
      id: 9, isGroup: true, isCommunity: false, communityId: null,
      community: null,
      users: [{ userId: 42, role: 'MEMBER' }, { userId: 99, role: 'MEMBER' }],
    },
  }];

  const r3 = res();
  await chat.adminDeleteMessage(req({ id: 42, params: { messageId: '700' } }), r3);
  eq('403',         r3.statusCode, 403);
  eq('row preserved', mockDb.messages.length, 1);

  // ---------- 4. Community non-creator → 403 ----------
  console.log('\n[4] Community non-creator member → 403');

  mockDb.messages = [{
    id: 800, chatId: 10, senderId: 99, imageUrl: null,
    chat: {
      id: 10, isGroup: false, isCommunity: true, communityId: 300,
      community: { id: 300, creatorId: 1 },
      users: [{ userId: 42, role: 'MEMBER' }, { userId: 99, role: 'MEMBER' }],
    },
  }];

  const r4 = res();
  await chat.adminDeleteMessage(req({ id: 42, params: { messageId: '800' } }), r4);
  eq('403',          r4.statusCode, 403);
  eq('row preserved', mockDb.messages.length, 1);

  // ---------- 5. DM context → 403 ----------
  console.log('\n[5] DM context → 403');

  mockDb.messages = [{
    id: 900, chatId: 11, senderId: 99, imageUrl: null,
    chat: {
      id: 11, isGroup: false, isCommunity: false, communityId: null,
      community: null,
      users: [{ userId: 42, role: 'MEMBER' }, { userId: 99, role: 'MEMBER' }],
    },
  }];

  const r5 = res();
  await chat.adminDeleteMessage(req({ id: 42, params: { messageId: '900' } }), r5);
  eq('403',           r5.statusCode, 403);
  eq('row preserved', mockDb.messages.length, 1);

  // ---------- 6. Message not found → 404 ----------
  console.log('\n[6] Message not found → 404');

  mockDb.messages = [];
  const r6 = res();
  await chat.adminDeleteMessage(req({ id: 42, params: { messageId: '404' } }), r6);
  eq('404', r6.statusCode, 404);

  // ---------- 7. Invalid id → 400 ----------
  console.log('\n[7] Invalid id → 400');

  const r7 = res();
  await chat.adminDeleteMessage(req({ id: 42, params: { messageId: 'abc' } }), r7);
  eq('400', r7.statusCode, 400);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
