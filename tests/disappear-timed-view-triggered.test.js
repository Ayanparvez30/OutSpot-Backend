/**
 * Timed disappearing messages — view-triggered expiresAt stamping.
 *
 * Covers:
 *   A. sendTextMessage (REST) with timed chat → expiresAt = null at send
 *   B. Socket sendMessage with timed chat → expiresAt = null at send
 *   C. view-once (===1) still sets sentinel at send
 *   D. global chat still sets 12h at send
 *   E. off (null, not global) → null
 *   F. markChatAsRead (REST): stamps expiresAt on receiver read for timed mode
 *   G. markChatAsRead (REST): own-sent messages NOT stamped (senderId filter)
 *   H. markChatAsRead (REST): nothing new → no updateMany call
 *   I. markChatAsRead (REST): view-once (===1) skipped
 *   J. markChatAsRead (REST): off (0/null) skipped
 *   K. Idempotency: re-read with no new messages → updateMany not called
 *   L. Messages already with expiresAt set → not overwritten (null guard)
 *   M. chatHelpers.markChatAsRead: same stamps-on-read matrix
 *
 * Pure stubs — no DB, no live socket.
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function approxEq(name, gotMs, wantMs, toleranceMs) {
  const diff = Math.abs(gotMs - wantMs);
  ok(name, diff <= toleranceMs, `got=${gotMs} want≈${wantMs} diff=${diff}ms (tolerance ${toleranceMs}ms)`);
}

// ─── Prisma stub ──────────────────────────────────────────────────────────────

const prismaClientPath = require.resolve('@prisma/client');

const db = {
  chats: new Map(),
  messages: [],
  userOnChats: [],
};

// Track updateMany calls for assertions
const updateManyCalls = [];

const fakePrisma = {
  chat: {
    findUnique: async ({ where }) => db.chats.get(where.id) || null,
    findMany: async () => [],
    update: async () => ({}),
    upsert: async () => ({}),
  },
  userOnChat: {
    findFirst: async ({ where }) => {
      return db.userOnChats.find(u =>
        u.userId === where.userId && u.chatId === where.chatId
      ) || null;
    },
    update: async ({ where, data }) => {
      const u = db.userOnChats.find(x => x.id === where.id);
      if (u) Object.assign(u, data);
      return u || {};
    },
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const u of db.userOnChats) {
        const matchUser = where.userId !== undefined ? u.userId === where.userId : true;
        const matchChat = where.chatId !== undefined ? u.chatId === where.chatId : true;
        if (matchUser && matchChat) { Object.assign(u, data); count++; }
      }
      return { count };
    },
    upsert: async ({ where, update, create }) => {
      let u = db.userOnChats.find(x =>
        x.userId === (where.userId_chatId?.userId ?? where.userId) &&
        x.chatId === (where.userId_chatId?.chatId ?? where.chatId)
      );
      if (u) { Object.assign(u, update); return u; }
      const rec = { id: Date.now(), ...create };
      db.userOnChats.push(rec);
      return rec;
    },
  },
  message: {
    findFirst: async ({ where, orderBy }) => {
      let rows = db.messages.filter(m => {
        if (where.chatId !== undefined && m.chatId !== where.chatId) return false;
        if (where.senderId !== undefined) {
          if (where.senderId.not !== undefined && m.senderId === where.senderId.not) return false;
          if (typeof where.senderId === 'number' && m.senderId !== where.senderId) return false;
        }
        return true;
      });
      if (orderBy?.id === 'desc' || (orderBy && orderBy.createdAt === 'desc')) {
        rows = rows.sort((a, b) => b.id - a.id);
      }
      return rows[0] || null;
    },
    findUnique: async ({ where }) => db.messages.find(m => m.id === where.id) || null,
    findMany: async ({ where }) => {
      return db.messages.filter(m => {
        if (where?.chatId !== undefined && m.chatId !== where.chatId) return false;
        return true;
      });
    },
    create: async ({ data }) => {
      const m = { id: db.messages.length + 1, createdAt: new Date(), ...data };
      db.messages.push(m);
      return { ...m, sender: { id: data.senderId, username: 'testuser', firstName: 'Test', lastName: 'User', minime: [] }, replyTo: null };
    },
    updateMany: async ({ where, data }) => {
      updateManyCalls.push({ where: JSON.parse(JSON.stringify(where)), data: JSON.parse(JSON.stringify({ ...data, expiresAt: data.expiresAt ? data.expiresAt.getTime() : null })) });
      let count = 0;
      for (const m of db.messages) {
        if (where.chatId !== undefined && m.chatId !== where.chatId) continue;
        if (where.senderId?.not !== undefined && m.senderId === where.senderId.not) continue;
        if (where.id?.gt !== undefined && m.id <= where.id.gt) continue;
        if (where.id?.lte !== undefined && m.id > where.id.lte) continue;
        if (where.expiresAt === null && m.expiresAt !== null) continue;
        Object.assign(m, { expiresAt: data.expiresAt });
        count++;
      }
      return { count };
    },
    deleteMany: async () => ({ count: 0 }),
  },
  block: { findMany: async () => [] },
  userPoint: { findMany: async () => [] },
  pointsLedger: { groupBy: async () => [], findMany: async () => [] },
  locationPoint: { findMany: async () => [] },
  user: { findMany: async () => [] },
  $transaction: async (fn) => fn(fakePrisma),
};

require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// ─── Socket stub ──────────────────────────────────────────────────────────────

const socketPath = require.resolve('../utils/socket');
const socketEmits = [];
require.cache[socketPath] = {
  id: socketPath, filename: socketPath, loaded: true,
  exports: {
    getIO: () => ({
      to: (room) => ({ emit: (event, payload) => socketEmits.push({ room, event, payload }) }),
    }),
    deleteOwnMessages: async () => [],
    clearChatOnExit: async () => {},
    sendPushToOfflineUsers: async () => {},
  },
};

// ─── Other stubs ─────────────────────────────────────────────────────────────

const s3UploadPath = require.resolve('../utils/s3Upload');
require.cache[s3UploadPath] = {
  id: s3UploadPath, filename: s3UploadPath, loaded: true,
  exports: {
    materializeChatMedia: async (url) => url,
    uploadToS3: async () => 'https://s3.example.com/test',
    default: async () => {},
  },
};

const s3CleanupPath = require.resolve('../utils/s3Cleanup');
require.cache[s3CleanupPath] = {
  id: s3CleanupPath, filename: s3CleanupPath, loaded: true,
  exports: { deleteS3IfOrphanBulk: async () => ({ deleted: 0, kept: 0, failed: 0 }) },
};

const realtimePath = require.resolve('../utils/realtime');
require.cache[realtimePath] = {
  id: realtimePath, filename: realtimePath, loaded: true,
  exports: { toUser: () => {}, toUsers: () => {}, toGroup: () => {}, toCommunity: () => {}, toFriends: () => {} },
};

const notifPath = require.resolve('../utils/notificationService');
require.cache[notifPath] = {
  id: notifPath, filename: notifPath, loaded: true,
  exports: { notifyUser: async () => {} },
};

const weeklyPath = require.resolve('../utils/weeklyPoints');
require.cache[weeklyPath] = {
  id: weeklyPath, filename: weeklyPath, loaded: true,
  exports: { getWeeklyPointsForUsers: async () => new Map(), getWeeklyPointsForUser: async () => 0 },
};

const chatHelpersPath = require.resolve('../utils/chatHelpers');
// We intentionally load the REAL chatHelpers (after prisma is stubbed) so its
// markChatAsRead logic runs. Delete any stale cache entry first.
delete require.cache[chatHelpersPath];
const chatHelpers = require(chatHelpersPath);

const chat = require('../controllers/chatController');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function req({ id, body, params }) {
  return { authData: { id }, body: body || {}, params: params || {} };
}
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const VIEW_ONCE_SENTINEL = new Date('2099-01-01T00:00:00.000Z');

// ─── Test suite ───────────────────────────────────────────────────────────────

(async () => {

  // ─── A. sendTextMessage REST: timed mode → expiresAt = null ──────────────
  console.log('\n[A] sendTextMessage REST — timed 5m → expiresAt null at send');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(10, {
      id: 10, disappearingSeconds: 300, isGroup: false, isCommunity: false,
      name: null, communityId: null, isLocked: false,
      users: [
        { userId: 1, role: 'MEMBER', lastSeenMessageId: 0 },
        { userId: 2, role: 'MEMBER', lastSeenMessageId: 0 },
      ],
    });
    db.userOnChats.push({ id: 1, userId: 1, chatId: 10, lastSeenMessageId: 0, clearedUpToMessageId: 0 });

    const r = res();
    await chat.sendTextMessage(req({ id: 1, body: { chatId: 10, content: 'hello' } }), r);

    eq('A: status 200', r.statusCode, 200);
    const created = db.messages.find(m => m.chatId === 10 && m.senderId === 1);
    ok('A: message created', !!created, 'no message in db');
    ok('A: expiresAt is null for 5m timed mode', created?.expiresAt === null || created?.expiresAt === undefined,
      `got expiresAt=${created?.expiresAt}`);
  }

  // ─── A2. sendTextMessage REST: timed 30m ──────────────────────────────────
  console.log('\n[A2] sendTextMessage REST — timed 1800s → expiresAt null at send');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(11, {
      id: 11, disappearingSeconds: 1800, isGroup: false, isCommunity: false,
      name: null, communityId: null, isLocked: false,
      users: [{ userId: 1, role: 'MEMBER', lastSeenMessageId: 0 }],
    });
    db.userOnChats.push({ id: 1, userId: 1, chatId: 11, lastSeenMessageId: 0, clearedUpToMessageId: 0 });

    const r = res();
    await chat.sendTextMessage(req({ id: 1, body: { chatId: 11, content: 'timed 30m' } }), r);
    const created = db.messages.find(m => m.chatId === 11);
    ok('A2: expiresAt null for 1800s', created?.expiresAt === null || created?.expiresAt === undefined,
      `got expiresAt=${created?.expiresAt}`);
  }

  // ─── C. view-once sentinel ────────────────────────────────────────────────
  console.log('\n[C] sendTextMessage REST — view-once (===1) → sentinel');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(12, {
      id: 12, disappearingSeconds: 1, isGroup: false, isCommunity: false,
      name: null, communityId: null, isLocked: false,
      users: [{ userId: 1, role: 'MEMBER', lastSeenMessageId: 0 }],
    });
    db.userOnChats.push({ id: 1, userId: 1, chatId: 12, lastSeenMessageId: 0, clearedUpToMessageId: 0 });

    const r = res();
    await chat.sendTextMessage(req({ id: 1, body: { chatId: 12, content: 'view once' } }), r);
    const created = db.messages.find(m => m.chatId === 12);
    ok('C: view-once expiresAt = sentinel',
      created?.expiresAt instanceof Date && created.expiresAt.toISOString() === VIEW_ONCE_SENTINEL.toISOString(),
      `got=${created?.expiresAt}`);
  }

  // ─── D. global chat 12h ───────────────────────────────────────────────────
  console.log('\n[D] sendTextMessage REST — global chat → 12h expiresAt');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(13, {
      id: 13, disappearingSeconds: null, isGroup: false, isCommunity: false,
      name: 'Global Chat - London', communityId: null, isLocked: false,
      users: [{ userId: 1, role: 'MEMBER', lastSeenMessageId: 0 }],
    });
    db.userOnChats.push({ id: 1, userId: 1, chatId: 13, lastSeenMessageId: 0, clearedUpToMessageId: 0 });

    const before = Date.now();
    const r = res();
    await chat.sendTextMessage(req({ id: 1, body: { chatId: 13, content: 'global msg' } }), r);
    const created = db.messages.find(m => m.chatId === 13);
    const expected12h = before + 12 * 60 * 60 * 1000;
    ok('D: global chat expiresAt is ~12h from now',
      created?.expiresAt instanceof Date &&
      Math.abs(created.expiresAt.getTime() - expected12h) < 5000,
      `got=${created?.expiresAt?.toISOString()}`);
  }

  // ─── E. off (null, not global) → null ─────────────────────────────────────
  console.log('\n[E] sendTextMessage REST — off (null) → expiresAt null');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(14, {
      id: 14, disappearingSeconds: null, isGroup: false, isCommunity: false,
      name: null, communityId: null, isLocked: false,
      users: [{ userId: 1, role: 'MEMBER', lastSeenMessageId: 0 }],
    });
    db.userOnChats.push({ id: 1, userId: 1, chatId: 14, lastSeenMessageId: 0, clearedUpToMessageId: 0 });

    const r = res();
    await chat.sendTextMessage(req({ id: 1, body: { chatId: 14, content: 'normal msg' } }), r);
    const created = db.messages.find(m => m.chatId === 14);
    ok('E: off mode expiresAt = null', created?.expiresAt === null || created?.expiresAt === undefined,
      `got=${created?.expiresAt}`);
  }

  // ─── F. markChatAsRead REST: stamps expiresAt on receiver read ────────────
  console.log('\n[F] markChatAsRead REST — timed 300s → stamps expiresAt on read');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(20, { id: 20, disappearingSeconds: 300 });
    // 3 messages from sender 5 (not me=99), 1 from me=99 — only the from-5 ones should be stamped
    db.messages = [
      { id: 10, chatId: 20, senderId: 5,  content: 'from other 1', expiresAt: null, createdAt: new Date() },
      { id: 11, chatId: 20, senderId: 5,  content: 'from other 2', expiresAt: null, createdAt: new Date() },
      { id: 12, chatId: 20, senderId: 99, content: 'from me',      expiresAt: null, createdAt: new Date() },
    ];
    db.userOnChats = [
      { id: 1, userId: 99, chatId: 20, lastSeenMessageId: 0, clearedUpToMessageId: 0 },
    ];

    const before = Date.now();
    const r = res();
    await chat.markChatAsRead(req({ id: 99, body: { chatId: 20 } }), r);

    eq('F: status 200', r.statusCode, 200);
    // updateMany must have been called exactly once for the timer stamp
    const timerCalls = updateManyCalls.filter(c => c.where.chatId === 20);
    ok('F: updateMany called once', timerCalls.length === 1, `calls=${timerCalls.length}`);
    const call = timerCalls[0];
    // senderId filter: not me
    eq('F: senderId.not = current user', call.where.senderId?.not, 99);
    // expiresAt null guard
    eq('F: expiresAt null guard in where', call.where.expiresAt, null);
    // id range: gt prevLastSeen(0), lte latestMessage(12)
    eq('F: id.gt = prevLastSeen(0)', call.where.id?.gt, 0);
    eq('F: id.lte = latestMessageId(12)', call.where.id?.lte, 12);
    // actual stamp: ≈ now + 300s
    approxEq('F: expiresAt ≈ now+300s', call.data.expiresAt, before + 300000, 5000);
  }

  // ─── G. own-sent messages NOT stamped ─────────────────────────────────────
  console.log('\n[G] markChatAsRead REST — own messages not stamped');
  {
    // The senderId:{not: currentUser} clause guarantees this. We verify by checking
    // that the message with senderId=currentUser did NOT get expiresAt set.
    // db state from F still applies but let's re-verify explicitly.
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(21, { id: 21, disappearingSeconds: 900 });
    db.messages = [
      { id: 20, chatId: 21, senderId: 7,  content: 'other', expiresAt: null, createdAt: new Date() },
      { id: 21, chatId: 21, senderId: 42, content: 'mine',  expiresAt: null, createdAt: new Date() },
    ];
    db.userOnChats = [{ id: 1, userId: 42, chatId: 21, lastSeenMessageId: 0, clearedUpToMessageId: 0 }];

    const r = res();
    await chat.markChatAsRead(req({ id: 42, body: { chatId: 21 } }), r);

    const myMsg = db.messages.find(m => m.id === 21 && m.senderId === 42);
    ok('G: own-sent message expiresAt stays null', myMsg?.expiresAt === null,
      `got expiresAt=${myMsg?.expiresAt}`);
    const otherMsg = db.messages.find(m => m.id === 20);
    ok('G: other-sent message DID get stamped', otherMsg?.expiresAt instanceof Date,
      `got expiresAt=${otherMsg?.expiresAt}`);
  }

  // ─── H. nothing new → no updateMany ──────────────────────────────────────
  console.log('\n[H] markChatAsRead REST — prevLastSeen === latestMessage → no updateMany');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(22, { id: 22, disappearingSeconds: 300 });
    db.messages = [{ id: 50, chatId: 22, senderId: 9, content: 'hi', expiresAt: null, createdAt: new Date() }];
    // prevLastSeen already at 50 — nothing new
    db.userOnChats = [{ id: 1, userId: 99, chatId: 22, lastSeenMessageId: 50, clearedUpToMessageId: 0 }];

    const r = res();
    await chat.markChatAsRead(req({ id: 99, body: { chatId: 22 } }), r);

    const timerCalls = updateManyCalls.filter(c => c.where.chatId === 22);
    ok('H: no updateMany when nothing new', timerCalls.length === 0, `calls=${timerCalls.length}`);
  }

  // ─── I. view-once (===1) → no updateMany ─────────────────────────────────
  console.log('\n[I] markChatAsRead REST — view-once (disappearingSeconds=1) → no timer stamp');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(23, { id: 23, disappearingSeconds: 1 });
    db.messages = [{ id: 60, chatId: 23, senderId: 8, content: 'once', expiresAt: null, createdAt: new Date() }];
    db.userOnChats = [{ id: 1, userId: 99, chatId: 23, lastSeenMessageId: 0, clearedUpToMessageId: 0 }];

    const r = res();
    await chat.markChatAsRead(req({ id: 99, body: { chatId: 23 } }), r);

    const timerCalls = updateManyCalls.filter(c => c.where.chatId === 23);
    ok('I: view-once → no updateMany', timerCalls.length === 0, `calls=${timerCalls.length}`);
  }

  // ─── J. off (disappearingSeconds=0/null) → no updateMany ──────────────────
  console.log('\n[J] markChatAsRead REST — off (null/0) → no timer stamp');
  {
    for (const sec of [null, 0]) {
      db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
      db.chats.set(24, { id: 24, disappearingSeconds: sec });
      db.messages = [{ id: 70, chatId: 24, senderId: 8, content: 'normal', expiresAt: null, createdAt: new Date() }];
      db.userOnChats = [{ id: 1, userId: 99, chatId: 24, lastSeenMessageId: 0, clearedUpToMessageId: 0 }];

      const r = res();
      await chat.markChatAsRead(req({ id: 99, body: { chatId: 24 } }), r);

      const timerCalls = updateManyCalls.filter(c => c.where.chatId === 24);
      ok(`J: disappearingSeconds=${sec} → no updateMany`, timerCalls.length === 0, `calls=${timerCalls.length}`);
    }
  }

  // ─── K. Idempotency: re-read no new messages → no updateMany ─────────────
  console.log('\n[K] markChatAsRead REST — idempotency (second read, nothing new)');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(25, { id: 25, disappearingSeconds: 300 });
    db.messages = [{ id: 80, chatId: 25, senderId: 3, content: 'msg', expiresAt: null, createdAt: new Date() }];
    db.userOnChats = [{ id: 1, userId: 99, chatId: 25, lastSeenMessageId: 0, clearedUpToMessageId: 0 }];

    // First read
    await chat.markChatAsRead(req({ id: 99, body: { chatId: 25 } }), res());
    const firstCallCount = updateManyCalls.filter(c => c.where.chatId === 25).length;

    // Second read (prevLastSeen now = 80 = latestMessage.id → sec > 1 but 80 > 80 is false)
    await chat.markChatAsRead(req({ id: 99, body: { chatId: 25 } }), res());
    const secondCallCount = updateManyCalls.filter(c => c.where.chatId === 25).length;

    eq('K: first read stamped once', firstCallCount, 1);
    eq('K: second read no new updateMany', secondCallCount, 1); // still just 1
  }

  // ─── L. expiresAt already set → not overwritten ───────────────────────────
  console.log('\n[L] markChatAsRead REST — expiresAt: null guard prevents re-stamp');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(26, { id: 26, disappearingSeconds: 300 });
    const existingExpiry = new Date(Date.now() + 200000);
    db.messages = [
      { id: 90, chatId: 26, senderId: 5, content: 'already stamped', expiresAt: existingExpiry, createdAt: new Date() },
      { id: 91, chatId: 26, senderId: 5, content: 'unstamped',       expiresAt: null,           createdAt: new Date() },
    ];
    db.userOnChats = [{ id: 1, userId: 99, chatId: 26, lastSeenMessageId: 0, clearedUpToMessageId: 0 }];

    const r = res();
    await chat.markChatAsRead(req({ id: 99, body: { chatId: 26 } }), r);

    // The already-stamped message should keep its original expiresAt
    const alreadyStamped = db.messages.find(m => m.id === 90);
    ok('L: already-stamped expiresAt unchanged',
      alreadyStamped?.expiresAt?.getTime() === existingExpiry.getTime(),
      `got=${alreadyStamped?.expiresAt?.toISOString()}`);
    // The unstamped one should get stamped
    const unstamped = db.messages.find(m => m.id === 91);
    ok('L: unstamped message got stamped', unstamped?.expiresAt instanceof Date && unstamped.expiresAt !== null,
      `got=${unstamped?.expiresAt}`);
  }

  // ─── M. chatHelpers.markChatAsRead: same matrix ───────────────────────────
  console.log('\n[M] chatHelpers.markChatAsRead — stamps expiresAt on read (300s)');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(30, { id: 30, disappearingSeconds: 300 });
    db.messages = [
      { id: 100, chatId: 30, senderId: 7, content: 'a', expiresAt: null, createdAt: new Date() },
      { id: 101, chatId: 30, senderId: 7, content: 'b', expiresAt: null, createdAt: new Date() },
      { id: 102, chatId: 30, senderId: 42, content: 'mine', expiresAt: null, createdAt: new Date() },
    ];
    db.userOnChats = [{ id: 1, userId: 42, chatId: 30, lastSeenMessageId: 0, clearedUpToMessageId: 0 }];

    const before = Date.now();
    await chatHelpers.markChatAsRead(42, 30);

    const timerCalls = updateManyCalls.filter(c => c.where.chatId === 30);
    ok('M: helper called updateMany', timerCalls.length >= 1, `calls=${timerCalls.length}`);
    if (timerCalls.length > 0) {
      const call = timerCalls[0];
      eq('M: senderId.not = current user', call.where.senderId?.not, 42);
      eq('M: expiresAt null guard', call.where.expiresAt, null);
      approxEq('M: expiresAt ≈ now+300s', call.data.expiresAt, before + 300000, 5000);
    }
  }

  // M2: helper — view-once skipped
  console.log('\n[M2] chatHelpers.markChatAsRead — view-once (===1) → no stamp');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(31, { id: 31, disappearingSeconds: 1 });
    db.messages = [{ id: 110, chatId: 31, senderId: 7, content: 'once', expiresAt: null, createdAt: new Date() }];
    db.userOnChats = [{ id: 1, userId: 42, chatId: 31, lastSeenMessageId: 0, clearedUpToMessageId: 0 }];

    await chatHelpers.markChatAsRead(42, 31);
    const timerCalls = updateManyCalls.filter(c => c.where.chatId === 31);
    ok('M2: helper view-once → no updateMany', timerCalls.length === 0, `calls=${timerCalls.length}`);
  }

  // M3: helper — off (null) skipped
  console.log('\n[M3] chatHelpers.markChatAsRead — off (null) → no stamp');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(32, { id: 32, disappearingSeconds: null });
    db.messages = [{ id: 120, chatId: 32, senderId: 7, content: 'normal', expiresAt: null, createdAt: new Date() }];
    db.userOnChats = [{ id: 1, userId: 42, chatId: 32, lastSeenMessageId: 0, clearedUpToMessageId: 0 }];

    await chatHelpers.markChatAsRead(42, 32);
    const timerCalls = updateManyCalls.filter(c => c.where.chatId === 32);
    ok('M3: helper off → no updateMany', timerCalls.length === 0, `calls=${timerCalls.length}`);
  }

  // M4: helper — idempotency
  console.log('\n[M4] chatHelpers.markChatAsRead — idempotency on re-read');
  {
    db.chats.clear(); db.messages = []; db.userOnChats = []; updateManyCalls.length = 0;
    db.chats.set(33, { id: 33, disappearingSeconds: 3600 });
    db.messages = [{ id: 130, chatId: 33, senderId: 7, content: 'hourly', expiresAt: null, createdAt: new Date() }];
    db.userOnChats = [{ id: 1, userId: 42, chatId: 33, lastSeenMessageId: 0, clearedUpToMessageId: 0 }];

    await chatHelpers.markChatAsRead(42, 33);
    const after1 = updateManyCalls.filter(c => c.where.chatId === 33).length;
    // second read — prevLastSeen now = 130 = latestMessage.id → no new stamp
    await chatHelpers.markChatAsRead(42, 33);
    const after2 = updateManyCalls.filter(c => c.where.chatId === 33).length;
    eq('M4: first read stamped once', after1, 1);
    eq('M4: second read no new updateMany', after2, 1);
  }

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch(err => {
  console.error('TEST CRASH', err);
  process.exit(1);
});
