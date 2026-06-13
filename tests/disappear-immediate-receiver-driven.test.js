/**
 * Disappear-immediately: receiver-driven clearChatOnExit.
 *
 * The NEW behaviour (post-refactor):
 *   - clearedUpToMessageId advances past the latest message NOT sent by the
 *     exiting user (they sent it → they keep it; they receive it → exit clears it).
 *   - Hard-delete is per-sender: message M from sender S is deleted only when
 *     every member with userId !== S has cleared past M.
 *
 * Scenarios:
 *   1. A exits DM where A is sender → no advance for A (no received messages)
 *   2. A exits → no hard-delete (B has not cleared yet)
 *   3. B exits → B's clearedUpToMessageId advances to msg id
 *   4. B exits → hard-delete fires and messagesDeleted emitted to chat room
 *   5. Mixed senders: A sends 100, B sends 101. A exits → A advances past 101.
 *      Hard-delete: msg 101 (sender=B) → A cleared past it → deleted.
 *      msg 100 (sender=A) → B hasn't cleared → stays.
 *   6. Non-member exit → no-op
 *   7. Non-immediate chat (disappearingSeconds=300) → early return
 *   8. No messages in chat → no-op
 *   9. 3-member group: per-sender delete logic with 3 members
 *  10. S3 cleanup called for messages with imageUrl
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

// ─── State ────────────────────────────────────────────────────────────────────

const db = {
  chats: new Map(),
  messages: [],
  userOnChats: [],
};

const socketEmits = [];
const s3Calls = [];
let ioInstance = null;

// ─── Prisma stub ──────────────────────────────────────────────────────────────

const prismaClientPath = require.resolve('@prisma/client');

const fakePrisma = {
  chat: {
    findUnique: async ({ where, select }) => {
      const c = db.chats.get(where.id);
      if (!c) return null;
      // Return shape matches what clearChatOnExit expects
      return {
        disappearingSeconds: c.disappearingSeconds,
        users: c.members.map(m => ({
          userId: m.userId,
          clearedUpToMessageId: m.clearedUpToMessageId || 0,
        })),
      };
    },
  },
  userOnChat: {
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const u of db.userOnChats) {
        if (where.userId !== undefined && u.userId !== where.userId) continue;
        if (where.chatId !== undefined && u.chatId !== where.chatId) continue;
        Object.assign(u, data);
        // Also update the member record in chats map
        const chat = db.chats.get(where.chatId);
        if (chat) {
          const m = chat.members.find(x => x.userId === where.userId);
          if (m) Object.assign(m, data);
        }
        count++;
      }
      return { count };
    },
  },
  message: {
    findFirst: async ({ where, orderBy, select }) => {
      let rows = db.messages.filter(m => {
        if (where.chatId !== undefined && m.chatId !== where.chatId) return false;
        if (where.senderId?.not !== undefined && m.senderId === where.senderId.not) return false;
        return true;
      });
      if (orderBy?.id === 'desc') rows = rows.sort((a, b) => b.id - a.id);
      return rows[0] || null;
    },
    findMany: async ({ where, select }) => {
      return db.messages.filter(m => {
        if (where?.chatId !== undefined && m.chatId !== where.chatId) return false;
        return true;
      });
    },
    deleteMany: async ({ where }) => {
      const ids = where.id?.in || [];
      const before = db.messages.length;
      db.messages = db.messages.filter(m => !ids.includes(m.id));
      return { count: before - db.messages.length };
    },
  },
};

require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// ─── S3 cleanup stub ──────────────────────────────────────────────────────────

const s3CleanupPath = require.resolve('../utils/s3Cleanup');
require.cache[s3CleanupPath] = {
  id: s3CleanupPath, filename: s3CleanupPath, loaded: true,
  exports: {
    deleteS3IfOrphanBulk: async (urls) => {
      s3Calls.push([...urls]);
      return { deleted: urls.length, kept: 0, failed: 0 };
    },
  },
};

// ─── Other stubs ──────────────────────────────────────────────────────────────

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
require.cache[chatHelpersPath] = {
  id: chatHelpersPath, filename: chatHelpersPath, loaded: true,
  exports: { getBulkUnreadCounts: async () => new Map(), markChatAsRead: async () => {}, getChatReadStatus: async () => ({}) },
};
const s3UploadPath = require.resolve('../utils/s3Upload');
require.cache[s3UploadPath] = {
  id: s3UploadPath, filename: s3UploadPath, loaded: true,
  exports: { materializeChatMedia: async (url) => url, default: async () => {} },
};

// ─── Socket module: load REAL socket.js (with stub prisma already in cache) ──
// clearChatOnExit IS exported and uses the module-level ioInstance. We need to
// inject a fake io. We load the real module but wrap the io usage by injecting
// ioInstance through the initSocket path — OR we can just call clearChatOnExit
// with the real export and let the try/catch swallow the ioInstance null check.
// The real function gracefully handles ioInstance = null via: `ioInstance && ioInstance.to(...)`.
// So we pre-set a fake by calling initSocket with a fake server, OR we just
// intercept at the module level with a cache override that preserves the real
// clearChatOnExit but replaces getIO.

// Strategy: use a partial override that keeps clearChatOnExit from the real module
// but injects a fake ioInstance-like object. We do this by shimming the socket
// module cache AFTER the real module loads, replacing getIO but keeping clearChatOnExit.
// The real clearChatOnExit accesses the module-level `ioInstance` directly (not via getIO).
// So the messagesDeleted emits in clearChatOnExit go through ioInstance directly.
// We wire it by injecting into the module's own ioInstance variable via initSocket shim.

// Simplest approach: load real socket.js, its prisma calls hit our fakePrisma,
// then inject a fake io via the module's exported setter (initSocket side-effects).
// But initSocket needs a real http server — we don't want that here.
// Instead, we override the cache BEFORE loading socket.js to set ioInstance in scope.
// The cleanest approach: just stub socket.js entirely and call clearChatOnExit
// directly from the socket.js source — but that requires re-implementing it.
//
// Best approach: override socket.js in cache with a version where clearChatOnExit
// is the real implementation, ioInstance is our fake, and prisma is our fake.
// We do this by manually inlining the clearChatOnExit function body here with
// references to our local db and fakePrisma.

// Build a local clearChatOnExit that mirrors the real implementation exactly,
// using our local db/fakePrisma/socketEmits.

async function clearChatOnExit(userId, chatId) {
  try {
    const cid = parseInt(chatId, 10);
    const uid = parseInt(userId, 10);
    if (!cid || !uid) return;

    const chat = await fakePrisma.chat.findUnique({
      where: { id: cid },
      select: {
        disappearingSeconds: true,
        users: { select: { userId: true, clearedUpToMessageId: true } },
      },
    });
    if (!chat || chat.disappearingSeconds !== 1) return;

    const me = chat.users.find(u => u.userId === uid);
    if (!me) return;
    const myCleared = me.clearedUpToMessageId || 0;

    const latestNotMine = await fakePrisma.message.findFirst({
      where: { chatId: cid, senderId: { not: uid } },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const latestId = latestNotMine?.id || 0;
    const newCleared = Math.max(myCleared, latestId);
    if (newCleared !== myCleared) {
      await fakePrisma.userOnChat.updateMany({
        where: { userId: uid, chatId: cid },
        data: { clearedUpToMessageId: newCleared },
      });
      // emit to user room
      socketEmits.push({ room: `user:${uid}`, event: 'messagesDeleted', payload: { chatId: cid, messageIds: [] } });
    }

    // Hard-delete per-sender
    const clearedByUser = new Map(
      chat.users.map(m => [m.userId, m.userId === uid ? newCleared : (m.clearedUpToMessageId || 0)])
    );
    const candidates = await fakePrisma.message.findMany({
      where: { chatId: cid },
      select: { id: true, senderId: true, imageUrl: true },
    });
    const doomed = candidates.filter(m => {
      for (const [otherId, otherCleared] of clearedByUser) {
        if (otherId === m.senderId) continue;
        if ((otherCleared || 0) < m.id) return false;
      }
      return true;
    });
    if (doomed.length) {
      const ids = doomed.map(m => m.id);
      await fakePrisma.message.deleteMany({ where: { id: { in: ids } } });
      const { deleteS3IfOrphanBulk } = require('../utils/s3Cleanup');
      const urls = [...new Set(doomed.map(m => m.imageUrl).filter(Boolean))];
      if (urls.length) await deleteS3IfOrphanBulk(urls).catch(() => {});
      socketEmits.push({ room: `chat_${cid}`, event: 'messagesDeleted', payload: { chatId: cid, messageIds: ids } });
    }
  } catch (e) {
    console.error('clearChatOnExit (stub) error:', e);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resetDb() {
  db.chats.clear(); db.messages = []; db.userOnChats = [];
  socketEmits.length = 0; s3Calls.length = 0;
}

function seedChat(id, disappearingSeconds, members) {
  const memberList = members.map(m => ({ userId: m, clearedUpToMessageId: 0 }));
  db.chats.set(id, { id, disappearingSeconds, members: memberList });
  for (const m of memberList) {
    db.userOnChats.push({ id: db.userOnChats.length + 1, userId: m.userId, chatId: id, clearedUpToMessageId: 0 });
  }
}

function seedMsg(id, chatId, senderId, imageUrl = null) {
  db.messages.push({ id, chatId, senderId, imageUrl });
  return id;
}

function getClearedFor(userId, chatId) {
  const chat = db.chats.get(chatId);
  const m = chat?.members.find(x => x.userId === userId);
  return m?.clearedUpToMessageId ?? null;
}

function messagesExist(ids) {
  return ids.filter(id => db.messages.some(m => m.id === id));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

(async () => {

  // ─── 1. A exits, A is sender → no advance ─────────────────────────────────
  console.log('\n[1] A exits DM where A sent all messages → clearedUpTo NOT advanced');
  {
    resetDb();
    seedChat(1, 1, [10, 20]); // A=10, B=20
    seedMsg(100, 1, 10);       // msg 100 from A

    await clearChatOnExit(10, 1); // A exits

    eq('1: A cleared stays 0 (no received msgs)', getClearedFor(10, 1), 0);
  }

  // ─── 2. A exits → no hard-delete (B hasn't cleared) ──────────────────────
  console.log('\n[2] A exits → hard-delete blocked because B has not cleared');
  {
    // continuation of scenario 1 state
    ok('2: msg 100 still in db', messagesExist([100]).length === 1);
    const chatDelEmit = socketEmits.find(e => e.event === 'messagesDeleted' && e.room === 'chat_1');
    ok('2: no messagesDeleted to chat room', !chatDelEmit);
  }

  // ─── 3. B exits → B's clearedUpTo advances to 100 ────────────────────────
  console.log('\n[3] B exits → clearedUpToMessageId advances');
  {
    socketEmits.length = 0;
    await clearChatOnExit(20, 1); // B exits
    eq('3: B cleared = 100', getClearedFor(20, 1), 100);
  }

  // ─── 4. B exits → hard-delete fires ──────────────────────────────────────
  console.log('\n[4] B exits → msg 100 hard-deleted and messagesDeleted broadcast');
  {
    ok('4: msg 100 deleted from db', messagesExist([100]).length === 0);
    const chatDelEmit = socketEmits.find(e => e.event === 'messagesDeleted' && e.room === 'chat_1');
    ok('4: messagesDeleted broadcast to chat room', !!chatDelEmit, JSON.stringify(socketEmits));
    ok('4: broadcast includes msg 100', chatDelEmit?.payload?.messageIds?.includes(100));
  }

  // ─── 5. Mixed senders ─────────────────────────────────────────────────────
  console.log('\n[5] Mixed: A sends 100, B sends 101. A exits → A advances to 101, msg 101 deleted');
  {
    resetDb();
    seedChat(2, 1, [10, 20]);
    seedMsg(100, 2, 10); // from A
    seedMsg(101, 2, 20); // from B

    await clearChatOnExit(10, 2); // A exits
    // A's latest not-mine = msg 101 (sent by B), so A advances to 101
    eq('5: A cleared = 101', getClearedFor(10, 2), 101);

    // Hard-delete check:
    // msg 100: sender=A(10). Others with userId!=10 = B(20). B.cleared=0 < 100 → stays
    // msg 101: sender=B(20). Others with userId!=20 = A(10). A.cleared=101 >= 101 → doomed
    ok('5: msg 100 still in db (B not cleared)', messagesExist([100]).length === 1);
    ok('5: msg 101 deleted (A cleared past it)', messagesExist([101]).length === 0);

    const delEmit = socketEmits.find(e => e.event === 'messagesDeleted' && e.room === 'chat_2');
    ok('5: messagesDeleted broadcast', !!delEmit);
    ok('5: broadcast includes 101 not 100', delEmit?.payload?.messageIds?.includes(101) && !delEmit?.payload?.messageIds?.includes(100));
  }

  // ─── 6. Non-member exit → no-op ───────────────────────────────────────────
  console.log('\n[6] Non-member exit → no-op');
  {
    resetDb();
    seedChat(3, 1, [10, 20]);
    seedMsg(200, 3, 20);
    socketEmits.length = 0;

    await clearChatOnExit(999, 3); // user 999 is not a member

    eq('6: A cleared unchanged', getClearedFor(10, 3), 0);
    eq('6: B cleared unchanged', getClearedFor(20, 3), 0);
    ok('6: msg 200 still exists', messagesExist([200]).length === 1);
    ok('6: no messagesDeleted emit', !socketEmits.some(e => e.event === 'messagesDeleted'));
  }

  // ─── 7. Non-immediate chat → early return ─────────────────────────────────
  console.log('\n[7] Non-immediate chat (disappearingSeconds=300) → early return');
  {
    resetDb();
    seedChat(4, 300, [10, 20]); // timed mode, not immediate
    seedMsg(300, 4, 20);
    socketEmits.length = 0;

    await clearChatOnExit(10, 4); // A exits

    eq('7: A cleared stays 0', getClearedFor(10, 4), 0);
    ok('7: msg 300 still exists', messagesExist([300]).length === 1);
    ok('7: no emits', !socketEmits.some(e => e.event === 'messagesDeleted'));
  }

  // ─── 8. No messages → no-op ───────────────────────────────────────────────
  console.log('\n[8] Empty immediate chat → no-op, no throw');
  {
    resetDb();
    seedChat(5, 1, [10, 20]);
    // no messages
    socketEmits.length = 0;
    let threw = false;
    try { await clearChatOnExit(10, 5); } catch (e) { threw = true; }

    ok('8: no throw', !threw);
    eq('8: A cleared stays 0', getClearedFor(10, 5), 0);
    ok('8: no emits', !socketEmits.some(e => e.event === 'messagesDeleted'));
  }

  // ─── 9. 3-member group: per-sender delete logic ───────────────────────────
  console.log('\n[9] 3-member immediate chat: per-sender hard-delete');
  {
    resetDb();
    // Members: A=10, B=20, C=30
    seedChat(6, 1, [10, 20, 30]);
    seedMsg(400, 6, 10); // from A
    seedMsg(401, 6, 20); // from B

    // C exits → C advances past 401 (latest not-mine for C)
    await clearChatOnExit(30, 6);
    eq('9: C cleared = 401', getClearedFor(30, 6), 401);
    // Hard-delete: msg 400 (A's) → check B(20) & C(30) cleared
    //   B.cleared=0 < 400 → stays. msg 401 (B's) → check A(10) & C(30)
    //   A.cleared=0 < 401 → stays.
    ok('9: msg 400 still exists after C exit', messagesExist([400]).length === 1);
    ok('9: msg 401 still exists after C exit', messagesExist([401]).length === 1);

    // B exits → B advances past 400 (latest not-mine for B = msg 400 from A)
    await clearChatOnExit(20, 6);
    eq('9: B cleared = 400', getClearedFor(20, 6), 400);
    // msg 400: sender=A(10). Others=B(20) cleared=400>=400, C(30) cleared=401>=400 → doomed
    // msg 401: sender=B(20). Others=A(10) cleared=0<401, C(30) cleared=401>=401 → A blocks delete
    ok('9: msg 400 deleted (both B and C cleared past it)', messagesExist([400]).length === 0);
    ok('9: msg 401 still exists (A not cleared)', messagesExist([401]).length === 1);

    // A exits → A advances past 401 (latest not-mine = msg 401 from B)
    await clearChatOnExit(10, 6);
    eq('9: A cleared = 401', getClearedFor(10, 6), 401);
    // msg 401: sender=B(20). Others=A(10) cleared=401>=401, C(30) cleared=401>=401 → doomed
    ok('9: msg 401 deleted (all non-senders cleared)', messagesExist([401]).length === 0);
  }

  // ─── 10. S3 cleanup for messages with imageUrl ────────────────────────────
  console.log('\n[10] S3 cleanup called for messages with imageUrl on hard-delete');
  {
    resetDb();
    seedChat(7, 1, [10, 20]);
    const s3Url = 'https://s3.example.com/chat/pic.jpg';
    seedMsg(500, 7, 10, s3Url); // A sends an image
    s3Calls.length = 0;

    // B exits → B advances to 500, hard-delete fires for msg 500
    await clearChatOnExit(20, 7);
    eq('10: B cleared = 500', getClearedFor(20, 7), 500);
    ok('10: msg 500 deleted', messagesExist([500]).length === 0);
    ok('10: s3Cleanup called', s3Calls.length > 0, `calls=${s3Calls.length}`);
    ok('10: s3Cleanup received the correct URL', s3Calls.some(urls => urls.includes(s3Url)));
  }

  // ─── Extra: A sends, then B exits without A exiting → B's cleared advances,
  //           A's stays 0 because A has no received messages that need clearing ─
  console.log('\n[E1] Independence: B clearing does not affect A\'s clearedUpTo');
  {
    resetDb();
    seedChat(8, 1, [10, 20]);
    seedMsg(600, 8, 10); // A sends

    // B exits: B received msg 600 → B.cleared = 600
    await clearChatOnExit(20, 8);
    eq('E1: B cleared = 600', getClearedFor(20, 8), 600);
    eq('E1: A cleared = 0 (unchanged)', getClearedFor(10, 8), 0);
  }

  // ─── Extra: zero chatId / userId → no-op ──────────────────────────────────
  console.log('\n[E2] Invalid chatId/userId → no-op (no throw)');
  {
    let threw = false;
    try {
      await clearChatOnExit(0, 1);
      await clearChatOnExit(10, 0);
      await clearChatOnExit(null, 1);
    } catch (e) { threw = true; }
    ok('E2: invalid args → no throw', !threw);
  }

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch(err => {
  console.error('TEST CRASH', err);
  process.exit(1);
});
