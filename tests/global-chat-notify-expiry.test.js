#!/usr/bin/env node
/**
 * Test: global-chat notification suppression + 12h message expiry
 *
 * Strategy: call sendTextMessage controller directly with mock req/res.
 * Uses the LIVE DB via Prisma. Stubs sendPushToOfflineUsers on the cached
 * require() module object — since the controller does:
 *   const { sendPushToOfflineUsers } = require("../utils/socket")
 * INSIDE the function on every call, replacing the property on the cached
 * module export is picked up at call-time.
 *
 * Seeds: 2 users, 1 personal chat, 1 group chat, 2 global chats.
 * Tears down in finally — verifies EXACT baseline restore.
 *
 * Usage:
 *   node tests/global-chat-notify-expiry.test.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

// Controller under test
const { sendTextMessage } = require('../controllers/chatController');

// Socket module whose export we will stub
const socketModule = require('../utils/socket');

// ── Test harness ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`  FAIL  ${msg}`);
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
 * Returns { req, res, result } where result resolves to { status, json }
 * once the controller calls res.json() or res.status().json().
 */
function mockReqRes({ userId, body = {} }) {
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
    body,
  };

  return { req, res, result };
}

// ── State ──────────────────────────────────────────────────────────────────────

const ctx = {
  u1: null,
  u2: null,
  personalChatId: null,
  groupChatId: null,
  globalMainChatId: null,
  globalRegionalChatId: null,
  // track all message IDs for teardown
  createdMessageIds: [],
};

const baseline = {
  users: 0,
  chats: 0,
  messages: 0,
  userOnChat: 0,
};

// ── Push spy ───────────────────────────────────────────────────────────────────

const pushCalls = []; // { chatId, args }
let originalPush;

function installPushSpy() {
  originalPush = socketModule.sendPushToOfflineUsers;
  socketModule.sendPushToOfflineUsers = function spySendPush(chatId, ...args) {
    pushCalls.push({ chatId, args });
  };
}

function restorePushSpy() {
  socketModule.sendPushToOfflineUsers = originalPush;
}

function pushCallCountForChat(chatId) {
  return pushCalls.filter(c => c.chatId === chatId).length;
}

// ── Baseline ───────────────────────────────────────────────────────────────────

async function recordBaseline() {
  const [users, chats, messages, userOnChat] = await Promise.all([
    prisma.user.count(),
    prisma.chat.count(),
    prisma.message.count(),
    prisma.userOnChat.count(),
  ]);
  Object.assign(baseline, { users, chats, messages, userOnChat });
  console.log(
    `[BASELINE] users:${users} chats:${chats} messages:${messages} userOnChat:${userOnChat}`
  );
}

// ── Seed ───────────────────────────────────────────────────────────────────────

async function seed() {
  const hash = await bcrypt.hash('TestPass!1', 10);

  ctx.u1 = await prisma.user.create({
    data: {
      username: 'test-globalnotif-u1',
      email: 'test-globalnotif-u1@example.com',
      password: hash,
      firstName: 'GlobalTest',
      lastName: 'UserOne',
    },
  });

  ctx.u2 = await prisma.user.create({
    data: {
      username: 'test-globalnotif-u2',
      email: 'test-globalnotif-u2@example.com',
      password: hash,
      firstName: 'GlobalTest',
      lastName: 'UserTwo',
    },
  });

  // Personal 1:1 chat (isGroup=false, isCommunity=false, name=null, communityId=null)
  const personalChat = await prisma.chat.create({
    data: {
      isGroup: false,
      isCommunity: false,
      communityId: null,
      name: null,
      disappearingSeconds: null,
      users: {
        create: [
          { userId: ctx.u1.id, role: 'ADMIN', lastSeenMessageId: 0 },
          { userId: ctx.u2.id, role: 'ADMIN', lastSeenMessageId: 0 },
        ],
      },
    },
  });
  ctx.personalChatId = personalChat.id;

  // Group chat (isGroup=true, isCommunity=false, name set, communityId=null)
  const groupChat = await prisma.chat.create({
    data: {
      isGroup: true,
      isCommunity: false,
      communityId: null,
      name: 'Test Group Chat',
      disappearingSeconds: null,
      users: {
        create: [
          { userId: ctx.u1.id, role: 'ADMIN', lastSeenMessageId: 0 },
          { userId: ctx.u2.id, role: 'MEMBER', lastSeenMessageId: 0 },
        ],
      },
    },
  });
  ctx.groupChatId = groupChat.id;

  // Main Global Chat (name="Global Chat", isCommunity=false, communityId=null)
  const globalMainChat = await prisma.chat.create({
    data: {
      isGroup: false,
      isCommunity: false,
      communityId: null,
      name: 'Global Chat',
      disappearingSeconds: null,
      users: {
        create: [
          { userId: ctx.u1.id, role: 'MEMBER', lastSeenMessageId: 0 },
        ],
      },
    },
  });
  ctx.globalMainChatId = globalMainChat.id;

  // Regional Global Chat (name="Global Chat - Boston", isCommunity=false, communityId=null)
  const globalRegionalChat = await prisma.chat.create({
    data: {
      isGroup: false,
      isCommunity: false,
      communityId: null,
      name: 'Global Chat - Boston',
      disappearingSeconds: null,
      users: {
        create: [
          { userId: ctx.u1.id, role: 'MEMBER', lastSeenMessageId: 0 },
        ],
      },
    },
  });
  ctx.globalRegionalChatId = globalRegionalChat.id;

  console.log(
    `[SEED] u1.id=${ctx.u1.id} u2.id=${ctx.u2.id} ` +
    `personalChatId=${ctx.personalChatId} groupChatId=${ctx.groupChatId} ` +
    `globalMainChatId=${ctx.globalMainChatId} globalRegionalChatId=${ctx.globalRegionalChatId}`
  );
}

// ── Teardown ───────────────────────────────────────────────────────────────────

async function teardown() {
  // Collect all chat IDs we created
  const chatIds = [
    ctx.personalChatId,
    ctx.groupChatId,
    ctx.globalMainChatId,
    ctx.globalRegionalChatId,
  ].filter(Boolean);

  // Also collect any messages the controller auto-created by membership upsert path
  // (controller may upsert userOnChat for global chats for non-members — we seeded
  // members but add a broad cleanup sweep by chatId)
  if (chatIds.length > 0) {
    await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.userOnChat.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
  }

  // Remove test users (cascade handles FK children not covered above)
  const testEmails = [
    'test-globalnotif-u1@example.com',
    'test-globalnotif-u2@example.com',
  ];
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });

  console.log('[TEARDOWN] Seeded fixtures removed.');
}

// ── Helper: invoke sendTextMessage and wait for response ──────────────────────

async function callSendTextMessage(userId, chatId, content) {
  const { req, res, result } = mockReqRes({
    userId,
    body: { chatId: String(chatId), content },
  });
  sendTextMessage(req, res);
  return result;
}

// ── Main test runner ───────────────────────────────────────────────────────────

async function run() {
  await recordBaseline();
  await seed();
  installPushSpy();

  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
  const ONE_MINUTE_MS = 60 * 1000;

  try {
    // ───────────────────────────────────────────────────────────────────────────
    // TEST 1: PERSONAL chat
    // Expected: success, expiresAt=null, push spy called once
    // ───────────────────────────────────────────────────────────────────────────
    console.log('\n--- Test 1: PERSONAL chat ---');

    const t1Before = pushCalls.length;
    const t1Resp = await callSendTextMessage(ctx.u1.id, ctx.personalChatId, 'hi from personal');
    console.log(`  [Response] status=${t1Resp.status} json=${JSON.stringify(t1Resp.json)}`);

    assertEq(t1Resp.status, 200, 'T1: personal chat response HTTP 200');
    assert(t1Resp.json?.success === true, 'T1: personal chat response success=true');

    const t1MsgId = t1Resp.json?.message?.id;
    assert(typeof t1MsgId === 'number', 'T1: personal chat response has message.id');

    if (t1MsgId) {
      const t1Msg = await prisma.message.findUnique({ where: { id: t1MsgId } });
      assertEq(t1Msg?.expiresAt, null, 'T1: personal chat message expiresAt is NULL');
      ctx.createdMessageIds.push(t1MsgId);
    }

    const t1PushAfter = pushCalls.length - t1Before;
    assert(
      t1PushAfter >= 1,
      'T1: personal chat — push spy WAS called at least once',
      `spy was called ${t1PushAfter} time(s)`
    );
    const t1PushForChat = pushCallCountForChat(ctx.personalChatId);
    assert(
      t1PushForChat >= 1,
      'T1: personal chat — push spy called with correct chatId',
      `spy called ${t1PushForChat} time(s) with chatId=${ctx.personalChatId}`
    );

    // ───────────────────────────────────────────────────────────────────────────
    // TEST 2: GROUP chat
    // Expected: success, expiresAt=null, push spy called
    // ───────────────────────────────────────────────────────────────────────────
    console.log('\n--- Test 2: GROUP chat ---');

    const t2Before = pushCalls.length;
    const t2Resp = await callSendTextMessage(ctx.u1.id, ctx.groupChatId, 'hi from group');
    console.log(`  [Response] status=${t2Resp.status} json=${JSON.stringify(t2Resp.json)}`);

    assertEq(t2Resp.status, 200, 'T2: group chat response HTTP 200');
    assert(t2Resp.json?.success === true, 'T2: group chat response success=true');

    const t2MsgId = t2Resp.json?.message?.id;
    assert(typeof t2MsgId === 'number', 'T2: group chat response has message.id');

    if (t2MsgId) {
      const t2Msg = await prisma.message.findUnique({ where: { id: t2MsgId } });
      assertEq(t2Msg?.expiresAt, null, 'T2: group chat message expiresAt is NULL');
      ctx.createdMessageIds.push(t2MsgId);
    }

    const t2PushForChat = pushCallCountForChat(ctx.groupChatId);
    assert(
      t2PushForChat >= 1,
      'T2: group chat — push spy WAS called with correct chatId',
      `spy called ${t2PushForChat} time(s) with chatId=${ctx.groupChatId}`
    );

    // ───────────────────────────────────────────────────────────────────────────
    // TEST 3: MAIN GLOBAL chat ("Global Chat")
    // Expected: success, expiresAt ~now+12h, push spy NOT called
    // ───────────────────────────────────────────────────────────────────────────
    console.log('\n--- Test 3: MAIN GLOBAL chat ---');

    const t3Before = Date.now();
    const t3PushBefore = pushCalls.length;
    const t3Resp = await callSendTextMessage(ctx.u1.id, ctx.globalMainChatId, 'hi from global main');
    const t3After = Date.now();
    console.log(`  [Response] status=${t3Resp.status} json=${JSON.stringify(t3Resp.json)}`);

    assertEq(t3Resp.status, 200, 'T3: global main chat response HTTP 200');
    assert(t3Resp.json?.success === true, 'T3: global main chat response success=true');

    const t3MsgId = t3Resp.json?.message?.id;
    assert(typeof t3MsgId === 'number', 'T3: global main chat response has message.id');

    if (t3MsgId) {
      const t3Msg = await prisma.message.findUnique({ where: { id: t3MsgId } });
      ctx.createdMessageIds.push(t3MsgId);

      assert(
        t3Msg?.expiresAt !== null && t3Msg?.expiresAt !== undefined,
        'T3: global main chat message expiresAt is NOT null'
      );

      if (t3Msg?.expiresAt) {
        const expiresMs = new Date(t3Msg.expiresAt).getTime();
        const lowerBound = t3Before + TWELVE_HOURS_MS - ONE_MINUTE_MS;
        const upperBound = t3After + TWELVE_HOURS_MS + ONE_MINUTE_MS;
        assert(
          expiresMs >= lowerBound && expiresMs <= upperBound,
          'T3: global main chat expiresAt is within [now+11h59m, now+12h01m]',
          `expiresAt=${t3Msg.expiresAt.toISOString()} lowerBound=${new Date(lowerBound).toISOString()} upperBound=${new Date(upperBound).toISOString()}`
        );
      }
    }

    const t3PushForChat = pushCallCountForChat(ctx.globalMainChatId);
    const t3PushNewCalls = pushCalls.length - t3PushBefore;
    assertEq(
      t3PushForChat,
      0,
      'T3: global main chat — push spy was NOT called for this chatId'
    );
    assertEq(
      t3PushNewCalls,
      0,
      'T3: global main chat — no new push calls at all during this test step'
    );

    // ───────────────────────────────────────────────────────────────────────────
    // TEST 4: REGIONAL GLOBAL chat ("Global Chat - Boston")
    // Expected: success, expiresAt ~now+12h, push spy NOT called
    // ───────────────────────────────────────────────────────────────────────────
    console.log('\n--- Test 4: REGIONAL GLOBAL chat ("Global Chat - Boston") ---');

    const t4Before = Date.now();
    const t4PushBefore = pushCalls.length;
    const t4Resp = await callSendTextMessage(ctx.u1.id, ctx.globalRegionalChatId, 'hi from boston global');
    const t4After = Date.now();
    console.log(`  [Response] status=${t4Resp.status} json=${JSON.stringify(t4Resp.json)}`);

    assertEq(t4Resp.status, 200, 'T4: regional global chat response HTTP 200');
    assert(t4Resp.json?.success === true, 'T4: regional global chat response success=true');

    const t4MsgId = t4Resp.json?.message?.id;
    assert(typeof t4MsgId === 'number', 'T4: regional global chat response has message.id');

    if (t4MsgId) {
      const t4Msg = await prisma.message.findUnique({ where: { id: t4MsgId } });
      ctx.createdMessageIds.push(t4MsgId);

      assert(
        t4Msg?.expiresAt !== null && t4Msg?.expiresAt !== undefined,
        'T4: regional global chat message expiresAt is NOT null'
      );

      if (t4Msg?.expiresAt) {
        const expiresMs = new Date(t4Msg.expiresAt).getTime();
        const lowerBound = t4Before + TWELVE_HOURS_MS - ONE_MINUTE_MS;
        const upperBound = t4After + TWELVE_HOURS_MS + ONE_MINUTE_MS;
        assert(
          expiresMs >= lowerBound && expiresMs <= upperBound,
          'T4: regional global chat expiresAt is within [now+11h59m, now+12h01m]',
          `expiresAt=${t4Msg.expiresAt.toISOString()}`
        );
      }
    }

    const t4PushForChat = pushCallCountForChat(ctx.globalRegionalChatId);
    const t4PushNewCalls = pushCalls.length - t4PushBefore;
    assertEq(
      t4PushForChat,
      0,
      'T4: regional global chat — push spy was NOT called for this chatId'
    );
    assertEq(
      t4PushNewCalls,
      0,
      'T4: regional global chat — no new push calls during this test step'
    );

    // ───────────────────────────────────────────────────────────────────────────
    // TEST 5: Per-message independent TTL (two messages to same global chat)
    // Expected: msg2.expiresAt > msg1.expiresAt (each computed from own createdAt)
    // ───────────────────────────────────────────────────────────────────────────
    console.log('\n--- Test 5: per-message independent TTL (two global messages) ---');

    const t5Resp1 = await callSendTextMessage(ctx.u1.id, ctx.globalMainChatId, 'global msg 1');
    const t5Msg1Id = t5Resp1.json?.message?.id;
    assert(typeof t5Msg1Id === 'number', 'T5: first global message created (has id)');
    if (t5Msg1Id) ctx.createdMessageIds.push(t5Msg1Id);

    // Small delay so createdAt timestamps differ — JS Date has ms precision
    // and Prisma/MySQL round to the nearest second; wait 1100ms to ensure a
    // distinct second-level timestamp in the DB.
    await new Promise(r => setTimeout(r, 1100));

    const t5Resp2 = await callSendTextMessage(ctx.u1.id, ctx.globalMainChatId, 'global msg 2');
    const t5Msg2Id = t5Resp2.json?.message?.id;
    assert(typeof t5Msg2Id === 'number', 'T5: second global message created (has id)');
    if (t5Msg2Id) ctx.createdMessageIds.push(t5Msg2Id);

    if (t5Msg1Id && t5Msg2Id) {
      const [t5Msg1, t5Msg2] = await Promise.all([
        prisma.message.findUnique({ where: { id: t5Msg1Id } }),
        prisma.message.findUnique({ where: { id: t5Msg2Id } }),
      ]);

      assert(
        t5Msg1?.expiresAt !== null && t5Msg2?.expiresAt !== null,
        'T5: both global messages have non-null expiresAt'
      );

      if (t5Msg1?.expiresAt && t5Msg2?.expiresAt) {
        const exp1 = new Date(t5Msg1.expiresAt).getTime();
        const exp2 = new Date(t5Msg2.expiresAt).getTime();
        assert(
          exp2 > exp1,
          'T5: second message expiresAt > first message expiresAt (per-message TTL)',
          `msg1.expiresAt=${t5Msg1.expiresAt.toISOString()} msg2.expiresAt=${t5Msg2.expiresAt.toISOString()}`
        );

        // Also check each is ~12h from its own createdAt
        const created1 = new Date(t5Msg1.createdAt).getTime();
        const created2 = new Date(t5Msg2.createdAt).getTime();
        const delta1 = exp1 - created1;
        const delta2 = exp2 - created2;

        assert(
          Math.abs(delta1 - TWELVE_HOURS_MS) < ONE_MINUTE_MS,
          'T5: msg1 expiresAt - createdAt ≈ 12h',
          `delta=${delta1}ms (expected ~${TWELVE_HOURS_MS}ms)`
        );
        assert(
          Math.abs(delta2 - TWELVE_HOURS_MS) < ONE_MINUTE_MS,
          'T5: msg2 expiresAt - createdAt ≈ 12h',
          `delta=${delta2}ms (expected ~${TWELVE_HOURS_MS}ms)`
        );
      }
    }

    // ───────────────────────────────────────────────────────────────────────────
    // TEST 6: Cross-check cleanup contract
    //
    // 6a. Global messages (expiresAt ~now+12h) ARE selected by a cleanup
    //     query: WHERE expiresAt IS NOT NULL AND expiresAt <= (now + 12h + 1min).
    //     This simulates what the cron job would see if it ran right after
    //     the 12h window elapsed.
    //
    // 6b. Personal message (expiresAt=null) is NOT selected by a basic cleanup
    //     query: WHERE expiresAt IS NOT NULL AND expiresAt <= now.
    // ───────────────────────────────────────────────────────────────────────────
    console.log('\n--- Test 6: cleanup contract cross-check ---');

    const now = new Date();
    const nowPlus12hPlus1min = new Date(now.getTime() + TWELVE_HOURS_MS + ONE_MINUTE_MS);

    // 6a: global messages within the cleanup window
    const globalMsgIds = [
      t3MsgId,  // Global Chat main
      t4MsgId,  // Global Chat - Boston
      t5Msg1Id, // 2nd global main msg 1
      t5Msg2Id, // 2nd global main msg 2
    ].filter(Boolean);

    if (globalMsgIds.length > 0) {
      const expiryCandidates = await prisma.message.findMany({
        where: {
          id: { in: globalMsgIds },
          expiresAt: { not: null, lte: nowPlus12hPlus1min },
        },
        select: { id: true, expiresAt: true },
      });
      assertEq(
        expiryCandidates.length,
        globalMsgIds.length,
        `T6a: all ${globalMsgIds.length} global messages appear in cleanup window query (expiresAt <= now+12h+1min)`
      );
    }

    // 6b: personal message is NOT in a "cleanup now" query
    if (t1MsgId) {
      const personalInCleanup = await prisma.message.findMany({
        where: {
          id: t1MsgId,
          expiresAt: { not: null, lte: now },
        },
      });
      assertEq(
        personalInCleanup.length,
        0,
        'T6b: personal message (expiresAt=null) is NOT selected by cleanup query (WHERE expiresAt IS NOT NULL AND expiresAt <= now)'
      );
    }

    // 6c: group message is also not in cleanup now query
    if (t2MsgId) {
      const groupInCleanup = await prisma.message.findMany({
        where: {
          id: t2MsgId,
          expiresAt: { not: null, lte: now },
        },
      });
      assertEq(
        groupInCleanup.length,
        0,
        'T6c: group message (expiresAt=null) is NOT selected by cleanup query'
      );
    }

  } catch (err) {
    failed++;
    const msg = `UNHANDLED TEST ERROR: ${err.message}`;
    failures.push(msg);
    console.error(`  FAIL  ${msg}`);
    console.error(err.stack);
  } finally {
    restorePushSpy();

    console.log('\n--- Teardown ---');
    await teardown();

    // ── Baseline verification ──────────────────────────────────────────────────
    console.log('\n--- Baseline verification ---');
    const [usersAfter, chatsAfter, messagesAfter, userOnChatAfter] = await Promise.all([
      prisma.user.count(),
      prisma.chat.count(),
      prisma.message.count(),
      prisma.userOnChat.count(),
    ]);

    assertEq(usersAfter, baseline.users, `DB baseline restored: users (expected ${baseline.users}, got ${usersAfter})`);
    assertEq(chatsAfter, baseline.chats, `DB baseline restored: chats (expected ${baseline.chats}, got ${chatsAfter})`);
    assertEq(messagesAfter, baseline.messages, `DB baseline restored: messages (expected ${baseline.messages}, got ${messagesAfter})`);
    assertEq(userOnChatAfter, baseline.userOnChat, `DB baseline restored: userOnChat (expected ${baseline.userOnChat}, got ${userOnChatAfter})`);

    await prisma.$disconnect();

    // ── Summary ────────────────────────────────────────────────────────────────
    const total = passed + failed;
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`TEST RESULTS: ${passed}/${total} passed`);
    console.log(`  Passed : ${passed}`);
    console.log(`  Failed : ${failed}`);
    if (failures.length > 0) {
      console.log('\nFailing assertions:');
      failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    }
    console.log('══════════════════════════════════════════════════════════════');

    process.exit(failed > 0 ? 1 : 0);
  }
}

run().catch((err) => {
  console.error('Fatal error during test setup:', err);
  prisma.$disconnect();
  process.exit(1);
});
