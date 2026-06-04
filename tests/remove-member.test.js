#!/usr/bin/env node
/**
 * Test: removeMember controller
 * Route: POST /communities/remove-member
 *
 * Strategy: call the controller directly with mock req/res objects.
 * No HTTP server required. Uses the real DB — seeds and tears down its own
 * fixtures in a try/finally block.
 *
 * Usage:
 *   node tests/remove-member.test.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();
const { removeMember } = require('../controllers/communityController');

// ── Test harness ──────────────────────────────────────────

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

/**
 * Build a minimal mock req/res pair.
 *
 * @param {object} opts
 * @param {number}  opts.adminId       - req.authData.id (the authenticated caller)
 * @param {object}  opts.body          - req.body
 * @returns {{ req, res, result }}
 *   result is a Promise that resolves to { status, json } once the controller
 *   calls res.status().json() or res.json().
 */
function mockReqRes({ adminId, body = {} }) {
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
    authData: { id: adminId },
    body,
  };

  return { req, res, result };
}

// ── Seeded IDs (populated during setup) ──────────────────

const ctx = {
  adminUserId: null,
  targetUserId: null,
  outsiderUserId: null,
  communityId: null,
  membershipId: null,
  chatId: null,
};

// ── Seed helpers ─────────────────────────────────────────

async function seed() {
  const hash = await bcrypt.hash('TestPass!1', 10);

  // Create admin user (community creator)
  const admin = await prisma.user.create({
    data: {
      username: 'test-removemember-admin',
      email: 'test-removemember-admin@example.com',
      password: hash,
      authorization: 'test-removemember-admin-token-abc123',
    },
  });
  ctx.adminUserId = admin.id;

  // Create target member user
  const target = await prisma.user.create({
    data: {
      username: 'test-removemember-target',
      email: 'test-removemember-target@example.com',
      password: hash,
      authorization: 'test-removemember-target-token-xyz456',
    },
  });
  ctx.targetUserId = target.id;

  // Create a third user who is NOT a member and NOT the admin
  const outsider = await prisma.user.create({
    data: {
      username: 'test-removemember-outsider',
      email: 'test-removemember-outsider@example.com',
      password: hash,
      authorization: 'test-removemember-outsider-token-qqq789',
    },
  });
  ctx.outsiderUserId = outsider.id;

  // Create community owned by admin
  const community = await prisma.community.create({
    data: {
      name: 'Test RemoveMember Community',
      creatorId: ctx.adminUserId,
    },
  });
  ctx.communityId = community.id;

  // Add admin as a member (community creator is always a member)
  await prisma.communityMember.create({
    data: { userId: ctx.adminUserId, communityId: ctx.communityId },
  });

  // Add target as a member
  const membership = await prisma.communityMember.create({
    data: { userId: ctx.targetUserId, communityId: ctx.communityId },
  });
  ctx.membershipId = membership.id;

  // Create community chat
  const chat = await prisma.chat.create({
    data: {
      isGroup: false,
      isCommunity: true,
      communityId: ctx.communityId,
      name: 'Test RemoveMember Community',
    },
  });
  ctx.chatId = chat.id;

  // Add both admin and target to the chat
  await prisma.userOnChat.createMany({
    data: [
      { chatId: ctx.chatId, userId: ctx.adminUserId },
      { chatId: ctx.chatId, userId: ctx.targetUserId },
    ],
  });

  console.log(`\n[SEED] admin=${ctx.adminUserId} target=${ctx.targetUserId} outsider=${ctx.outsiderUserId} community=${ctx.communityId} chat=${ctx.chatId}`);
}

async function teardown() {
  // Delete in dependency order
  // 1. communityHistory rows for our community
  await prisma.communityHistory.deleteMany({ where: { communityId: ctx.communityId } });

  // 2. userOnChat rows for our chat
  if (ctx.chatId) {
    await prisma.userOnChat.deleteMany({ where: { chatId: ctx.chatId } });
    await prisma.chat.deleteMany({ where: { id: ctx.chatId } });
  }

  // 3. communityMember rows (some may already be deleted by controller)
  await prisma.communityMember.deleteMany({ where: { communityId: ctx.communityId } });

  // 4. community
  if (ctx.communityId) {
    await prisma.community.deleteMany({ where: { id: ctx.communityId } });
  }

  // 5. test users
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [
          'test-removemember-admin@example.com',
          'test-removemember-target@example.com',
          'test-removemember-outsider@example.com',
        ],
      },
    },
  });

  console.log('[TEARDOWN] Seeded fixtures removed.');
}

// ── Individual test cases ─────────────────────────────────

async function testInvalidCommunityId() {
  console.log('\n[CASE] 400 — missing/non-int communityId');

  // Missing communityId
  {
    const { req, res, result } = mockReqRes({
      adminId: ctx.adminUserId,
      body: { userId: ctx.targetUserId },
    });
    await removeMember(req, res);
    const r = await result;
    assert(r.status === 400, '400 when communityId is missing');
    assert(typeof r.json.error === 'string' && r.json.error.toLowerCase().includes('communityid'),
      'error message mentions communityId');
  }

  // String communityId that is not a number
  {
    const { req, res, result } = mockReqRes({
      adminId: ctx.adminUserId,
      body: { communityId: 'abc', userId: ctx.targetUserId },
    });
    await removeMember(req, res);
    const r = await result;
    assert(r.status === 400, '400 when communityId is non-numeric string');
  }
}

async function testInvalidUserId() {
  console.log('\n[CASE] 400 — missing/non-int userId');

  // Missing userId
  {
    const { req, res, result } = mockReqRes({
      adminId: ctx.adminUserId,
      body: { communityId: ctx.communityId },
    });
    await removeMember(req, res);
    const r = await result;
    assert(r.status === 400, '400 when userId is missing');
    assert(typeof r.json.error === 'string' && r.json.error.toLowerCase().includes('userid'),
      'error message mentions userId');
  }

  // String userId that is not a number
  {
    const { req, res, result } = mockReqRes({
      adminId: ctx.adminUserId,
      body: { communityId: ctx.communityId, userId: 'not-a-number' },
    });
    await removeMember(req, res);
    const r = await result;
    assert(r.status === 400, '400 when userId is non-numeric string');
  }
}

async function testCommunityNotFound() {
  console.log('\n[CASE] 404 — community not found');

  const { req, res, result } = mockReqRes({
    adminId: ctx.adminUserId,
    body: { communityId: 999999999, userId: ctx.targetUserId },
  });
  await removeMember(req, res);
  const r = await result;
  assert(r.status === 404, '404 when community does not exist');
  assert(r.json.error === 'Community not found', 'correct error message');
}

async function testCallerNotAdmin() {
  console.log('\n[CASE] 403 — caller is not the community creator/admin');

  const { req, res, result } = mockReqRes({
    adminId: ctx.outsiderUserId,   // outsider is not the creator
    body: { communityId: ctx.communityId, userId: ctx.targetUserId },
  });
  await removeMember(req, res);
  const r = await result;
  assert(r.status === 403, '403 when caller is not the admin');
  assert(typeof r.json.error === 'string' && r.json.error.toLowerCase().includes('admin'),
    'error message mentions admin');
}

async function testCannotRemoveCreator() {
  console.log('\n[CASE] 403 — target is the creator (cannot remove creator)');

  const { req, res, result } = mockReqRes({
    adminId: ctx.adminUserId,
    body: { communityId: ctx.communityId, userId: ctx.adminUserId }, // targeting self = creator
  });
  await removeMember(req, res);
  const r = await result;
  assert(r.status === 403, '403 when trying to remove the creator');
  assert(typeof r.json.error === 'string' && r.json.error.toLowerCase().includes('creator'),
    'error message mentions creator');
}

async function testTargetNotMember() {
  console.log('\n[CASE] 404 — target user is not a member');

  const { req, res, result } = mockReqRes({
    adminId: ctx.adminUserId,
    body: { communityId: ctx.communityId, userId: ctx.outsiderUserId }, // outsider is not a member
  });
  await removeMember(req, res);
  const r = await result;
  assert(r.status === 404, '404 when target is not a member');
  assert(typeof r.json.error === 'string' && r.json.error.toLowerCase().includes('not a member'),
    'error message confirms not a member');
}

async function testSuccessAndDbEffects() {
  console.log('\n[CASE] 200 — admin successfully removes target member');

  // Re-add the target membership and chat row before this test in case a
  // prior test run left things cleaned up. Safe to ignore unique-constraint
  // errors; they just mean the row already exists.
  try {
    await prisma.communityMember.create({
      data: { userId: ctx.targetUserId, communityId: ctx.communityId },
    });
  } catch { /* already exists — fine */ }
  try {
    await prisma.userOnChat.create({
      data: { chatId: ctx.chatId, userId: ctx.targetUserId },
    });
  } catch { /* already exists — fine */ }

  const { req, res, result } = mockReqRes({
    adminId: ctx.adminUserId,
    body: { communityId: ctx.communityId, userId: ctx.targetUserId },
  });

  await removeMember(req, res);
  const r = await result;

  assert(r.status === 200, '200 OK response');
  assert(r.json.message === 'Member removed from community & chat', 'correct success message');

  // Verify communityMember row is gone
  const member = await prisma.communityMember.findFirst({
    where: { userId: ctx.targetUserId, communityId: ctx.communityId },
  });
  assert(member === null, 'DB: communityMember row deleted for target');

  // Verify userOnChat row is gone
  const userOnChat = await prisma.userOnChat.findFirst({
    where: { userId: ctx.targetUserId, chatId: ctx.chatId },
  });
  assert(userOnChat === null, 'DB: userOnChat row deleted for target');

  // Verify communityHistory 'left' row created for target
  const history = await prisma.communityHistory.findFirst({
    where: { userId: ctx.targetUserId, communityId: ctx.communityId, action: 'left' },
    orderBy: { createdAt: 'desc' },
  });
  assert(history !== null, 'DB: communityHistory action=left created for target');
}

// ── Baseline verification ─────────────────────────────────

async function verifyBaseline(label, expectedUsers, expectedCommunities, expectedMembers) {
  const [userCount, communityCount, memberCount] = await Promise.all([
    prisma.user.count(),
    prisma.community.count(),
    prisma.communityMember.count(),
  ]);
  console.log(`\n[BASELINE ${label}] users=${userCount} communities=${communityCount} members=${memberCount}`);
  assert(userCount === expectedUsers,       `${label}: user count = ${expectedUsers} (got ${userCount})`);
  assert(communityCount === expectedCommunities, `${label}: community count = ${expectedCommunities} (got ${communityCount})`);
  assert(memberCount === expectedMembers,    `${label}: member count = ${expectedMembers} (got ${memberCount})`);
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  console.log('=================================================');
  console.log('  removeMember controller — integration tests   ');
  console.log('=================================================');

  // Snapshot baseline BEFORE seeding
  const [baseUsers, baseCommunities, baseMembers] = await Promise.all([
    prisma.user.count(),
    prisma.community.count(),
    prisma.communityMember.count(),
  ]);
  console.log(`\n[BASELINE before seed] users=${baseUsers} communities=${baseCommunities} members=${baseMembers}`);

  try {
    await seed();

    // Run test cases in order. The 200/success case is last so the
    // membership record is still intact for the earlier 40x tests.
    await testInvalidCommunityId();
    await testInvalidUserId();
    await testCommunityNotFound();
    await testCallerNotAdmin();
    await testCannotRemoveCreator();
    await testTargetNotMember();
    await testSuccessAndDbEffects();

  } finally {
    await teardown();
    // Verify the DB returned to its prior state
    await verifyBaseline('after teardown', baseUsers, baseCommunities, baseMembers);
    await prisma.$disconnect();
  }

  // ── Final report ────────────────────────────────────────
  console.log('\n=================================================');
  console.log('  RESULTS');
  console.log('=================================================');
  console.log(`  Total : ${passed + failed}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failures.length) {
    console.log('\n  Failed cases:');
    failures.forEach((f) => console.log(`    - ${f}`));
  }
  console.log('=================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
