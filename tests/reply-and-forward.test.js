/**
 * Items 6 + 8 — reply / quote + forwarded round-trip.
 *
 *  • getMessages includes replyTo + forwarded in payload
 *  • replyTo null when message has no replyToMessageId
 *  • forwarded false when not set
 *  • senderName resolution: "FirstName LastName" || username
 *
 * The socket sendMessage handler is harder to unit-test (initSocket bootstrap),
 * so the send-side persistence is exercised via integration / manual flow.
 * Here we cover the READ path which is what clients render.
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const prismaClientPath = require.resolve('@prisma/client');

let mockMessages = [];
const fakePrisma = {
  message: {
    findMany: async ({ where, include }) => {
      // Just return mockMessages whose chatId matches
      return mockMessages.filter(m => m.chatId === where.chatId);
    },
  },
  userOnChat: {
    findFirst: async () => ({ clearedUpToMessageId: 0 }),
  },
  block: {
    findMany: async () => [],
  },
  chat: {
    findMany: async () => [],
  },
  pointsLedger: { findMany: async () => [], groupBy: async () => [] },
  user: { findMany: async () => [] },
};

require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// Stub helpers
const chatHelpersPath = require.resolve('../utils/chatHelpers');
require.cache[chatHelpersPath] = { id: chatHelpersPath, filename: chatHelpersPath, loaded: true, exports: { getBulkUnreadCounts: async () => new Map(), markChatAsRead: async () => {}, getChatReadStatus: async () => ({}) } };
const weeklyPath = require.resolve('../utils/weeklyPoints');
require.cache[weeklyPath] = { id: weeklyPath, filename: weeklyPath, loaded: true, exports: { getWeeklyPointsForUsers: async () => new Map(), getWeeklyPointsForUser: async () => 0 } };

const chat = require('../controllers/chatController');

function req({ id, params, query }) { return { authData: { id }, params: params || {}, query: query || {} }; }
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // ---------- 1. getMessages: replyTo + forwarded round-trip ----------
  console.log('\n[1] getMessages — replyTo + forwarded surfaced in payload');

  mockMessages = [
    {
      id: 1, chatId: 7, senderId: 42, content: 'parent', imageUrl: null,
      isSystem: false, expiresAt: null, createdAt: new Date(), forwarded: false,
      sender: { id: 42, username: 'u42', firstName: 'Alice', lastName: 'A', minime: [] },
      replyTo: null,
      chat: { users: [] },
    },
    {
      id: 2, chatId: 7, senderId: 99, content: 'reply',  imageUrl: null,
      isSystem: false, expiresAt: null, createdAt: new Date(), forwarded: false,
      sender: { id: 99, username: 'u99', firstName: 'Bob', lastName: 'B', minime: [] },
      replyTo: { id: 1, content: 'parent', imageUrl: null, senderId: 42, sender: { username: 'u42', firstName: 'Alice', lastName: 'A' } },
      chat: { users: [] },
    },
    {
      id: 3, chatId: 7, senderId: 42, content: 'fwd it',  imageUrl: 's3://x.jpg',
      isSystem: false, expiresAt: null, createdAt: new Date(), forwarded: true,
      sender: { id: 42, username: 'u42', firstName: 'Alice', lastName: 'A', minime: [] },
      replyTo: null,
      chat: { users: [] },
    },
  ];

  const r1 = res();
  await chat.getMessages(req({ id: 42, params: { chatId: '7' } }), r1);
  const body = r1.body || [];

  eq('3 messages',                body.length, 3);
  eq('msg1 replyTo null',         body[0]?.replyTo, null);
  eq('msg1 forwarded false',      body[0]?.forwarded, false);

  eq('msg2 replyTo not null',     body[1]?.replyTo === null, false);
  eq('msg2 replyTo.id',           body[1]?.replyTo?.id, 1);
  eq('msg2 replyTo content',      body[1]?.replyTo?.content, 'parent');
  eq('msg2 replyTo senderId',     body[1]?.replyTo?.senderId, 42);
  eq('msg2 replyTo senderName',   body[1]?.replyTo?.senderName, 'Alice A');

  eq('msg3 forwarded true',       body[2]?.forwarded, true);
  eq('msg3 replyTo null',         body[2]?.replyTo, null);

  // ---------- 2. senderName falls back to username when no name set ----------
  console.log('\n[2] senderName falls back to username when no first/last');

  mockMessages = [
    {
      id: 10, chatId: 7, senderId: 99, content: 'reply', imageUrl: null,
      isSystem: false, expiresAt: null, createdAt: new Date(), forwarded: false,
      sender: { id: 99, username: 'u99', firstName: null, lastName: null, minime: [] },
      replyTo: { id: 1, content: 'parent', imageUrl: null, senderId: 42, sender: { username: 'u42', firstName: null, lastName: null } },
      chat: { users: [] },
    },
  ];
  const r2 = res();
  await chat.getMessages(req({ id: 42, params: { chatId: '7' } }), r2);
  eq('senderName = username', r2.body?.[0]?.replyTo?.senderName, 'u42');

  // ---------- 3. getMessagesPaginated also surfaces replyTo + forwarded ----------
  console.log('\n[3] getMessagesPaginated also surfaces replyTo + forwarded');

  mockMessages = [
    {
      id: 20, chatId: 7, senderId: 99, content: 'paginated reply', imageUrl: null,
      isSystem: false, expiresAt: null, createdAt: new Date(), forwarded: true,
      sender: { id: 99, username: 'u99', firstName: 'B', lastName: 'B', minime: [] },
      replyTo: { id: 1, content: 'parent', imageUrl: null, senderId: 42, sender: { username: 'u42', firstName: 'A', lastName: 'A' } },
      chat: { users: [] },
    },
  ];
  const r3 = res();
  await chat.getMessagesPaginated(req({ id: 42, params: { chatId: '7' }, query: { page: '1', limit: '20' } }), r3);
  eq('forwarded true',     r3.body?.[0]?.forwarded, true);
  eq('replyTo id',         r3.body?.[0]?.replyTo?.id, 1);
  eq('replyTo senderName', r3.body?.[0]?.replyTo?.senderName, 'A A');

  // ---------- 4. Old client compat: no replyTo / forwarded breaks nothing ----------
  console.log('\n[4] Old shape: replyTo absent → defaults applied');

  mockMessages = [
    {
      id: 30, chatId: 7, senderId: 42, content: 'plain', imageUrl: null,
      isSystem: false, expiresAt: null, createdAt: new Date(),
      // forwarded not set
      sender: { id: 42, username: 'u42', firstName: 'A', lastName: 'A', minime: [] },
      // replyTo not set on the row
      chat: { users: [] },
    },
  ];
  const r4 = res();
  await chat.getMessages(req({ id: 42, params: { chatId: '7' } }), r4);
  eq('forwarded defaults to false', r4.body?.[0]?.forwarded, false);
  eq('replyTo defaults to null',    r4.body?.[0]?.replyTo, null);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
