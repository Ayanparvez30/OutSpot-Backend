/**
 * Chat list ordering after disappearing messages.
 *
 * The NEW behaviour (post-refactor):
 *   _sortTime = max(latestMessage.createdAt, chat.updatedAt, joinedAt)
 *
 * Including chat.updatedAt keeps a chat pinned at the top even after the
 * latest message is scrubbed from the preview (e.g. message was cleared by
 * clearedUpToMessageId, or the latest message slot is null).
 *
 * Scenarios:
 *   1. getMyChats: latestMessage scrubbed → latestMessage = null, but
 *      chat.updatedAt keeps _sortTime → chat stays on top
 *   2. getMyChats: 3 chats with different updatedAt / joinedAt / latestMessage
 *      times → correct order: C(joinedAt=11am) > A(updatedAt=10am) > B(updatedAt=9am)
 *   3. getMyGroupChats: same updatedAt-based sort
 *   4. Regression: chats with no messages sort by joinedAt OR chat.updatedAt
 *   5. Regression: newly joined community (joinedAt > chat.updatedAt) → joinedAt wins
 *   6. _sortTime field stripped from response
 *
 * Pure stubs — no DB, no live socket.
 */

const path = require('path');

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// ─── Prisma stub ──────────────────────────────────────────────────────────────

const prismaClientPath = require.resolve('@prisma/client');

let chatRowsForTest = [];
const fakePrisma = {
  chat: {
    findMany: async () => chatRowsForTest,
  },
  userOnChat: { findMany: async () => [], findFirst: async () => null },
  message: { count: async () => 0, findMany: async () => [], groupBy: async () => [] },
  pointsLedger: { groupBy: async () => [], findMany: async () => [] },
  locationPoint: { findMany: async () => [] },
  user: { findMany: async () => [] },
  block: { findMany: async () => [] },
};

require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// ─── Other stubs ──────────────────────────────────────────────────────────────

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
const realtimePath = require.resolve('../utils/realtime');
require.cache[realtimePath] = {
  id: realtimePath, filename: realtimePath, loaded: true,
  exports: { toUser: () => {}, toUsers: () => {}, toGroup: () => {}, toCommunity: () => {}, toFriends: () => {} },
};
const socketPath = require.resolve('../utils/socket');
require.cache[socketPath] = {
  id: socketPath, filename: socketPath, loaded: true,
  exports: {
    getIO: () => ({ to: () => ({ emit: () => {} }) }),
    deleteOwnMessages: async () => [],
    clearChatOnExit: async () => {},
    sendPushToOfflineUsers: async () => {},
  },
};
const s3UploadPath = require.resolve('../utils/s3Upload');
require.cache[s3UploadPath] = {
  id: s3UploadPath, filename: s3UploadPath, loaded: true,
  exports: { materializeChatMedia: async (url) => url, default: async () => {} },
};
const s3CleanupPath = require.resolve('../utils/s3Cleanup');
require.cache[s3CleanupPath] = {
  id: s3CleanupPath, filename: s3CleanupPath, loaded: true,
  exports: { deleteS3IfOrphanBulk: async () => ({}) },
};

const chat = require('../controllers/chatController');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(userId) { return { authData: { id: userId } }; }
function makeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const NOW = new Date('2026-06-13T12:00:00.000Z').getTime();
const H = 60 * 60 * 1000;

/**
 * Build a chat row in the shape getMyChats expects from prisma.chat.findMany.
 * @param {object} opts
 *   id, isGroup, isCommunity, name,
 *   currentUserId, otherUserId,
 *   myJoinedAt  — ms since epoch for THIS user's joinedAt
 *   updatedAt   — ms for chat.updatedAt (= when last message bumped the chat)
 *   latestMsgAt — ms for the latest message createdAt (null = no messages)
 *   latestMsgId — id of latest message (required if latestMsgAt set)
 *   myCleared   — clearedUpToMessageId for currentUser (default 0)
 */
function chatRow({
  id,
  isGroup = false,
  isCommunity = false,
  name = null,
  currentUserId,
  otherUserId = 999,
  myJoinedAt,
  updatedAt,
  latestMsgAt = null,
  latestMsgId = null,
  myCleared = 0,
}) {
  const chatUpdatedAt = new Date(updatedAt !== undefined ? updatedAt : (latestMsgAt || myJoinedAt));
  return {
    id,
    name,
    isGroup,
    isCommunity,
    isLocked: false,
    communityId: isCommunity ? id : null,
    imageUrl: null,
    disappearingSeconds: null,
    updatedAt: chatUpdatedAt,
    createdAt: new Date(myJoinedAt),
    createdById: currentUserId,
    users: [
      {
        userId: currentUserId,
        role: 'MEMBER',
        joinedAt: new Date(myJoinedAt),
        isMuted: false,
        lastSeenMessageId: null,
        lastDeliveredMessageId: null,
        clearedUpToMessageId: myCleared,
        user: {
          id: currentUserId,
          username: 'me',
          firstName: 'Me',
          lastName: '',
          totalPoints: 0,
          minime: [],
        },
      },
      {
        userId: otherUserId,
        role: 'MEMBER',
        joinedAt: new Date(myJoinedAt),
        isMuted: false,
        lastSeenMessageId: null,
        lastDeliveredMessageId: null,
        clearedUpToMessageId: 0,
        user: {
          id: otherUserId,
          username: `u${otherUserId}`,
          firstName: `User${otherUserId}`,
          lastName: '',
          totalPoints: 0,
          minime: [],
        },
      },
    ],
    messages: latestMsgAt
      ? [{ id: latestMsgId || id * 1000, content: 'hi', imageUrl: null, createdAt: new Date(latestMsgAt), senderId: otherUserId }]
      : [],
    _count: { messages: latestMsgAt ? 1 : 0 },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

(async () => {

  // ─── 1. Scrubbed latestMessage: chat stays on top via updatedAt ────────────
  console.log('\n[1] getMyChats: scrubbed latest message → updatedAt keeps chat on top');
  {
    // Chat A: updatedAt=NOW (message sent NOW but clearedUpTo=msgId → latestMessage=null)
    // Chat B: updatedAt=NOW-2h, latestMessage at NOW-2h
    const MSG_ID = 5000;
    chatRowsForTest = [
      chatRow({
        id: 100, currentUserId: 42, otherUserId: 1,
        myJoinedAt: NOW - 24 * H,
        updatedAt: NOW,                  // chat was updated right now (message sent)
        latestMsgAt: NOW, latestMsgId: MSG_ID,
        myCleared: MSG_ID,               // cleared past the latest message → latestMessage=null in response
      }),
      chatRow({
        id: 200, currentUserId: 42, otherUserId: 2,
        myJoinedAt: NOW - 24 * H,
        updatedAt: NOW - 2 * H,
        latestMsgAt: NOW - 2 * H, latestMsgId: 9000,
      }),
    ];

    const r = makeRes();
    await chat.getMyChats(makeReq(42), r);
    const body = r.body || [];
    const ids = body.map(c => c.id);

    eq('1: 2 chats returned', body.length, 2);
    eq('1: scrubbed chat (100) still on top', ids[0], 100);
    eq('1: visible-msg chat (200) below', ids[1], 200);

    const scrubbed = body.find(c => c.id === 100);
    ok('1: latestMessage is null for scrubbed chat', scrubbed?.latestMessage === null,
      `got=${JSON.stringify(scrubbed?.latestMessage)}`);
  }

  // ─── 2. Three-chat ordering: C(joinedAt=11am) > A(updatedAt=10am) > B(updatedAt=9am) ──
  console.log('\n[2] getMyChats: 3-chat ordering with mixed updatedAt / joinedAt');
  {
    // Chat A: updatedAt=10am, latestMsg=10am, joinedAt=yesterday
    // Chat B: updatedAt=9am,  latestMsg=9am,  joinedAt=yesterday
    // Chat C: no messages, joinedAt=11am (brand-new friend accept)
    // Expected: C(11am) > A(10am) > B(9am)
    const T10 = new Date('2026-06-13T10:00:00.000Z').getTime();
    const T9  = new Date('2026-06-13T09:00:00.000Z').getTime();
    const T11 = new Date('2026-06-13T11:00:00.000Z').getTime();
    const YESTERDAY = NOW - 24 * H;

    chatRowsForTest = [
      chatRow({ id: 300, currentUserId: 42, otherUserId: 3, myJoinedAt: YESTERDAY, updatedAt: T10, latestMsgAt: T10, latestMsgId: 3001 }),
      chatRow({ id: 400, currentUserId: 42, otherUserId: 4, myJoinedAt: YESTERDAY, updatedAt: T9,  latestMsgAt: T9,  latestMsgId: 4001 }),
      chatRow({ id: 500, currentUserId: 42, otherUserId: 5, myJoinedAt: T11,       updatedAt: T11, latestMsgAt: null }),
    ];

    const r = makeRes();
    await chat.getMyChats(makeReq(42), r);
    const ids = (r.body || []).map(c => c.id);

    eq('2: 3 chats returned', (r.body || []).length, 3);
    eq('2: C (joinedAt=11am, id=500) is first',  ids[0], 500);
    eq('2: A (updatedAt=10am, id=300) is second', ids[1], 300);
    eq('2: B (updatedAt=9am,  id=400) is third',  ids[2], 400);
  }

  // ─── 3. getMyGroupChats: same updatedAt-based sort ────────────────────────
  console.log('\n[3] getMyGroupChats: updatedAt + joinedAt sort');
  {
    const T_OLD_MSG  = NOW - 1 * H;     // group 1: last msg 1h ago
    const T_JOIN_NEW = NOW - 5 * 60 * 1000; // group 2: just joined 5 min ago, no msgs

    chatRowsForTest = [
      chatRow({ id: 700, isGroup: true, name: 'Old Group', currentUserId: 42, otherUserId: 30,
        myJoinedAt: NOW - 30 * 24 * H, updatedAt: T_OLD_MSG, latestMsgAt: T_OLD_MSG, latestMsgId: 7001 }),
      chatRow({ id: 800, isGroup: true, name: 'Just Joined', currentUserId: 42, otherUserId: 31,
        myJoinedAt: T_JOIN_NEW, updatedAt: T_JOIN_NEW, latestMsgAt: null }),
    ];

    const r = makeRes();
    await chat.getMyGroupChats(makeReq(42), r);
    const ids = (r.body || []).map(c => c.id);

    eq('3: 2 group chats returned', (r.body || []).length, 2);
    eq('3: freshly joined (800) on top', ids[0], 800);
    eq('3: old group with recent msg (700) below', ids[1], 700);
    ok('3: _sortTime stripped from group chats', !('_sortTime' in ((r.body || [])[0] || {})));
  }

  // ─── 4. Regression: no-message chats sort by joinedAt / updatedAt ─────────
  console.log('\n[4] Regression: chats with no messages sort by joinedAt or chat.updatedAt');
  {
    const T_EARLY = NOW - 5 * H;
    const T_LATE  = NOW - 1 * H;

    chatRowsForTest = [
      chatRow({ id: 900, currentUserId: 42, otherUserId: 40, myJoinedAt: T_EARLY, updatedAt: T_EARLY, latestMsgAt: null }),
      chatRow({ id: 901, currentUserId: 42, otherUserId: 41, myJoinedAt: T_LATE,  updatedAt: T_LATE,  latestMsgAt: null }),
    ];

    const r = makeRes();
    await chat.getMyChats(makeReq(42), r);
    const ids = (r.body || []).map(c => c.id);

    eq('4: later-joined (901) on top', ids[0], 901);
    eq('4: earlier-joined (900) below', ids[1], 900);
  }

  // ─── 5. Regression: newly joined → joinedAt beats older chat.updatedAt ────
  console.log('\n[5] Regression: joinedAt > chat.updatedAt → joinedAt wins');
  {
    // User just joined a community that had activity 3 hours ago.
    // joinedAt=NOW (very fresh), chat.updatedAt=NOW-3h, latestMsgAt=NOW-3h
    // _sortTime should = joinedAt = NOW
    const T_OLD_ACTIVITY = NOW - 3 * H;

    chatRowsForTest = [
      chatRow({ id: 1000, isCommunity: true, currentUserId: 42, otherUserId: 50,
        myJoinedAt: NOW,           // just joined
        updatedAt: T_OLD_ACTIVITY,
        latestMsgAt: T_OLD_ACTIVITY, latestMsgId: 10001 }),
      chatRow({ id: 1001, currentUserId: 42, otherUserId: 51,
        myJoinedAt: NOW - 2 * H,   // joined 2h ago, active 30m ago
        updatedAt: NOW - 30 * 60 * 1000,
        latestMsgAt: NOW - 30 * 60 * 1000, latestMsgId: 10011 }),
    ];

    const r = makeRes();
    await chat.getMyChats(makeReq(42), r);
    const ids = (r.body || []).map(c => c.id);

    eq('5: brand-new join (1000, joinedAt=NOW) on top', ids[0], 1000);
    eq('5: active chat (1001, updatedAt=30m ago) below', ids[1], 1001);
  }

  // ─── 6. _sortTime is stripped from response ────────────────────────────────
  console.log('\n[6] _sortTime stripped from both getMyChats and getMyGroupChats');
  {
    chatRowsForTest = [
      chatRow({ id: 1100, currentUserId: 42, otherUserId: 60, myJoinedAt: NOW - H, updatedAt: NOW - H, latestMsgAt: null }),
    ];

    const r1 = makeRes();
    await chat.getMyChats(makeReq(42), r1);
    ok('6a: _sortTime absent from getMyChats', !('_sortTime' in ((r1.body || [])[0] || {})));

    chatRowsForTest = [
      chatRow({ id: 1200, isGroup: true, name: 'G', currentUserId: 42, otherUserId: 61, myJoinedAt: NOW - H, updatedAt: NOW - H, latestMsgAt: null }),
    ];
    const r2 = makeRes();
    await chat.getMyGroupChats(makeReq(42), r2);
    ok('6b: _sortTime absent from getMyGroupChats', !('_sortTime' in ((r2.body || [])[0] || {})));
  }

  // ─── 7. getMyGroupChats: scrubbed latest message stays on top ─────────────
  console.log('\n[7] getMyGroupChats: scrubbed message → updatedAt keeps group on top');
  {
    const MSG_ID_G = 8000;
    chatRowsForTest = [
      chatRow({
        id: 1300, isGroup: true, name: 'Active', currentUserId: 42, otherUserId: 70,
        myJoinedAt: NOW - 24 * H,
        updatedAt: NOW,
        latestMsgAt: NOW, latestMsgId: MSG_ID_G,
        // Note: getMyGroupChats does NOT apply clearedUpToMessageId filtering to latestMessage
        // (that's only in getMyChats). So we test the sort anchor only.
      }),
      chatRow({
        id: 1400, isGroup: true, name: 'Quiet', currentUserId: 42, otherUserId: 71,
        myJoinedAt: NOW - 24 * H,
        updatedAt: NOW - 4 * H,
        latestMsgAt: NOW - 4 * H, latestMsgId: 9000,
      }),
    ];

    const r = makeRes();
    await chat.getMyGroupChats(makeReq(42), r);
    const ids = (r.body || []).map(c => c.id);

    eq('7: active group (1300, updatedAt=NOW) on top', ids[0], 1300);
    eq('7: quieter group (1400) below', ids[1], 1400);
  }

  // ─── 8. Tie-break: same updatedAt → stable order preserved ────────────────
  console.log('\n[8] Tie-break: same max _sortTime → both are returned (no crash)');
  {
    const SAME_T = NOW - 1 * H;
    chatRowsForTest = [
      chatRow({ id: 1500, currentUserId: 42, otherUserId: 80, myJoinedAt: SAME_T, updatedAt: SAME_T, latestMsgAt: null }),
      chatRow({ id: 1501, currentUserId: 42, otherUserId: 81, myJoinedAt: SAME_T, updatedAt: SAME_T, latestMsgAt: null }),
    ];

    const r = makeRes();
    await chat.getMyChats(makeReq(42), r);
    eq('8: 2 chats returned without crash', (r.body || []).length, 2);
  }

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch(err => {
  console.error('TEST CRASH', err);
  process.exit(1);
});
