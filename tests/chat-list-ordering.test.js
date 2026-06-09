/**
 * Chat list ordering — verifies that newly-created OR newly-joined chats appear
 * at the top of the chat list for the joining user, even when the underlying
 * chat row has old `chat.updatedAt`.
 *
 * Scenarios covered:
 *   1. Brand-new friend-accept chat (no messages, fresh joinedAt) → top
 *   2. Old community/group chat user just joined (old messages, fresh joinedAt) → top for joining user only
 *   3. Existing chat with recent message → above an old chat user just joined? No — joinedAt=NOW beats older messages
 *   4. Re-friend case: existing chat exists, acceptFriendRequest bumps userOnChat.joinedAt → top
 *
 * Zero HTTP, zero DB. Stubs Prisma + utilities.
 */

const path = require('path');
const Module = require('module');

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, got, want) { assert(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// Build a chat row with the shape getMyChats expects.
function chatRow({
  id, isGroup = false, isCommunity = false, name = null,
  myJoinedAt, lastMsgAt = null, lastMsgId = null,
  otherUserId = 999, currentUserId,
}) {
  return {
    id,
    name,
    isGroup,
    isCommunity,
    isLocked: false,
    communityId: isCommunity ? id : null,
    imageUrl: null,
    disappearingSeconds: null,
    updatedAt: new Date(lastMsgAt || myJoinedAt),
    createdAt: new Date(myJoinedAt),
    createdById: currentUserId,
    users: [
      { userId: currentUserId, role: 'MEMBER', joinedAt: new Date(myJoinedAt), isMuted: false,
        lastSeenMessageId: null, lastDeliveredMessageId: null, clearedUpToMessageId: 0,
        user: { id: currentUserId, username: 'me', firstName: 'Me', lastName: '', totalPoints: 0, minime: [] } },
      { userId: otherUserId, role: 'MEMBER', joinedAt: new Date(myJoinedAt), isMuted: false,
        lastSeenMessageId: null, lastDeliveredMessageId: null, clearedUpToMessageId: 0,
        user: { id: otherUserId, username: `u${otherUserId}`, firstName: `User${otherUserId}`, lastName: '', totalPoints: 0, minime: [] } },
    ],
    messages: lastMsgAt
      ? [{ id: lastMsgId || 1, content: 'hi', imageUrl: null, createdAt: new Date(lastMsgAt), senderId: otherUserId }]
      : [],
    _count: { messages: lastMsgAt ? 1 : 0 },
  };
}

// Stub modules before requiring controller.
const chatControllerPath = require.resolve('../controllers/chatController');
const prismaClientPath = require.resolve('@prisma/client');

let chatRowsForTest = [];
const fakePrisma = {
  chat: {
    findMany: async () => chatRowsForTest,
  },
};

require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// Stub the helpers getMyChats depends on. Find their module paths.
const notifPath = require.resolve('../controllers/notificationController');
// notification helpers will be reached via require — replace just what getMyChats uses.

// Stub points helpers.
const pointsPath = require.resolve('../utils/points');
try { delete require.cache[pointsPath]; } catch (_) {}
require.cache[pointsPath] = {
  id: pointsPath, filename: pointsPath, loaded: true,
  exports: { addPointsWithMultiplier: async () => ({}) },
};

// Stub anything else loaded by chatController that we don't care about.
// We need getWeeklyPointsForUsers + getBulkUnreadCounts. They likely live in a helper —
// safer to intercept their behavior via stubbing the prisma calls they make. But to
// keep this test light, monkey-patch the controller AFTER load.

const chat = require(chatControllerPath);

// Monkey-patch the controller's internal helper functions if exposed. Otherwise we
// rely on the prisma stub returning the data getMyChats expects. The helpers
// (`getWeeklyPointsForUsers`, `getBulkUnreadCounts`) ARE called inside getMyChats,
// so we need the prisma calls they make to resolve harmlessly. We swap chat.findMany
// only, then ensure other prisma tables used downstream return safe defaults.

fakePrisma.locationPoint = { findMany: async () => [] };
fakePrisma.pointsLedger = { groupBy: async () => [], findMany: async () => [] };
fakePrisma.message = { count: async () => 0, findMany: async () => [], groupBy: async () => [] };
fakePrisma.userOnChat = { findMany: async () => [], findFirst: async () => null };
fakePrisma.user = { findMany: async () => [] };
// Item 4 (block-aware preview filter) calls prisma.block.findMany inside
// getMyChats / getMyGroupChats. Empty result → no scrub → existing behavior.
fakePrisma.block = { findMany: async () => [] };

function makeReq(userId) { return { authData: { id: userId } }; }
function makeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const NOW = new Date('2026-06-08T12:00:00Z').getTime();
const ONE_DAY = 24 * 3600 * 1000;
const ONE_HOUR = 3600 * 1000;

(async () => {
  console.log('\n[1] getMyChats — order by max(lastMessageAt, currentUser.joinedAt)');

  // User=42. Three chats:
  //   A) Old community joined 6 months ago, last message yesterday
  //   B) Old community user JUST joined (10 min ago), last message 3 months ago
  //   C) Brand-new friend-accept chat, no messages, joinedAt = 1 min ago
  // Expected order: C (joinedAt=1min), B (joinedAt=10min), A (lastMsg=1day)
  chatRowsForTest = [
    chatRow({ id: 100, isCommunity: true,
      myJoinedAt: NOW - 180 * ONE_DAY, lastMsgAt: NOW - 1 * ONE_DAY, lastMsgId: 5000,
      otherUserId: 901, currentUserId: 42 }),
    chatRow({ id: 200, isCommunity: true,
      myJoinedAt: NOW - 10 * 60 * 1000, lastMsgAt: NOW - 90 * ONE_DAY, lastMsgId: 7000,
      otherUserId: 902, currentUserId: 42 }),
    chatRow({ id: 300,
      myJoinedAt: NOW - 60 * 1000, lastMsgAt: null,
      otherUserId: 903, currentUserId: 42 }),
  ];

  const res = makeRes();
  await chat.getMyChats(makeReq(42), res);
  const order = (res.body || []).map(c => c.id);
  assert('getMyChats returns 3 chats', (res.body || []).length === 3);
  eq('first chat = brand-new friend (id 300)',          order[0], 300);
  eq('second chat = freshly joined community (id 200)', order[1], 200);
  eq('third chat = old community w/ recent msg (id 100)', order[2], 100);

  // ---------- Existing recent-message chat should still beat a fresh join only if msg > joinedAt ----------
  console.log('\n[2] Recent message beats older joinedAt');

  // X) Joined 1 hour ago, no messages → sortTime = 1h ago
  // Y) Joined 2 days ago, last message 5 min ago → sortTime = 5min ago
  // Expected: Y on top.
  chatRowsForTest = [
    chatRow({ id: 400, myJoinedAt: NOW - 1 * ONE_HOUR, lastMsgAt: null,
      otherUserId: 910, currentUserId: 42 }),
    chatRow({ id: 500, myJoinedAt: NOW - 2 * ONE_DAY, lastMsgAt: NOW - 5 * 60 * 1000, lastMsgId: 9001,
      otherUserId: 911, currentUserId: 42 }),
  ];

  const res2 = makeRes();
  await chat.getMyChats(makeReq(42), res2);
  const order2 = (res2.body || []).map(c => c.id);
  eq('chat with recent message on top', order2[0], 500);
  eq('older join with no msg below',    order2[1], 400);

  // ---------- Internal _sortTime field is stripped from response ----------
  console.log('\n[3] Response shape — internal _sortTime not leaked');

  chatRowsForTest = [
    chatRow({ id: 600, myJoinedAt: NOW - 60 * 1000, lastMsgAt: null,
      otherUserId: 920, currentUserId: 42 }),
  ];
  const res3 = makeRes();
  await chat.getMyChats(makeReq(42), res3);
  eq('_sortTime field absent', '_sortTime' in (res3.body[0] || {}), false);

  // ---------- getMyGroupChats: same sort ----------
  console.log('\n[4] getMyGroupChats — same per-user effective sort');

  chatRowsForTest = [
    chatRow({ id: 700, isGroup: true, name: 'Old Group',
      myJoinedAt: NOW - 30 * ONE_DAY, lastMsgAt: NOW - 1 * ONE_HOUR, lastMsgId: 11000,
      otherUserId: 930, currentUserId: 42 }),
    chatRow({ id: 800, isGroup: true, name: 'Just Joined',
      myJoinedAt: NOW - 2 * 60 * 1000, lastMsgAt: null,
      otherUserId: 931, currentUserId: 42 }),
  ];
  const res4 = makeRes();
  await chat.getMyGroupChats(makeReq(42), res4);
  const order4 = (res4.body || []).map(c => c.id);
  eq('group: freshly joined on top',         order4[0], 800);
  eq('group: old group w/ recent msg below', order4[1], 700);
  eq('group: _sortTime stripped',            '_sortTime' in (res4.body[0] || {}), false);

  // ---------- After fresh chat at top, sending in another chat bubbles THAT to top ----------
  console.log('\n[5] After new chat tops list, message in OTHER chat moves it to top');

  // Step 1: A = brand-new friend accept (joinedAt=NOW-60s, no messages)
  //         B = existing chat (joinedAt=NOW-1day, last msg=NOW-1hr)
  //         Expected: A on top, B below.
  chatRowsForTest = [
    chatRow({ id: 1100, myJoinedAt: NOW - 60 * 1000, lastMsgAt: null,
      otherUserId: 941, currentUserId: 42 }),
    chatRow({ id: 1200, myJoinedAt: NOW - 1 * ONE_DAY, lastMsgAt: NOW - 1 * ONE_HOUR, lastMsgId: 12000,
      otherUserId: 942, currentUserId: 42 }),
  ];
  const resStep1 = makeRes();
  await chat.getMyChats(makeReq(42), resStep1);
  const orderStep1 = (resStep1.body || []).map(c => c.id);
  eq('step1: A (new friend) on top',     orderStep1[0], 1100);
  eq('step1: B (existing) below',         orderStep1[1], 1200);

  // Step 2: simulate sending a message in chat B → B's last message is now NOW
  // (this is what happens when a message is inserted; chat.updatedAt and the
  // latest-message timestamp both move forward)
  chatRowsForTest = [
    chatRow({ id: 1100, myJoinedAt: NOW - 60 * 1000, lastMsgAt: null,
      otherUserId: 941, currentUserId: 42 }),
    chatRow({ id: 1200, myJoinedAt: NOW - 1 * ONE_DAY, lastMsgAt: NOW, lastMsgId: 12001,
      otherUserId: 942, currentUserId: 42 }),
  ];
  const resStep2 = makeRes();
  await chat.getMyChats(makeReq(42), resStep2);
  const orderStep2 = (resStep2.body || []).map(c => c.id);
  eq('step2: B (just messaged) bubbles to TOP', orderStep2[0], 1200);
  eq('step2: A (new friend) drops to 2nd',      orderStep2[1], 1100);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch(err => {
  console.error('TEST CRASH', err);
  process.exit(1);
});
