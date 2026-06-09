/**
 * REST sendTextMessage parity — accept + echo replyTo + forwarded.
 *
 * Before: REST `POST /api/chats/messages` did NOT accept replyToMessageId
 * or forwarded, and the formatted response + socket newMessage echo from
 * this REST path lacked replyTo. Result: when the FE sent a reply via REST,
 * the recipient's incoming newMessage didn't carry the quote chip data.
 *
 * This test proves the parity fix:
 *   • replyToMessageId in body → persisted on Message.replyToMessageId
 *   • forwarded:true in body → persisted on Message.forwarded
 *   • response.message.replyTo populated with {id, content, imageUrl,
 *     senderId, senderName}
 *   • response.message.forwarded boolean
 *   • emitted newMessage payload also carries both fields (recipient sees them)
 *
 *   • Validation: replyToMessageId for a message in a DIFFERENT chat is dropped
 *   • Backward compat: REST send WITHOUT reply fields still works exactly
 *     as before — response includes forwarded:false + replyTo:null
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const prismaClientPath = require.resolve('@prisma/client');

const db = {
  chats: new Map([[7, { id: 7, isGroup: true, isCommunity: false, isLocked: false, communityId: null, name: 'g', disappearingSeconds: null, users: [{ userId: 42, role: 'MEMBER', lastSeenMessageId: 0 }, { userId: 99, role: 'MEMBER', lastSeenMessageId: 0 }] }]]),
  messages: [
    // A pre-existing message we'll reply to
    { id: 50, chatId: 7, senderId: 99, content: 'parent text', imageUrl: null, isSystem: false, expiresAt: null, createdAt: new Date(),
      sender: { id: 99, username: 'u99', firstName: 'Bob', lastName: 'B' } },
    // A message in a DIFFERENT chat — replyToMessageId pointing here must be dropped
    { id: 60, chatId: 999, senderId: 99, content: 'other chat', imageUrl: null, isSystem: false, expiresAt: null, createdAt: new Date(),
      sender: { id: 99, username: 'u99', firstName: 'Bob', lastName: 'B' } },
  ],
};

const fakePrisma = {
  chat: {
    findUnique: async ({ where, select }) => {
      const c = db.chats.get(where.id);
      if (!c) return null;
      return JSON.parse(JSON.stringify(c));
    },
    update: async () => ({}),
    findMany: async () => [],
  },
  userOnChat: {
    findFirst: async () => ({ role: 'MEMBER' }),
    upsert: async () => ({}),
    updateMany: async () => ({}),
  },
  message: {
    findUnique: async ({ where, select }) => {
      const m = db.messages.find(x => x.id === where.id);
      if (!m) return null;
      if (!select) return m;
      const out = {};
      for (const k of Object.keys(select)) if (select[k]) out[k] = m[k];
      return out;
    },
    create: async ({ data, include }) => {
      const row = {
        id: 1000 + db.messages.length,
        isSystem: false,
        createdAt: new Date(),
        expiresAt: data.expiresAt || null,
        ...data,
        forwarded: !!data.forwarded,
        sender: { id: data.senderId, username: 'me', firstName: 'M', lastName: 'E', minime: [] },
        replyTo: null,
      };
      // Resolve replyTo from db when replyToMessageId present
      if (data.replyToMessageId) {
        const target = db.messages.find(m => m.id === data.replyToMessageId);
        if (target) {
          row.replyTo = {
            id: target.id, content: target.content, imageUrl: target.imageUrl, senderId: target.senderId,
            sender: target.sender,
          };
        }
      }
      db.messages.push(row);
      return row;
    },
  },
  block: { findMany: async () => [] },
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
    sendPushToOfflineUsers: () => {},
  },
};

const chatHelpersPath = require.resolve('../utils/chatHelpers');
require.cache[chatHelpersPath] = { id: chatHelpersPath, filename: chatHelpersPath, loaded: true, exports: { getBulkUnreadCounts: async () => new Map(), markChatAsRead: async () => {}, getChatReadStatus: async () => ({}) } };
const weeklyPath = require.resolve('../utils/weeklyPoints');
require.cache[weeklyPath] = { id: weeklyPath, filename: weeklyPath, loaded: true, exports: { getWeeklyPointsForUsers: async () => new Map(), getWeeklyPointsForUser: async () => 0 } };
const notifPath = require.resolve('../utils/notificationService');
require.cache[notifPath] = { id: notifPath, filename: notifPath, loaded: true, exports: { notifyUser: async () => {} } };
const realtimePath = require.resolve('../utils/realtime');
require.cache[realtimePath] = { id: realtimePath, filename: realtimePath, loaded: true, exports: { toUser: () => {}, toUsers: () => {}, toGroup: () => {}, toCommunity: () => {}, toFriends: () => {} } };
const s3UploadPath = require.resolve('../utils/s3Upload');
require.cache[s3UploadPath] = { id: s3UploadPath, filename: s3UploadPath, loaded: true, exports: { ...require('../utils/s3Upload'), materializeChatMedia: async (u) => u } };

const chat = require('../controllers/chatController');

function req({ id, body }) { return { authData: { id }, body: body || {} }; }
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // ---------- 1. REST send WITH replyToMessageId → replyTo + content in response + socket echo ----------
  console.log('\n[1] REST send-with-reply → response + newMessage echo carry replyTo');

  socketEmits.length = 0;
  const r1 = res();
  await chat.sendTextMessage(req({ id: 42, body: { chatId: 7, content: 'thats nice', replyToMessageId: 50 } }), r1);

  eq('200',                                r1.statusCode, 200);
  const m = r1.body?.message;
  ok('message returned',                   !!m);
  eq('replyTo.id',                         m?.replyTo?.id, 50);
  eq('replyTo.content',                    m?.replyTo?.content, 'parent text');
  eq('replyTo.senderId',                   m?.replyTo?.senderId, 99);
  eq('replyTo.senderName = "Bob B"',       m?.replyTo?.senderName, 'Bob B');
  eq('forwarded false (default)',          m?.forwarded, false);

  // Socket echo (the receiver's path) must carry the same fields
  const newMsg = socketEmits.find(e => e.event === 'newMessage');
  ok('newMessage emitted',                 !!newMsg);
  eq('echo replyTo.id',                    newMsg?.payload?.replyTo?.id, 50);
  eq('echo replyTo.content',               newMsg?.payload?.replyTo?.content, 'parent text');
  eq('echo replyTo.senderName',            newMsg?.payload?.replyTo?.senderName, 'Bob B');
  eq('echo forwarded false',               newMsg?.payload?.forwarded, false);

  // ---------- 2. REST send-with-forwarded ----------
  console.log('\n[2] REST send-with-forwarded → response + echo carry forwarded=true');

  socketEmits.length = 0;
  const r2 = res();
  await chat.sendTextMessage(req({ id: 42, body: { chatId: 7, content: 'fwd it', forwarded: true } }), r2);
  eq('forwarded true in response',         r2.body?.message?.forwarded, true);
  eq('replyTo null when not replying',     r2.body?.message?.replyTo, null);
  const newMsg2 = socketEmits.find(e => e.event === 'newMessage');
  eq('echo forwarded true',                newMsg2?.payload?.forwarded, true);
  eq('echo replyTo null',                  newMsg2?.payload?.replyTo, null);

  // ---------- 3. Cross-chat replyToMessageId → silently dropped ----------
  console.log('\n[3] replyToMessageId from a DIFFERENT chat → silently dropped');

  socketEmits.length = 0;
  const r3 = res();
  await chat.sendTextMessage(req({ id: 42, body: { chatId: 7, content: 'spoofed', replyToMessageId: 60 } }), r3);
  eq('200',                                r3.statusCode, 200);
  eq('replyTo null (cross-chat dropped)',  r3.body?.message?.replyTo, null);

  // ---------- 4. Backward compat — REST send WITHOUT new fields ----------
  console.log('\n[4] Old payload (no reply/forwarded) still works');

  socketEmits.length = 0;
  const r4 = res();
  await chat.sendTextMessage(req({ id: 42, body: { chatId: 7, content: 'plain text' } }), r4);
  eq('200',                                r4.statusCode, 200);
  eq('forwarded false',                    r4.body?.message?.forwarded, false);
  eq('replyTo null',                       r4.body?.message?.replyTo, null);
  // Old-shape consumers still get id/content/sender intact
  ok('id present',                         !!r4.body?.message?.id);
  eq('content preserved',                  r4.body?.message?.content, 'plain text');

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
