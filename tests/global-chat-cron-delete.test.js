#!/usr/bin/env node
/**
 * Test: disappearing-messages cleanup CRON actually deletes expired global-chat messages.
 *
 * Strategy:
 *   - Re-implements the cron callback logic verbatim from server.js lines 133-171.
 *     Do NOT import server.js (that would boot the HTTP server + register all crons).
 *   - Seeds a global chat + 4 messages with controlled expiresAt values.
 *   - Runs the mirrored cleanup logic once against the LIVE DB via Prisma.
 *   - Asserts expired messages are gone, non-expired and null-expiry messages survive.
 *   - Stubs getIO() so the socket emit is exercised without a live socket server;
 *     captures the emitted payload for assertion.
 *   - Tears down in finally — verifies EXACT baseline restore.
 *
 * Usage:
 *   node tests/global-chat-cron-delete.test.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

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

// ── Baseline ───────────────────────────────────────────────────────────────────

const baseline = { users: 0, chats: 0, messages: 0, userOnChat: 0 };

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

// ── Seed context ───────────────────────────────────────────────────────────────

const ctx = {
  userId: null,
  chatId: null,
  msgAId: null, // expired: now - 1 min
  msgBId: null, // expired: now - 12 h
  msgCId: null, // future:  now + 12 h
  msgDId: null, // null expiresAt
};

// ── Seed ───────────────────────────────────────────────────────────────────────

async function seed() {
  const now = new Date();
  const hash = await bcrypt.hash('TestCronPass!1', 10);

  // Test user
  const user = await prisma.user.create({
    data: {
      username: 'test-cron-global-u1',
      email: 'test-cron-global-u1@example.com',
      password: hash,
      firstName: 'CronTest',
      lastName: 'User',
    },
  });
  ctx.userId = user.id;

  // Global chat (isCommunity=false, communityId=null — matches the real global chat shape)
  const chat = await prisma.chat.create({
    data: {
      name: 'Global Chat - CronTest',
      isGroup: false,
      isCommunity: false,
      communityId: null,
      disappearingSeconds: null,
      users: {
        create: [{ userId: ctx.userId, role: 'MEMBER', lastSeenMessageId: 0 }],
      },
    },
  });
  ctx.chatId = chat.id;

  // Message A — already expired: now - 1 minute
  const msgA = await prisma.message.create({
    data: {
      content: 'Msg A — expired 1 min ago',
      senderId: ctx.userId,
      chatId: ctx.chatId,
      imageUrl: null, // no S3 key — S3 loop is a no-op
      expiresAt: new Date(now.getTime() - 60 * 1000),
    },
  });
  ctx.msgAId = msgA.id;

  // Message B — already expired: now - 12 hours
  const msgB = await prisma.message.create({
    data: {
      content: 'Msg B — expired 12h ago',
      senderId: ctx.userId,
      chatId: ctx.chatId,
      imageUrl: null,
      expiresAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
    },
  });
  ctx.msgBId = msgB.id;

  // Message C — future expiry: now + 12 hours
  const msgC = await prisma.message.create({
    data: {
      content: 'Msg C — expires in 12h',
      senderId: ctx.userId,
      chatId: ctx.chatId,
      imageUrl: null,
      expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
    },
  });
  ctx.msgCId = msgC.id;

  // Message D — null expiresAt (permanent / non-disappearing)
  const msgD = await prisma.message.create({
    data: {
      content: 'Msg D — never expires',
      senderId: ctx.userId,
      chatId: ctx.chatId,
      imageUrl: null,
      expiresAt: null,
    },
  });
  ctx.msgDId = msgD.id;

  console.log(
    `[SEED] userId=${ctx.userId} chatId=${ctx.chatId} ` +
    `msgA=${ctx.msgAId} msgB=${ctx.msgBId} msgC=${ctx.msgCId} msgD=${ctx.msgDId}`
  );
}

// ── Teardown ───────────────────────────────────────────────────────────────────

async function teardown() {
  // Delete any surviving seeded messages by chatId (covers C and D which the
  // cron should not have touched, plus A/B if the cron failed for any reason)
  if (ctx.chatId) {
    await prisma.message.deleteMany({ where: { chatId: ctx.chatId } });
    await prisma.userOnChat.deleteMany({ where: { chatId: ctx.chatId } });
    await prisma.chat.deleteMany({ where: { id: ctx.chatId } });
  }
  await prisma.user.deleteMany({
    where: { email: 'test-cron-global-u1@example.com' },
  });
  console.log('[TEARDOWN] Seeded fixtures removed.');
}

// ── Mirrored cron callback — verbatim copy of server.js lines 133-171 ─────────
//
// IMPORTANT: This function is a faithful re-implementation of the inline
// cron callback in server.js. The query predicates (findMany where clause,
// deleteMany where clause) are copied character-for-character so that the
// test proves the *actual* production predicate, not a paraphrase of it.
//
// The only differences:
//   1. getIO() is replaced by a stub (ioStub) to avoid "socket not init" throw.
//   2. deleteFromS3 is NOT imported (no imageUrl on seeded messages — the
//      loop body `if (m.imageUrl) deleteFromS3(m.imageUrl)` is a no-op).
//
// Returns: { expired, deleteCount, emittedEvents }

async function runCronLogicMirrored(ioStub) {
  const emittedEvents = []; // capture socket payloads

  // Build a fake io object that records calls to io.to().emit()
  const fakeIo = {
    to(room) {
      return {
        emit(event, payload) {
          emittedEvents.push({ room, event, payload });
        },
      };
    },
  };

  let expired = [];
  let deleteResult = null;

  // ── BEGIN: verbatim mirror of server.js cron callback body (lines 132-174) ──
  try {
    // Find expired messages — include imageUrl so we can clean up S3
    expired = await prisma.message.findMany({
      where: {
        expiresAt: { not: null, lte: new Date() },
      },
      select: { id: true, chatId: true, imageUrl: true },
    });

    if (expired.length === 0) return { expired, deleteCount: 0, emittedEvents };

    // Delete DB records
    deleteResult = await prisma.message.deleteMany({
      where: { id: { in: expired.map(m => m.id) } },
    });

    console.log(`    [CRON-MIRROR] Disappearing messages cleaned up: ${expired.length}`);

    // Delete S3 images (best-effort) — no imageUrl on seeded messages, so no-op
    // const { deleteFromS3 } = require('./utils/s3Upload');
    for (const m of expired) {
      if (m.imageUrl) { /* deleteFromS3(m.imageUrl) — stubbed out */ }
    }

    // Group by chatId and emit per-chat messagesDeleted events
    try {
      // getIO() replaced by fakeIo to avoid "socket not initialised" throw
      const io = ioStub || fakeIo;

      const byChatId = {};
      for (const m of expired) {
        if (!byChatId[m.chatId]) byChatId[m.chatId] = [];
        byChatId[m.chatId].push(m.id);
      }
      for (const [chatId, messageIds] of Object.entries(byChatId)) {
        io.to(`chat_${chatId}`).emit('messagesDeleted', {
          chatId: parseInt(chatId, 10),
          messageIds,
        });
      }
    } catch (_) { /* socket not ready yet */ }
  } catch (e) {
    console.error('    [CRON-MIRROR] Disappearing messages cron error:', e);
    throw e;
  }
  // ── END: verbatim mirror ───────────────────────────────────────────────────

  return {
    expired,
    deleteCount: deleteResult ? deleteResult.count : 0,
    emittedEvents,
  };
}

// ── Main test runner ───────────────────────────────────────────────────────────

async function run() {
  await recordBaseline();
  await seed();

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // PRE-CONDITION: all 4 seeded messages exist in DB
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Pre-condition: all 4 seeded messages present ---');

    const allIds = [ctx.msgAId, ctx.msgBId, ctx.msgCId, ctx.msgDId];
    const beforeRows = await prisma.message.findMany({
      where: { id: { in: allIds } },
      select: { id: true, expiresAt: true },
    });

    assertEq(
      beforeRows.length,
      4,
      'PRE: all 4 seeded messages exist in DB before cleanup'
    );
    assert(
      beforeRows.some(r => r.id === ctx.msgAId),
      'PRE: Message A (expired -1min) is present'
    );
    assert(
      beforeRows.some(r => r.id === ctx.msgBId),
      'PRE: Message B (expired -12h) is present'
    );
    assert(
      beforeRows.some(r => r.id === ctx.msgCId),
      'PRE: Message C (future +12h) is present'
    );
    assert(
      beforeRows.some(r => r.id === ctx.msgDId),
      'PRE: Message D (null expiresAt) is present'
    );

    // ──────────────────────────────────────────────────────────────────────────
    // RUN mirrored cleanup logic (scoped only to seeded message ids to be safe,
    // but the cron predicate itself is global — we narrow the assertion checks
    // post-run, NOT the query itself, so we mirror the real predicate exactly)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Running mirrored cron cleanup logic ---');

    const { expired, deleteCount, emittedEvents } = await runCronLogicMirrored(null);

    console.log(
      `    [CRON-MIRROR] expired.length=${expired.length} ` +
      `deleteCount=${deleteCount} emittedEvents=${emittedEvents.length}`
    );

    // ──────────────────────────────────────────────────────────────────────────
    // ASSERTION 4: deleteMany returned count === 2 (only A and B)
    // NOTE: Other expired messages from unrelated data could exist in a shared
    // dev DB. We scope this assertion to only our seeded ids to be safe: the
    // expired set must include both A and B, and deleteCount >= 2.
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Assertion 4: deleteMany count includes seeded expired msgs ---');

    const expiredIds = expired.map(m => m.id);
    assert(
      expiredIds.includes(ctx.msgAId),
      'A4: expired set includes Message A (our expired -1min msg)'
    );
    assert(
      expiredIds.includes(ctx.msgBId),
      'A4: expired set includes Message B (our expired -12h msg)'
    );
    assert(
      !expiredIds.includes(ctx.msgCId),
      'A4: expired set does NOT include Message C (future +12h)',
      `expiredIds=${JSON.stringify(expiredIds)}`
    );
    assert(
      !expiredIds.includes(ctx.msgDId),
      'A4: expired set does NOT include Message D (null expiresAt)',
      `expiredIds=${JSON.stringify(expiredIds)}`
    );
    assert(
      deleteCount >= 2,
      'A4: deleteMany count >= 2 (includes at minimum our 2 expired seeded msgs)',
      `deleteCount=${deleteCount}`
    );

    // ──────────────────────────────────────────────────────────────────────────
    // ASSERTIONS 1-3: post-cleanup DB state for each seeded message
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Assertions 1-3: post-cleanup DB state ---');

    const msgARow = await prisma.message.findUnique({ where: { id: ctx.msgAId } });
    const msgBRow = await prisma.message.findUnique({ where: { id: ctx.msgBId } });
    const msgCRow = await prisma.message.findUnique({ where: { id: ctx.msgCId } });
    const msgDRow = await prisma.message.findUnique({ where: { id: ctx.msgDId } });

    assert(
      msgARow === null,
      'A3: Message A (expired -1min) is GONE after cleanup',
      `found: ${JSON.stringify(msgARow)}`
    );
    assert(
      msgBRow === null,
      'A3: Message B (expired -12h) is GONE after cleanup',
      `found: ${JSON.stringify(msgBRow)}`
    );
    assert(
      msgCRow !== null,
      'A3: Message C (future +12h) STILL EXISTS after cleanup'
    );
    assert(
      msgDRow !== null,
      'A3: Message D (null expiresAt) STILL EXISTS after cleanup'
    );

    // Confirm surviving messages have correct expiresAt values
    if (msgCRow) {
      assert(
        msgCRow.expiresAt !== null,
        'A3: Message C expiresAt is still set (not nulled out)',
        `expiresAt=${msgCRow.expiresAt}`
      );
      assert(
        new Date(msgCRow.expiresAt).getTime() > Date.now(),
        'A3: Message C expiresAt is still in the FUTURE',
        `expiresAt=${msgCRow.expiresAt}`
      );
    }
    if (msgDRow) {
      assertEq(
        msgDRow.expiresAt,
        null,
        'A3: Message D expiresAt is still NULL'
      );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ASSERTION 5: socket emit payload
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Assertion 5: socket emit payload ---');

    // Find the emitted event for our test chat
    const ourChatEvent = emittedEvents.find(
      e => e.payload && e.payload.chatId === ctx.chatId
    );

    assert(
      ourChatEvent !== null && ourChatEvent !== undefined,
      'A5: a messagesDeleted event was emitted for our test chatId',
      `emittedEvents=${JSON.stringify(emittedEvents)}`
    );

    if (ourChatEvent) {
      assertEq(
        ourChatEvent.event,
        'messagesDeleted',
        'A5: emitted event name is "messagesDeleted"'
      );
      assertEq(
        ourChatEvent.room,
        `chat_${ctx.chatId}`,
        `A5: emitted to room "chat_${ctx.chatId}"`
      );
      assertEq(
        ourChatEvent.payload.chatId,
        ctx.chatId,
        `A5: payload.chatId === ${ctx.chatId}`
      );

      const emittedMsgIds = ourChatEvent.payload.messageIds || [];
      assert(
        emittedMsgIds.includes(ctx.msgAId),
        'A5: payload.messageIds includes Message A id',
        `messageIds=${JSON.stringify(emittedMsgIds)}`
      );
      assert(
        emittedMsgIds.includes(ctx.msgBId),
        'A5: payload.messageIds includes Message B id',
        `messageIds=${JSON.stringify(emittedMsgIds)}`
      );
      assert(
        !emittedMsgIds.includes(ctx.msgCId),
        'A5: payload.messageIds does NOT include Message C id',
        `messageIds=${JSON.stringify(emittedMsgIds)}`
      );
      assert(
        !emittedMsgIds.includes(ctx.msgDId),
        'A5: payload.messageIds does NOT include Message D id',
        `messageIds=${JSON.stringify(emittedMsgIds)}`
      );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // ASSERTION 6: sanity — re-run the real cron predicate against our seeded
    // ids; must return 0 rows (everything due has been removed)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- Assertion 6: sanity re-query — 0 expired seeded msgs remain ---');

    const stillExpiredSeeded = await prisma.message.findMany({
      where: {
        id: { in: [ctx.msgAId, ctx.msgBId, ctx.msgCId, ctx.msgDId] },
        expiresAt: { not: null, lte: new Date() },
      },
      select: { id: true, expiresAt: true },
    });

    assertEq(
      stillExpiredSeeded.length,
      0,
      'A6: re-querying {expiresAt: {not:null, lte:new Date()}} across seeded ids returns 0 (all due msgs deleted)'
    );

  } catch (err) {
    failed++;
    const msg = `UNHANDLED TEST ERROR: ${err.message}`;
    failures.push(msg);
    console.error(`  FAIL  ${msg}`);
    console.error(err.stack);
  } finally {
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

    assertEq(
      usersAfter,
      baseline.users,
      `BL: DB baseline restored — users (expected ${baseline.users}, got ${usersAfter})`
    );
    assertEq(
      chatsAfter,
      baseline.chats,
      `BL: DB baseline restored — chats (expected ${baseline.chats}, got ${chatsAfter})`
    );
    assertEq(
      messagesAfter,
      baseline.messages,
      `BL: DB baseline restored — messages (expected ${baseline.messages}, got ${messagesAfter})`
    );
    assertEq(
      userOnChatAfter,
      baseline.userOnChat,
      `BL: DB baseline restored — userOnChat (expected ${baseline.userOnChat}, got ${userOnChatAfter})`
    );

    await prisma.$disconnect();

    // ── Summary table ──────────────────────────────────────────────────────────
    const total = passed + failed;
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`TEST RESULTS: ${passed}/${total} passed`);
    console.log(`  Passed  : ${passed}`);
    console.log(`  Failed  : ${failed}`);
    console.log(`  Skipped : 0`);
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
  prisma.$disconnect().finally(() => process.exit(1));
});
