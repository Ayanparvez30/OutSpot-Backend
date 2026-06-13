#!/usr/bin/env node
/**
 * Test: per-message disappearing TTL for GROUP + COMMUNITY chats (24h),
 * mirroring the existing GLOBAL chat rule (12h), with PERSONAL 1:1 staying
 * permanent (null). Plus cron deletion + S3 orphan-guard classification.
 *
 * What is REAL vs mirrored/stubbed:
 *   - REAL: controllers/chatController.js `sendTextMessage` is invoked directly
 *     with a mock req/res to prove the actual expiresAt stamping (assertions 1-4).
 *   - REAL: utils/s3Cleanup `deleteS3IfOrphanBulk` is called for the orphan
 *     CLASSIFICATION (assertion 6). We stub the actual S3 DeleteObject so the
 *     unique-URL branch can reach "deleted" without a network call — we only
 *     assert the kept/deleted classification, never real S3 success.
 *   - MIRRORED: the every-minute cron in server.js (~145-198) is re-implemented
 *     verbatim here (findMany where {expiresAt:{not:null,lte:now}} -> deleteMany).
 *     server.js is NOT imported (that boots the HTTP server + all crons).
 *
 * Live DB (Prisma). Seed + cleanup authorized. Baseline recorded before and
 * restored EXACTLY in finally.
 *
 * Usage: node tests/group-community-ttl.test.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

// ── Test harness ────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
const results = []; // { id, label, expected, received, pass }

function record(id, pass, label, expected, received) {
  if (pass) {
    passed++;
    console.log(`  PASS  [${id}] ${label}`);
  } else {
    failed++;
    const msg = `[${id}] ${label} (expected ${expected}, got ${received})`;
    failures.push(msg);
    console.log(`  FAIL  ${msg}`);
  }
  results.push({ id, label, expected, received: pass ? expected : received, pass });
}

// expiresAt ≈ now + offsetMs, within toleranceMs
function assertApprox(id, actual, offsetMs, toleranceMs, label, base) {
  if (actual == null) {
    record(id, false, label, `~now+${offsetMs}ms`, 'null');
    return;
  }
  const target = base + offsetMs;
  const diff = Math.abs(new Date(actual).getTime() - target);
  const pass = diff <= toleranceMs;
  record(
    id,
    pass,
    label,
    `within ${toleranceMs}ms of now+${offsetMs}ms`,
    `diff=${diff}ms (expiresAt=${new Date(actual).toISOString()})`
  );
}

// ── Baseline ─────────────────────────────────────────────────────────────────
const baseline = {};
async function recordBaseline() {
  const [users, chats, messages, userOnChat, stories] = await Promise.all([
    prisma.user.count(),
    prisma.chat.count(),
    prisma.message.count(),
    prisma.userOnChat.count(),
    prisma.story.count(),
  ]);
  Object.assign(baseline, { users, chats, messages, userOnChat, stories });
  console.log(
    `[BASELINE] users:${users} chats:${chats} messages:${messages} ` +
    `userOnChat:${userOnChat} stories:${stories}`
  );
}

// ── Seed context ───────────────────────────────────────────────────────────────
const TAG = 'test-grpttl';
const ctx = {
  userId: null,
  groupChatId: null,
  communityChatId: null,
  personalChatId: null,
  globalChatId: null,
  // cron deletion (assertion 5)
  cronChatId: null,
  pastMsgId: null,
  futureMsgId: null,
  // S3 guard (assertion 6)
  storyId: null,
  sharedMsgId: null,
  uniqueMsgId: null,
};

const SHARED_URL = 'https://fake-test-bucket.s3.amazonaws.com/grpttl/shared-with-story.jpg';
const UNIQUE_URL = 'https://fake-test-bucket.s3.amazonaws.com/grpttl/unique-orphan.jpg';

async function seed() {
  const hash = await bcrypt.hash('GrpTtlPass!1', 10);
  const user = await prisma.user.create({
    data: {
      username: `${TAG}-u1`,
      email: `${TAG}-u1@example.com`,
      password: hash,
      firstName: 'GrpTtl',
      lastName: 'User',
    },
  });
  ctx.userId = user.id;

  const memberCreate = { create: [{ userId: ctx.userId, role: 'ADMIN', lastSeenMessageId: 0 }] };

  const group = await prisma.chat.create({
    data: { name: `${TAG} Group`, isGroup: true, isCommunity: false, communityId: null, users: memberCreate },
  });
  ctx.groupChatId = group.id;

  const community = await prisma.chat.create({
    data: { name: 'My Community', isGroup: false, isCommunity: true, communityId: null, users: memberCreate },
  });
  ctx.communityChatId = community.id;

  const personal = await prisma.chat.create({
    data: { name: null, isGroup: false, isCommunity: false, communityId: null, users: memberCreate },
  });
  ctx.personalChatId = personal.id;

  const global = await prisma.chat.create({
    data: { name: 'Global Chat - Test', isGroup: false, isCommunity: false, communityId: null, users: memberCreate },
  });
  ctx.globalChatId = global.id;

  // Cron deletion fixtures live in a separate group chat
  const cronChat = await prisma.chat.create({
    data: { name: `${TAG} CronGroup`, isGroup: true, isCommunity: false, communityId: null, users: memberCreate },
  });
  ctx.cronChatId = cronChat.id;

  const now = Date.now();
  const past = await prisma.message.create({
    data: { content: 'past', senderId: ctx.userId, chatId: ctx.cronChatId, expiresAt: new Date(now - 60 * 1000) },
  });
  ctx.pastMsgId = past.id;
  const future = await prisma.message.create({
    data: { content: 'future', senderId: ctx.userId, chatId: ctx.cronChatId, expiresAt: new Date(now + 24 * 60 * 60 * 1000) },
  });
  ctx.futureMsgId = future.id;

  // S3 orphan-guard fixtures (clearly fake URLs)
  const story = await prisma.story.create({
    data: { userId: ctx.userId, mediaUrl: SHARED_URL, type: 'IMAGE', visibility: 'profile', status: 'ACTIVE' },
  });
  ctx.storyId = story.id;

  const sharedMsg = await prisma.message.create({
    data: { content: null, imageUrl: SHARED_URL, senderId: ctx.userId, chatId: ctx.groupChatId, expiresAt: new Date(now - 60 * 1000) },
  });
  ctx.sharedMsgId = sharedMsg.id;

  const uniqueMsg = await prisma.message.create({
    data: { content: null, imageUrl: UNIQUE_URL, senderId: ctx.userId, chatId: ctx.groupChatId, expiresAt: new Date(now - 60 * 1000) },
  });
  ctx.uniqueMsgId = uniqueMsg.id;

  console.log(`[SEED] userId=${ctx.userId} group=${ctx.groupChatId} community=${ctx.communityChatId} ` +
    `personal=${ctx.personalChatId} global=${ctx.globalChatId} cronChat=${ctx.cronChatId} ` +
    `past=${ctx.pastMsgId} future=${ctx.futureMsgId} story=${ctx.storyId} ` +
    `sharedMsg=${ctx.sharedMsgId} uniqueMsg=${ctx.uniqueMsgId}`);
}

// ── Teardown ─────────────────────────────────────────────────────────────────
async function teardown() {
  const chatIds = [ctx.groupChatId, ctx.communityChatId, ctx.personalChatId, ctx.globalChatId, ctx.cronChatId].filter(Boolean);
  if (chatIds.length) {
    await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.userOnChat.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
  }
  if (ctx.storyId) await prisma.story.deleteMany({ where: { id: ctx.storyId } });
  await prisma.user.deleteMany({ where: { email: `${TAG}-u1@example.com` } });
  console.log('[TEARDOWN] Seeded fixtures removed.');
}

// ── Mock req/res to drive the REAL controller ────────────────────────────────
function makeReqRes(userId, chatId, content) {
  const captured = { statusCode: 200, body: null };
  const req = { authData: { id: userId }, body: { chatId, content } };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.body = payload; return this; },
  };
  return { req, res, captured };
}

// ── Mirrored cron callback (verbatim from server.js ~145-198) ────────────────
// server.js is NOT imported. deleteS3IfOrphanBulk is the REAL one; we stub
// only deleteFromS3 inside it so no network call happens.
async function runCronMirrored() {
  const expired = await prisma.message.findMany({
    where: { expiresAt: { not: null, lte: new Date() } },
    select: { id: true, chatId: true, imageUrl: true },
  });
  if (expired.length === 0) return { expired, deleteCount: 0, s3: null };

  const del = await prisma.message.deleteMany({
    where: { id: { in: expired.map(m => m.id) } },
  });

  const { deleteS3IfOrphanBulk } = require('../utils/s3Cleanup');
  const msgUrls = [...new Set(expired.map(m => m.imageUrl).filter(Boolean))];
  let s3 = null;
  if (msgUrls.length) s3 = await deleteS3IfOrphanBulk(msgUrls);

  return { expired, deleteCount: del.count, s3 };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  await recordBaseline();
  await seed();

  // Stub the actual S3 DeleteObject so deleteS3IfOrphan's unique-URL branch can
  // reach "deleted" without touching the network. countReferences (the orphan
  // CLASSIFICATION under test) is left REAL.
  const s3Upload = require('../utils/s3Upload');
  const origDeleteFromS3 = s3Upload.deleteFromS3;
  let s3DeleteCalls = [];
  s3Upload.deleteFromS3 = async (url) => { s3DeleteCalls.push(url); return true; };

  try {
    const H = 60 * 60 * 1000;
    const TOL = 90 * 1000; // 90s tolerance (assertions ask ~1min window)

    // ── Assertions 1-4: REAL sendTextMessage stamps expiresAt by chat type ──
    console.log('\n--- Assertions 1-4: sendTextMessage expiresAt by chat type ---');

    // GROUP → now + 24h
    {
      const base = Date.now();
      const { req, res, captured } = makeReqRes(ctx.userId, ctx.groupChatId, 'group hi');
      await require('../controllers/chatController').sendTextMessage(req, res);
      const exp = captured.body && captured.body.message && captured.body.message.expiresAt;
      assertApprox('1', exp, 24 * H, TOL, 'GROUP message expiresAt ~ now+24h', base);
    }

    // COMMUNITY → now + 24h
    {
      const base = Date.now();
      const { req, res, captured } = makeReqRes(ctx.userId, ctx.communityChatId, 'community hi');
      await require('../controllers/chatController').sendTextMessage(req, res);
      const exp = captured.body && captured.body.message && captured.body.message.expiresAt;
      assertApprox('2', exp, 24 * H, TOL, 'COMMUNITY message expiresAt ~ now+24h', base);
    }

    // PERSONAL → null
    {
      const { req, res, captured } = makeReqRes(ctx.userId, ctx.personalChatId, 'personal hi');
      await require('../controllers/chatController').sendTextMessage(req, res);
      const exp = captured.body && captured.body.message ? captured.body.message.expiresAt : 'NO_BODY';
      record('3', exp === null, 'PERSONAL message expiresAt === null (permanent)', 'null', JSON.stringify(exp));
    }

    // GLOBAL → now + 12h (regression)
    {
      const base = Date.now();
      const { req, res, captured } = makeReqRes(ctx.userId, ctx.globalChatId, 'global hi');
      await require('../controllers/chatController').sendTextMessage(req, res);
      const exp = captured.body && captured.body.message && captured.body.message.expiresAt;
      assertApprox('4', exp, 12 * H, TOL, 'GLOBAL message expiresAt ~ now+12h (regression)', base);
    }

    // ── Assertion 5: cron deletion (past deleted, future survives) ──
    console.log('\n--- Assertion 5: mirrored cron deletes past, keeps future ---');
    await runCronMirrored();
    const pastRow = await prisma.message.findUnique({ where: { id: ctx.pastMsgId } });
    const futureRow = await prisma.message.findUnique({ where: { id: ctx.futureMsgId } });
    record('5a', pastRow === null, 'GROUP past-expiry message DELETED by cron', 'null', JSON.stringify(pastRow && pastRow.id));
    record('5b', futureRow !== null, 'GROUP future-expiry message SURVIVES cron', 'present', futureRow ? 'present' : 'null');

    // ── Assertion 6: S3 orphan-guard classification ──
    // The cron above already ran deleteS3IfOrphanBulk over [SHARED_URL, UNIQUE_URL]
    // AFTER deleting the message rows. At that point:
    //   - SHARED_URL still referenced by the Story  -> kept (no S3 delete call)
    //   - UNIQUE_URL referenced nowhere             -> eligible -> deleteFromS3 called
    console.log('\n--- Assertion 6: S3 orphan-guard classification (REAL deleteS3IfOrphanBulk) ---');
    const { countReferences } = require('../utils/s3Cleanup');
    const sharedRefs = await countReferences(SHARED_URL); // Story still references => >0
    const uniqueRefs = await countReferences(UNIQUE_URL); // nothing references => 0
    record('6a', sharedRefs > 0, 'SHARED url still referenced by Story (kept)', '>0', String(sharedRefs));
    record('6b', uniqueRefs === 0, 'UNIQUE url referenced nowhere (orphan, eligible for delete)', '0', String(uniqueRefs));
    // Real S3 delete (stubbed network) must have been invoked for UNIQUE only.
    record('6c', s3DeleteCalls.includes(UNIQUE_URL), 'deleteFromS3 invoked for UNIQUE orphan url', 'called', JSON.stringify(s3DeleteCalls));
    record('6d', !s3DeleteCalls.includes(SHARED_URL), 'deleteFromS3 NOT invoked for SHARED (story-referenced) url', 'not called', JSON.stringify(s3DeleteCalls));

  } catch (err) {
    failed++;
    const msg = `UNHANDLED TEST ERROR: ${err.message}`;
    failures.push(msg);
    console.error(`  FAIL  ${msg}`);
    console.error(err.stack);
  } finally {
    // restore stub
    s3Upload.deleteFromS3 = origDeleteFromS3;

    console.log('\n--- Teardown ---');
    await teardown();

    console.log('\n--- Baseline verification ---');
    const [users, chats, messages, userOnChat, stories] = await Promise.all([
      prisma.user.count(), prisma.chat.count(), prisma.message.count(),
      prisma.userOnChat.count(), prisma.story.count(),
    ]);
    for (const [k, v] of Object.entries({ users, chats, messages, userOnChat, stories })) {
      record(`BL-${k}`, v === baseline[k], `baseline restored: ${k}`, String(baseline[k]), String(v));
    }

    await prisma.$disconnect();

    const total = passed + failed;
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`TEST RESULTS: ${passed}/${total} passed`);
    if (failures.length) {
      console.log('\nFailing:');
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
