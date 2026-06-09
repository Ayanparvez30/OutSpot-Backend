/**
 * Disappear-immediately bug fix — recipient READ must NOT delete the message.
 *
 * The legacy markChatAsRead handler scheduled a 5s setTimeout that hard-deleted
 * view-once messages and broadcast messagesDeleted to the entire chat room.
 * That wiped bubbles while the recipient was STILL on the chat screen — the
 * exact bug the user reported. The intended design is per-user clear on chat
 * EXIT, not on read.
 *
 * This test proves:
 *   1. After the recipient calls markChatAsRead, view-once messages persist
 *      indefinitely (no setTimeout-based deletion)
 *   2. markChatAsRead still advances lastSeenMessageId (read receipts unbroken)
 *   3. No messagesDeleted broadcast is emitted on read
 *   4. The existing chatRead event still fires (existing behavior preserved)
 *
 * Pure stubs — no DB, no live socket.
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const prismaClientPath = require.resolve('@prisma/client');
const db = {
  chats: new Map(),
  userOnChats: [],
  messages: [],
};
const fakePrisma = {
  chat: {
    findUnique: async ({ where }) => {
      const c = db.chats.get(where.id);
      return c ? { ...c } : null;
    },
  },
  userOnChat: {
    findFirst: async ({ where }) => db.userOnChats.find(u => u.userId === where.userId && u.chatId === where.chatId) || null,
    update: async ({ where, data }) => {
      const u = db.userOnChats.find(x => x.id === where.id);
      if (u) Object.assign(u, data);
      return u;
    },
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const u of db.userOnChats) {
        if (u.userId === where.userId && u.chatId === where.chatId) {
          Object.assign(u, data);
          count++;
        }
      }
      return { count };
    },
  },
  message: {
    findFirst: async ({ where, orderBy }) => {
      const rows = db.messages.filter(m => m.chatId === where.chatId);
      rows.sort((a, b) => b.id - a.id); // assume desc per call
      return rows[0] || null;
    },
    findMany: async ({ where }) => db.messages.filter(m => m.chatId === where.chatId),
    deleteMany: async ({ where }) => {
      const idsIn = where.id?.in || [];
      const before = db.messages.length;
      db.messages = db.messages.filter(m => !idsIn.includes(m.id));
      return { count: before - db.messages.length };
    },
  },
};
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// Stub socket.getIO with a recorder
const socketPath = require.resolve('../utils/socket');
const socketEmits = [];
require.cache[socketPath] = {
  id: socketPath, filename: socketPath, loaded: true,
  exports: {
    getIO: () => ({ to: (room) => ({ emit: (event, payload) => socketEmits.push({ room, event, payload }) }) }),
    deleteOwnMessages: async () => [],
  },
};

// Stub s3Cleanup so any accidental call gets recorded
const s3Path = require.resolve('../utils/s3Cleanup');
const s3Calls = [];
require.cache[s3Path] = {
  id: s3Path, filename: s3Path, loaded: true,
  exports: { deleteS3IfOrphanBulk: async (urls) => { s3Calls.push(urls); return { deleted: 0, kept: 0, failed: 0 }; } },
};

const chatHelpersPath = require.resolve('../utils/chatHelpers');
require.cache[chatHelpersPath] = { id: chatHelpersPath, filename: chatHelpersPath, loaded: true, exports: { getBulkUnreadCounts: async () => new Map(), markChatAsRead: async () => {}, getChatReadStatus: async () => ({}) } };
const weeklyPath = require.resolve('../utils/weeklyPoints');
require.cache[weeklyPath] = { id: weeklyPath, filename: weeklyPath, loaded: true, exports: { getWeeklyPointsForUsers: async () => new Map(), getWeeklyPointsForUser: async () => 0 } };
const notifPath = require.resolve('../utils/notificationService');
require.cache[notifPath] = { id: notifPath, filename: notifPath, loaded: true, exports: { notifyUser: async () => {} } };
const realtimePath = require.resolve('../utils/realtime');
require.cache[realtimePath] = { id: realtimePath, filename: realtimePath, loaded: true, exports: { toUser: () => {}, toUsers: () => {}, toGroup: () => {}, toCommunity: () => {}, toFriends: () => {} } };

const chat = require('../controllers/chatController');

function req({ id, body }) { return { authData: { id }, body: body || {} }; }
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  console.log('\n[1] Recipient marks chat-as-read on a view-once message → NO delete');

  const VIEW_ONCE_SENTINEL = new Date('2099-01-01T00:00:00.000Z');
  db.chats.set(7, { id: 7, disappearingSeconds: 1 });
  db.userOnChats = [
    { id: 1, userId: 42, chatId: 7, lastSeenMessageId: 0, clearedUpToMessageId: 0 },
    { id: 2, userId: 99, chatId: 7, lastSeenMessageId: 0, clearedUpToMessageId: 0 },
  ];
  db.messages = [
    { id: 100, chatId: 7, senderId: 42, content: 'view-once', imageUrl: null, isSystem: false, expiresAt: VIEW_ONCE_SENTINEL },
    { id: 101, chatId: 7, senderId: 42, content: 'second',    imageUrl: 's3://x.jpg', isSystem: false, expiresAt: VIEW_ONCE_SENTINEL },
  ];
  socketEmits.length = 0;
  s3Calls.length = 0;

  const r1 = res();
  await chat.markChatAsRead(req({ id: 99, body: { chatId: 7 } }), r1);

  // Wait LONGER than the legacy 5s setTimeout. If the old bug is still present
  // the deletes would fire inside this window.
  await new Promise((r) => setTimeout(r, 5500));

  eq('200',                                r1.statusCode, 200);
  eq('both view-once messages persist',    db.messages.length, 2);
  ok('no messagesDeleted broadcast',       !socketEmits.some((e) => e.event === 'messagesDeleted'));
  eq('no S3 cleanup attempted',            s3Calls.length, 0);

  // Read receipt path must still work
  const bRow = db.userOnChats.find((u) => u.userId === 99 && u.chatId === 7);
  eq('B lastSeenMessageId advanced',        bRow?.lastSeenMessageId, 101);

  // chatRead emit (legitimate read receipt) is the only emit on the chat room
  ok('chatRead emit still fires',          socketEmits.some((e) => e.event === 'chatRead' && e.room === 'chat_7'));

  // ---------- 2. Sender's own markChatAsRead should also not delete ----------
  console.log('\n[2] Sender markChatAsRead is also a no-op for deletion');

  socketEmits.length = 0;
  const r2 = res();
  await chat.markChatAsRead(req({ id: 42, body: { chatId: 7 } }), r2);
  await new Promise((r) => setTimeout(r, 5500));
  eq('200',                              r2.statusCode, 200);
  eq('still both view-once messages',    db.messages.length, 2);
  ok('still no messagesDeleted',         !socketEmits.some((e) => e.event === 'messagesDeleted'));

  // ---------- 3. Non-immediate chat: behavior unchanged ----------
  console.log('\n[3] Non-immediate chat — markChatAsRead untouched');

  db.chats.set(8, { id: 8, disappearingSeconds: null });
  db.userOnChats.push(
    { id: 3, userId: 42, chatId: 8, lastSeenMessageId: 0, clearedUpToMessageId: 0 },
    { id: 4, userId: 99, chatId: 8, lastSeenMessageId: 0, clearedUpToMessageId: 0 },
  );
  db.messages.push({ id: 200, chatId: 8, senderId: 42, content: 'normal', imageUrl: null, isSystem: false, expiresAt: null });
  socketEmits.length = 0;

  const r3 = res();
  await chat.markChatAsRead(req({ id: 99, body: { chatId: 8 } }), r3);
  await new Promise((r) => setTimeout(r, 5500));
  eq('200',                                  r3.statusCode, 200);
  eq('message preserved',                    db.messages.length, 3);
  eq('B lastSeenMessageId advanced',         db.userOnChats.find(u => u.userId === 99 && u.chatId === 8)?.lastSeenMessageId, 200);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
