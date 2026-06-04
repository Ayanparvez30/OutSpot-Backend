#!/usr/bin/env node
/**
 * Test: friend-request → chat-list end-to-end flow
 *
 * Strategy: call controllers directly with mock req/res objects.
 * No HTTP server required. Uses the real DB — seeds and tears down its
 * own fixtures in a try/finally block.
 *
 * Scenario:
 *   1. Seed users A and B.
 *   2. Create a PENDING friendship (A → B).
 *   3. Accept via acceptFriendRequest (as B).
 *   4. Assert: chatId returned, friendship ACCEPTED, Chat row exists,
 *      exactly 2 UserOnChat rows, zero messages.
 *   5. Assert: chat appears in getMyChats for both A and B.
 *   6. Dedupe check: simulate second accept path — confirm only 1 chat.
 *   7. Unfriend as A.
 *   8. Assert: deletedChatIds contains chatId, Chat+UserOnChat+Friendship gone.
 *   9. Teardown: verify DB returns to baseline counts.
 *
 * Usage:
 *   node tests/friend-chat-flow.test.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

// Import controllers under test
const { acceptFriendRequest, unfriend } = require('../controllers/friendController');
const { getMyChats } = require('../controllers/chatController');

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function assertEq(actual, expected, label) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    const detail = `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`;
    failures.push(detail);
    console.log(`  FAIL  ${detail}`);
  }
}

/**
 * Build a minimal mock req/res pair.
 * Returns { req, res, result } where result is a Promise that resolves to
 * { status, json } once the controller calls res.json() or res.status().json().
 */
function mockReqRes({ userId, params = {}, body = {} }) {
  let resolveFn;
  const result = new Promise((resolve) => { resolveFn = resolve; });

  const res = {
    _status: 200,
    status(code) {
      this._status = code;
      return this;
    },
    json(payload) {
      resolveFn({ status: this._status, json: payload });
      return this;
    },
  };

  const req = {
    authData: { id: userId },
    params,
    body,
  };

  return { req, res, result };
}

// ── Seeded IDs (populated during seed()) ────────────────────────────────────

const ctx = {
  userA: null,  // requester
  userB: null,  // receiver / acceptor
};

// ── Baseline counts (recorded before seed, verified after teardown) ──────────

const baseline = {
  users: 0,
  communities: 0,
  members: 0,
  chats: 0,
  friendships: 0,
  messages: 0,
  userOnChat: 0,
};

// ── Seed / Teardown ──────────────────────────────────────────────────────────

async function recordBaseline() {
  const [users, communities, members, chats, friendships, messages, userOnChat] =
    await Promise.all([
      prisma.user.count(),
      prisma.community.count(),
      prisma.communityMember.count(),
      prisma.chat.count(),
      prisma.friendship.count(),
      prisma.message.count(),
      prisma.userOnChat.count(),
    ]);

  Object.assign(baseline, { users, communities, members, chats, friendships, messages, userOnChat });
  console.log(
    `[BASELINE] users:${users} communities:${communities} members:${members} ` +
    `chats:${chats} friendships:${friendships} messages:${messages} userOnChat:${userOnChat}`
  );
}

async function seed() {
  const hash = await bcrypt.hash('TestPass!1', 10);

  const userA = await prisma.user.create({
    data: {
      username: 'test-friendchat-userA',
      email: 'test-friendchat-userA@example.com',
      password: hash,
      authorization: 'test-friendchat-userA-token-abc111',
    },
  });
  ctx.userA = userA;

  const userB = await prisma.user.create({
    data: {
      username: 'test-friendchat-userB',
      email: 'test-friendchat-userB@example.com',
      password: hash,
      authorization: 'test-friendchat-userB-token-xyz222',
    },
  });
  ctx.userB = userB;

  console.log(`[SEED] userA.id=${ctx.userA.id}  userB.id=${ctx.userB.id}`);
}

async function teardown() {
  // Collect any chats created between our two test users (in case assertions
  // failed before the unfriend step cleaned them up).
  const leftoverChats = await prisma.chat.findMany({
    where: {
      isGroup: false,
      isCommunity: false,
      AND: [
        { users: { some: { userId: ctx.userA.id } } },
        { users: { some: { userId: ctx.userB.id } } },
      ],
    },
    select: { id: true },
  });
  const leftoverChatIds = leftoverChats.map(c => c.id);

  if (leftoverChatIds.length > 0) {
    // Messages are cascade-deleted with Chat, but let's be explicit with
    // userOnChat first in case the DB has restrict constraints.
    await prisma.userOnChat.deleteMany({ where: { chatId: { in: leftoverChatIds } } });
    await prisma.message.deleteMany({ where: { chatId: { in: leftoverChatIds } } });
    await prisma.chat.deleteMany({ where: { id: { in: leftoverChatIds } } });
  }

  // Clean up any residual friendship rows
  if (ctx.userA && ctx.userB) {
    await prisma.friendship.deleteMany({
      where: {
        OR: [
          { requesterId: ctx.userA.id, receiverId: ctx.userB.id },
          { requesterId: ctx.userB.id, receiverId: ctx.userA.id },
        ],
      },
    });
  }

  // Remove test users (cascade deletes related rows)
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [
          'test-friendchat-userA@example.com',
          'test-friendchat-userB@example.com',
        ],
      },
    },
  });

  console.log('[TEARDOWN] Seeded fixtures removed.');
}

// ── Test runner ───────────────────────────────────────────────────────────────

async function run() {
  await recordBaseline();
  await seed();

  let chatId = null; // populated in step 3, re-used throughout

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // STEP 2: Create a PENDING friendship (A → B)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Step 2: create PENDING friendship A → B ---');
    const friendship = await prisma.friendship.create({
      data: {
        requesterId: ctx.userA.id,
        receiverId: ctx.userB.id,
        status: 'PENDING',
      },
    });
    assert(friendship.id > 0, 'Friendship row created with an id');
    assertEq(friendship.status, 'PENDING', 'Friendship status is PENDING');
    assertEq(friendship.requesterId, ctx.userA.id, 'Friendship requesterId = userA');
    assertEq(friendship.receiverId, ctx.userB.id, 'Friendship receiverId = userB');

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 3: Accept friend request AS USER B (receiver)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Step 3: acceptFriendRequest as B ---');
    const { req: acceptReq, res: acceptRes, result: acceptResult } = mockReqRes({
      userId: ctx.userB.id,
      params: { userId: String(ctx.userA.id) },
    });
    acceptFriendRequest(acceptReq, acceptRes);
    const acceptResponse = await acceptResult;

    console.log(`  [Response] status=${acceptResponse.status} json=${JSON.stringify(acceptResponse.json)}`);

    assertEq(acceptResponse.status, 200, 'acceptFriendRequest returns HTTP 200');
    assert(
      acceptResponse.json && typeof acceptResponse.json.chatId === 'number',
      'Response contains a numeric chatId'
    );

    if (acceptResponse.json && typeof acceptResponse.json.chatId === 'number') {
      chatId = acceptResponse.json.chatId;
      console.log(`  [INFO] chatId = ${chatId}`);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 4: Assert post-accept state
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Step 4: assertions after accept ---');

    // 4a: Friendship status is ACCEPTED
    const updatedFriendship = await prisma.friendship.findFirst({
      where: { requesterId: ctx.userA.id, receiverId: ctx.userB.id },
    });
    assert(updatedFriendship !== null, 'Friendship row still exists after accept');
    assertEq(updatedFriendship?.status, 'ACCEPTED', 'Friendship status is ACCEPTED');

    // 4b: Chat row exists with isGroup=false, isCommunity=false
    if (chatId !== null) {
      const chatRow = await prisma.chat.findUnique({
        where: { id: chatId },
        include: {
          users: true,
          messages: true,
        },
      });

      assert(chatRow !== null, 'Chat row exists in DB');
      assertEq(chatRow?.isGroup, false, 'Chat.isGroup = false');
      assertEq(chatRow?.isCommunity, false, 'Chat.isCommunity = false');

      // 4c: Exactly 2 UserOnChat rows, both ADMIN
      assertEq(chatRow?.users.length, 2, 'Chat has exactly 2 UserOnChat rows');

      const userIds = chatRow?.users.map(u => u.userId).sort();
      const expectedIds = [ctx.userA.id, ctx.userB.id].sort();
      assert(
        JSON.stringify(userIds) === JSON.stringify(expectedIds),
        `UserOnChat rows are for userA (${ctx.userA.id}) and userB (${ctx.userB.id})`
      );

      const roles = chatRow?.users.map(u => u.role);
      assert(
        roles.every(r => r === 'ADMIN'),
        'Both UserOnChat rows have role ADMIN'
      );

      // 4d: ZERO messages (critical: no system message, no welcome message)
      assertEq(chatRow?.messages.length, 0, 'Chat has ZERO messages (no message was sent)');
    } else {
      // chatId was null — the accept response didn't return one; mark remaining chat assertions as failed
      ['Chat row exists in DB', 'Chat.isGroup = false', 'Chat.isCommunity = false',
       'Chat has exactly 2 UserOnChat rows',
       `UserOnChat rows are for userA and userB`,
       'Both UserOnChat rows have role ADMIN',
       'Chat has ZERO messages (no message was sent)',
      ].forEach(label => {
        failed++;
        failures.push(`${label} [skipped — chatId was null]`);
        console.log(`  FAIL  ${label} [skipped — chatId was null]`);
      });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 5: Chat appears in getMyChats for BOTH A and B
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Step 5: getMyChats for A and B ---');

    if (chatId !== null) {
      // getMyChats for user A
      const { req: chatsReqA, res: chatsResA, result: chatsResultA } = mockReqRes({
        userId: ctx.userA.id,
      });
      getMyChats(chatsReqA, chatsResA);
      const chatsResponseA = await chatsResultA;

      assert(
        Array.isArray(chatsResponseA.json) &&
          chatsResponseA.json.some(c => c.id === chatId),
        `getMyChats for userA includes chatId=${chatId}`
      );

      // getMyChats for user B
      const { req: chatsReqB, res: chatsResB, result: chatsResultB } = mockReqRes({
        userId: ctx.userB.id,
      });
      getMyChats(chatsReqB, chatsResB);
      const chatsResponseB = await chatsResultB;

      assert(
        Array.isArray(chatsResponseB.json) &&
          chatsResponseB.json.some(c => c.id === chatId),
        `getMyChats for userB includes chatId=${chatId}`
      );
    } else {
      ['getMyChats for userA includes chatId', 'getMyChats for userB includes chatId']
        .forEach(label => {
          failed++;
          failures.push(`${label} [skipped — chatId was null]`);
          console.log(`  FAIL  ${label} [skipped — chatId was null]`);
        });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 6: Dedupe check — simulate second accept path
    // We delete the ACCEPTED friendship and re-create it as PENDING, then
    // call acceptFriendRequest a second time. The controller must return the
    // same chatId (no new chat created).
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Step 6: dedupe check (second accept) ---');

    if (chatId !== null) {
      // Prepare: re-set friendship to PENDING so the controller finds it
      await prisma.friendship.updateMany({
        where: { requesterId: ctx.userA.id, receiverId: ctx.userB.id },
        data: { status: 'PENDING', acceptedAt: null },
      });

      const { req: dedupeReq, res: dedupeRes, result: dedupeResult } = mockReqRes({
        userId: ctx.userB.id,
        params: { userId: String(ctx.userA.id) },
      });
      acceptFriendRequest(dedupeReq, dedupeRes);
      const dedupeResponse = await dedupeResult;

      console.log(`  [Dedupe Response] status=${dedupeResponse.status} json=${JSON.stringify(dedupeResponse.json)}`);

      assertEq(dedupeResponse.status, 200, 'Second accept returns HTTP 200');
      assertEq(
        dedupeResponse.json?.chatId,
        chatId,
        `Second accept returns the same chatId (${chatId}) — no duplicate created`
      );

      // Verify there is still exactly one 2-person private chat between A and B
      const allPrivateChats = await prisma.chat.findMany({
        where: {
          isGroup: false,
          isCommunity: false,
          AND: [
            { users: { some: { userId: ctx.userA.id } } },
            { users: { some: { userId: ctx.userB.id } } },
          ],
        },
        include: { _count: { select: { users: true } } },
      });
      const exactTwoUserChats = allPrivateChats.filter(c => c._count.users === 2);
      assertEq(
        exactTwoUserChats.length,
        1,
        'Still exactly one 2-person private chat after second accept (no duplicate)'
      );
    } else {
      [
        'Second accept returns HTTP 200',
        'Second accept returns the same chatId — no duplicate created',
        'Still exactly one 2-person private chat after second accept (no duplicate)',
      ].forEach(label => {
        failed++;
        failures.push(`${label} [skipped — chatId was null]`);
        console.log(`  FAIL  ${label} [skipped — chatId was null]`);
      });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 7: Unfriend AS USER A
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Step 7: unfriend as A ---');

    const { req: unfriendReq, res: unfriendRes, result: unfriendResult } = mockReqRes({
      userId: ctx.userA.id,
      params: { userId: String(ctx.userB.id) },
    });
    unfriend(unfriendReq, unfriendRes);
    const unfriendResponse = await unfriendResult;

    console.log(`  [Response] status=${unfriendResponse.status} json=${JSON.stringify(unfriendResponse.json)}`);

    assertEq(unfriendResponse.status, 200, 'unfriend returns HTTP 200');

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 8: Assert post-unfriend state
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Step 8: assertions after unfriend ---');

    // 8a: deletedChatIds includes our chatId
    if (chatId !== null) {
      assert(
        Array.isArray(unfriendResponse.json?.deletedChatIds) &&
          unfriendResponse.json.deletedChatIds.includes(chatId),
        `unfriend response deletedChatIds includes chatId=${chatId}`
      );
    } else {
      failed++;
      const label = 'unfriend response deletedChatIds includes chatId [skipped — chatId was null]';
      failures.push(label);
      console.log(`  FAIL  ${label}`);
    }

    // 8b: Chat row is GONE
    if (chatId !== null) {
      const chatAfterUnfriend = await prisma.chat.findUnique({ where: { id: chatId } });
      assert(chatAfterUnfriend === null, `Chat row (id=${chatId}) is deleted after unfriend`);
    }

    // 8c: UserOnChat rows are GONE
    if (chatId !== null) {
      const uocAfterUnfriend = await prisma.userOnChat.findMany({ where: { chatId } });
      assertEq(uocAfterUnfriend.length, 0, `All UserOnChat rows for chatId=${chatId} are deleted`);
    }

    // 8d: Friendship row is GONE
    const friendshipAfterUnfriend = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: ctx.userA.id, receiverId: ctx.userB.id },
          { requesterId: ctx.userB.id, receiverId: ctx.userA.id },
        ],
      },
    });
    assert(friendshipAfterUnfriend === null, 'Friendship row is deleted after unfriend');

  } finally {
    // ──────────────────────────────────────────────────────────────────────────
    // TEARDOWN + baseline verification
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Teardown ---');
    await teardown();

    console.log('\n--- Baseline verification ---');
    const [usersNow, communitiesNow, membersNow, chatsNow, friendshipsNow, messagesNow, userOnChatNow] =
      await Promise.all([
        prisma.user.count(),
        prisma.community.count(),
        prisma.communityMember.count(),
        prisma.chat.count(),
        prisma.friendship.count(),
        prisma.message.count(),
        prisma.userOnChat.count(),
      ]);

    console.log(
      `[POST-TEARDOWN] users:${usersNow} communities:${communitiesNow} members:${membersNow} ` +
      `chats:${chatsNow} friendships:${friendshipsNow} messages:${messagesNow} userOnChat:${userOnChatNow}`
    );

    assertEq(usersNow,       baseline.users,       'DB users count restored to baseline');
    assertEq(communitiesNow, baseline.communities,  'DB communities count restored to baseline');
    assertEq(membersNow,     baseline.members,      'DB communityMembers count restored to baseline');
    assertEq(chatsNow,       baseline.chats,        'DB chats count restored to baseline');
    assertEq(friendshipsNow, baseline.friendships,  'DB friendships count restored to baseline');
    assertEq(messagesNow,    baseline.messages,      'DB messages count restored to baseline');
    assertEq(userOnChatNow,  baseline.userOnChat,   'DB userOnChat count restored to baseline');

    await prisma.$disconnect();

    // ── Final report ────────────────────────────────────────────────────────
    const total = passed + failed;
    console.log('\n════════════════════════════════════════════════════════');
    console.log(`  Test Results: ${passed}/${total} passed`);
    console.log(`  Passed : ${passed}`);
    console.log(`  Failed : ${failed}`);
    console.log('════════════════════════════════════════════════════════');

    if (failures.length > 0) {
      console.log('\nFailed assertions:');
      failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    }

    process.exit(failed > 0 ? 1 : 0);
  }
}

run().catch(async (err) => {
  console.error('\n[FATAL] Unhandled error in test runner:', err);
  try { await teardown(); } catch (_) {}
  await prisma.$disconnect();
  process.exit(1);
});
