#!/usr/bin/env node
/**
 * End-to-end privacy test for:
 *   1. exports.getUserProfile  — controllers/friendController.js ~line 1431
 *   2. getUserStatsByUserId    — controllers/userController.js   ~line 873
 *
 * Strategy:
 *   - Call controllers directly with mock req/res (no HTTP server).
 *   - Use the LIVE DB via Prisma.
 *   - Seed deterministic fixtures, assert, tear down in finally.
 *   - Baseline counts recorded before seed; verified to return exactly
 *     to baseline after teardown.
 *
 * Usage:
 *   node tests/profile-privacy.test.js
 */

'use strict';

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

// ── Controllers under test ────────────────────────────────────────────────────
const { getUserProfile } = require('../controllers/friendController');
const { getUserStatsByUserId } = require('../controllers/userController');

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
    failures.push({ label, detail: null });
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
    const detail = `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push({ label, detail });
    console.log(`  FAIL  ${label}  [${detail}]`);
  }
}

function assertDeepEq(actual, expected, label) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  const ok = actualStr === expectedStr;
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    const detail = `expected ${expectedStr}, got ${actualStr}`;
    failures.push({ label, detail });
    console.log(`  FAIL  ${label}  [${detail}]`);
  }
}

/**
 * Build a minimal mock req/res pair matching the controller calling convention.
 * Returns { req, res, result } where result is a Promise<{ status, json }>.
 */
function mockReqRes({ viewerId, targetId, query = {} }) {
  let resolveFn;
  const result = new Promise((resolve) => { resolveFn = resolve; });

  const res = {
    _status: 200,
    status(code) { this._status = code; return this; },
    json(payload) { resolveFn({ status: this._status, json: payload }); return this; },
  };

  const req = {
    authData: { id: viewerId },
    params: { userId: String(targetId) },
    query,
  };

  return { req, res, result };
}

// ── Baseline ──────────────────────────────────────────────────────────────────

const baseline = {
  users: 0, friendships: 0, communities: 0, communityMembers: 0,
  stories: 0, locationPoints: 0,
};

async function recordBaseline() {
  const [users, friendships, communities, communityMembers, stories, locationPoints] =
    await Promise.all([
      prisma.user.count(),
      prisma.friendship.count(),
      prisma.community.count(),
      prisma.communityMember.count(),
      prisma.story.count(),
      prisma.locationPoint.count(),
    ]);
  Object.assign(baseline, { users, friendships, communities, communityMembers, stories, locationPoints });
  console.log(
    `[BASELINE] users:${users} friendships:${friendships} communities:${communities} ` +
    `communityMembers:${communityMembers} stories:${stories} locationPoints:${locationPoints}`
  );
}

async function verifyBaseline() {
  const [users, friendships, communities, communityMembers, stories, locationPoints] =
    await Promise.all([
      prisma.user.count(),
      prisma.friendship.count(),
      prisma.community.count(),
      prisma.communityMember.count(),
      prisma.story.count(),
      prisma.locationPoint.count(),
    ]);
  const after = { users, friendships, communities, communityMembers, stories, locationPoints };
  console.log('\n[DB BASELINE VERIFICATION]');
  let allMatch = true;
  for (const key of Object.keys(baseline)) {
    if (baseline[key] !== after[key]) {
      allMatch = false;
      console.log(`  LEAK  ${key}: baseline=${baseline[key]}, after=${after[key]}`);
    } else {
      console.log(`  OK    ${key}: ${after[key]}`);
    }
  }
  if (allMatch) {
    console.log('  DB returned exactly to baseline. No leaks.');
  } else {
    console.log('  WARNING: DB did NOT return to baseline. Some rows were not cleaned up.');
  }
  return allMatch;
}

// ── Fixture context ───────────────────────────────────────────────────────────
// Users:
//   V  = viewer (the one making all requests)
//   F1 = friend of V, isProfilePrivate=true   (case 2: friend+private)
//   F2 = friend of V, isProfilePrivate=false  (case 3: friend+public)
//   PUB = non-friend, isProfilePrivate=false  (case 4: non-friend+public)
//   PRV = non-friend, isProfilePrivate=true   (case 5: non-friend+private)
//   X   = V sent friend request to X (PENDING_SENT), X is private (case 6)
//   Y   = Y sent friend request to V (PENDING_RECEIVED), Y is public (case 7)

const ctx = {
  V: null, F1: null, F2: null, PUB: null, PRV: null, X: null, Y: null,
  community: null,
};

async function seed() {
  const hash = await bcrypt.hash('TestPass!1', 10);

  // Helper to create a test user
  async function createUser(suffix, extra = {}) {
    return prisma.user.create({
      data: {
        username: `test-privacy-${suffix}-${Date.now()}`,
        email: `test-privacy-${suffix}-${Date.now()}@example.com`,
        password: hash,
        isVerified: true,
        firstName: `First${suffix}`,
        lastName: `Last${suffix}`,
        bio: `Bio for ${suffix}`,
        totalPoints: 100,
        ...extra,
      },
    });
  }

  // Create all users
  [ctx.V, ctx.F1, ctx.F2, ctx.PUB, ctx.PRV, ctx.X, ctx.Y] = await Promise.all([
    createUser('V'),
    createUser('F1', { isProfilePrivate: true }),
    createUser('F2', { isProfilePrivate: false }),
    createUser('PUB', { isProfilePrivate: false }),
    createUser('PRV', { isProfilePrivate: true }),
    createUser('X', { isProfilePrivate: true }),
    createUser('Y', { isProfilePrivate: false }),
  ]);

  // Create a community owned by V and join F1, F2 into it
  ctx.community = await prisma.community.create({
    data: {
      name: `test-privacy-community-${Date.now()}`,
      creatorId: ctx.V.id,
    },
  });

  // Add community memberships for V, F1, F2
  await prisma.communityMember.createMany({
    data: [
      { userId: ctx.V.id, communityId: ctx.community.id },
      { userId: ctx.F1.id, communityId: ctx.community.id },
      { userId: ctx.F2.id, communityId: ctx.community.id },
    ],
  });

  // Add a profile-visible story for V, F1, F2
  await prisma.story.createMany({
    data: [
      { userId: ctx.V.id, mediaUrl: 'https://example.com/v-story.jpg', type: 'IMAGE', visibility: 'profile', status: 'ACTIVE' },
      { userId: ctx.F1.id, mediaUrl: 'https://example.com/f1-story.jpg', type: 'IMAGE', visibility: 'profile', status: 'ACTIVE' },
      { userId: ctx.F2.id, mediaUrl: 'https://example.com/f2-story.jpg', type: 'IMAGE', visibility: 'profile', status: 'ACTIVE' },
      { userId: ctx.PRV.id, mediaUrl: 'https://example.com/prv-story.jpg', type: 'IMAGE', visibility: 'profile', status: 'ACTIVE' },
    ],
  });

  // Add locationPoints for V, F1, F2 (so spotsVisited > 0 when visible)
  await prisma.locationPoint.createMany({
    data: [
      { userId: ctx.V.id, mediaUrl: 'https://example.com/v-loc.jpg', placeId: 'place-v-1', placeName: 'Place V1', latitude: 40.7128, longitude: -74.0060, points: 5 },
      { userId: ctx.F1.id, mediaUrl: 'https://example.com/f1-loc.jpg', placeId: 'place-f1-1', placeName: 'Place F1', latitude: 40.7129, longitude: -74.0061, points: 5 },
      { userId: ctx.F2.id, mediaUrl: 'https://example.com/f2-loc.jpg', placeId: 'place-f2-1', placeName: 'Place F2', latitude: 40.7130, longitude: -74.0062, points: 5 },
    ],
  });

  // Friendships:
  //   V <-> F1: ACCEPTED  (V is requester)
  //   V <-> F2: ACCEPTED  (V is requester)
  //   V -> X:   PENDING   (V is requester = PENDING_SENT from V's perspective)
  //   Y -> V:   PENDING   (Y is requester = PENDING_RECEIVED from V's perspective)
  await prisma.friendship.createMany({
    data: [
      { requesterId: ctx.V.id, receiverId: ctx.F1.id, status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.V.id, receiverId: ctx.F2.id, status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.V.id, receiverId: ctx.X.id, status: 'PENDING' },
      { requesterId: ctx.Y.id, receiverId: ctx.V.id, status: 'PENDING' },
    ],
  });

  console.log(`[SEED] V=${ctx.V.id} F1=${ctx.F1.id} F2=${ctx.F2.id} PUB=${ctx.PUB.id} PRV=${ctx.PRV.id} X=${ctx.X.id} Y=${ctx.Y.id}`);
}

async function teardown() {
  const ids = [ctx.V, ctx.F1, ctx.F2, ctx.PUB, ctx.PRV, ctx.X, ctx.Y]
    .filter(Boolean)
    .map((u) => u.id);

  if (ids.length === 0) return;

  // Cascades handle friendships, stories, locationPoints, communityMembers
  // Delete community first (foreign key: creatorId)
  if (ctx.community) {
    await prisma.community.deleteMany({ where: { id: ctx.community.id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

// ── Test runner helpers ───────────────────────────────────────────────────────

async function callGetUserProfile(viewerId, targetId) {
  const { req, res, result } = mockReqRes({ viewerId, targetId });
  getUserProfile(req, res);
  return result;
}

async function callGetUserStatsByUserId(viewerId, targetId) {
  const { req, res, result } = mockReqRes({ viewerId, targetId });
  getUserStatsByUserId(req, res);
  return result;
}

// ── Test suites ───────────────────────────────────────────────────────────────

async function testGetUserProfile() {
  console.log('\n══════════════════════════════════════════');
  console.log('getUserProfile (friendController.js ~1431)');
  console.log('══════════════════════════════════════════');

  // ─────────────────────────────────────────────────────────────────────
  // CASE 1: Self (V views V)
  // isSelf=true, isPrivate=false, rich data present
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n--- Case 1: Self view ---');
  {
    const r = await callGetUserProfile(ctx.V.id, ctx.V.id);
    assertEq(r.status, 200, 'C1: status 200');
    assertEq(r.json?.success, true, 'C1: success=true');
    const d = r.json?.data;
    assert(!!d, 'C1: data present');
    assertEq(d?.isSelf, true, 'C1: isSelf=true');
    assertEq(d?.isPrivate, false, 'C1: isPrivate=false');
    assertEq(d?.friendshipStatus, 'NONE', 'C1: friendshipStatus=NONE (self → no relationship row)');
    assertEq(d?.isFriend, false, 'C1: isFriend=false for self');
    assert(typeof d?.totalPoints === 'number', 'C1: totalPoints present');
    assert(typeof d?.thisWeekPoints === 'number', 'C1: thisWeekPoints present');
    assert(d?.firstName === 'FirstV', 'C1: firstName populated');
    // Rich data: communities, stories, recentVisitedSpots should be present
    assert(Array.isArray(d?.communities), 'C1: communities is array');
    assert(d?.communities?.length >= 1, 'C1: communities has seeded entry');
    assert(Array.isArray(d?.stories), 'C1: stories is array');
    assert(d?.stories?.length >= 1, 'C1: stories has seeded profile story');
    assert(Array.isArray(d?.recentVisitedSpots), 'C1: recentVisitedSpots is array');
    assert(d?.spotsVisited >= 1, 'C1: spotsVisited >= 1');
    assert(d?.bio === 'Bio for V', 'C1: bio populated (not null)');
    assert(d?.id === ctx.V.id, 'C1: correct user id returned');
  }

  // ─────────────────────────────────────────────────────────────────────
  // CASE 2: Friend, target PRIVATE (F1)
  // isFriend=true → isPrivate=false (friend bypass), rich data present
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n--- Case 2: Friend + private target ---');
  {
    const r = await callGetUserProfile(ctx.V.id, ctx.F1.id);
    assertEq(r.status, 200, 'C2: status 200');
    const d = r.json?.data;
    assertEq(d?.isSelf, false, 'C2: isSelf=false');
    assertEq(d?.isFriend, true, 'C2: isFriend=true');
    assertEq(d?.isPrivate, false, 'C2: isPrivate=false (friend bypass)');
    assertEq(d?.friendshipStatus, 'ACCEPTED', 'C2: friendshipStatus=ACCEPTED');
    assert(Array.isArray(d?.communities), 'C2: communities array');
    assert(d?.communities?.length >= 1, 'C2: communities populated');
    assert(Array.isArray(d?.stories), 'C2: stories array');
    assert(d?.stories?.length >= 1, 'C2: stories populated');
    assert(d?.spotsVisited >= 1, 'C2: spotsVisited >= 1');
    assert(d?.bio === 'Bio for F1', 'C2: bio populated');
  }

  // ─────────────────────────────────────────────────────────────────────
  // CASE 3: Friend, target PUBLIC (F2)
  // isPrivate=false, friendshipStatus=ACCEPTED, data present
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n--- Case 3: Friend + public target ---');
  {
    const r = await callGetUserProfile(ctx.V.id, ctx.F2.id);
    assertEq(r.status, 200, 'C3: status 200');
    const d = r.json?.data;
    assertEq(d?.isPrivate, false, 'C3: isPrivate=false');
    assertEq(d?.isFriend, true, 'C3: isFriend=true');
    assertEq(d?.friendshipStatus, 'ACCEPTED', 'C3: friendshipStatus=ACCEPTED');
    assert(d?.spotsVisited >= 1, 'C3: spotsVisited >= 1');
    assert(Array.isArray(d?.communities) && d.communities.length >= 1, 'C3: communities populated');
    assert(d?.bio === 'Bio for F2', 'C3: bio populated');
  }

  // ─────────────────────────────────────────────────────────────────────
  // CASE 4: Non-friend, target PUBLIC (PUB)
  // isPrivate=false, NO 403, rich data present, friendshipStatus=NONE
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n--- Case 4: Non-friend + public target ---');
  {
    const r = await callGetUserProfile(ctx.V.id, ctx.PUB.id);
    assertEq(r.status, 200, 'C4: status 200 (no 403)');
    assert(r.json?.success === true, 'C4: success=true');
    const d = r.json?.data;
    assertEq(d?.isPrivate, false, 'C4: isPrivate=false');
    assertEq(d?.isFriend, false, 'C4: isFriend=false');
    assertEq(d?.isSelf, false, 'C4: isSelf=false');
    assertEq(d?.friendshipStatus, 'NONE', 'C4: friendshipStatus=NONE');
    // Public non-friend: rich sections should be populated (PUB has no stories/spots seeded
    // so they're empty arrays, but the sections exist and are not null-gated)
    assert(Array.isArray(d?.stories), 'C4: stories is array');
    assert(Array.isArray(d?.communities), 'C4: communities is array');
    assert(Array.isArray(d?.recentVisitedSpots), 'C4: recentVisitedSpots is array');
    assert(typeof d?.spotsVisited === 'number', 'C4: spotsVisited is number');
    assert(d?.bio === 'Bio for PUB', 'C4: bio returned for public non-friend');
    // Identity fields
    assert(d?.firstName === 'FirstPUB', 'C4: firstName present');
    assert(typeof d?.totalPoints === 'number', 'C4: totalPoints present');
  }

  // ─────────────────────────────────────────────────────────────────────
  // CASE 5: Non-friend, target PRIVATE (PRV)
  // isPrivate=true, rich sections EMPTY, identity+points still present
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n--- Case 5: Non-friend + private target ---');
  {
    const r = await callGetUserProfile(ctx.V.id, ctx.PRV.id);
    assertEq(r.status, 200, 'C5: status 200 (no 403)');
    assert(r.json?.success === true, 'C5: success=true');
    const d = r.json?.data;
    assertEq(d?.isPrivate, true, 'C5: isPrivate=true');
    assertEq(d?.isFriend, false, 'C5: isFriend=false');
    assertEq(d?.isSelf, false, 'C5: isSelf=false');
    assertEq(d?.friendshipStatus, 'NONE', 'C5: friendshipStatus=NONE');
    // Rich sections must be empty
    assertDeepEq(d?.friends, [], 'C5: friends=[]');
    assertEq(d?.friendCount, 0, 'C5: friendCount=0');
    assertEq(d?.spotsVisited, 0, 'C5: spotsVisited=0');
    assertDeepEq(d?.communities, [], 'C5: communities=[]');
    assertDeepEq(d?.stories, [], 'C5: stories=[]');
    assertDeepEq(d?.recentVisitedSpots, [], 'C5: recentVisitedSpots=[]');
    assertEq(d?.mostRecent, null, 'C5: mostRecent=null');
    assertEq(d?.bio, null, 'C5: bio=null');
    // Identity fields still populated
    assert(d?.firstName === 'FirstPRV', 'C5: firstName still present');
    assert(typeof d?.totalPoints === 'number', 'C5: totalPoints present');
    assert(typeof d?.thisWeekPoints === 'number', 'C5: thisWeekPoints present');
    assert(d?.id === ctx.PRV.id, 'C5: id present');
    assert(d?.username?.length > 0, 'C5: username present');
  }

  // ─────────────────────────────────────────────────────────────────────
  // CASE 6: PENDING_SENT — V sent request to X (X is private)
  // friendshipStatus=PENDING_SENT, isPrivate=true (X is private + not friend)
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n--- Case 6: Pending sent + private target ---');
  {
    const r = await callGetUserProfile(ctx.V.id, ctx.X.id);
    assertEq(r.status, 200, 'C6: status 200');
    const d = r.json?.data;
    assertEq(d?.friendshipStatus, 'PENDING_SENT', 'C6: friendshipStatus=PENDING_SENT');
    assertEq(d?.isFriend, false, 'C6: isFriend=false (pending ≠ accepted)');
    assertEq(d?.isPrivate, true, 'C6: isPrivate=true (X private, pending request)');
    assertDeepEq(d?.friends, [], 'C6: friends=[] (private gated)');
    assertEq(d?.spotsVisited, 0, 'C6: spotsVisited=0 (private gated)');
    assertDeepEq(d?.stories, [], 'C6: stories=[] (private gated)');
    assertEq(d?.bio, null, 'C6: bio=null (private gated)');
    // Identity still present
    assert(d?.firstName === 'FirstX', 'C6: firstName present');
  }

  // ─────────────────────────────────────────────────────────────────────
  // CASE 7: PENDING_RECEIVED — Y sent request to V (Y is public)
  // friendshipStatus=PENDING_RECEIVED, isPrivate=false (Y public)
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n--- Case 7: Pending received + public target ---');
  {
    const r = await callGetUserProfile(ctx.V.id, ctx.Y.id);
    assertEq(r.status, 200, 'C7: status 200');
    const d = r.json?.data;
    assertEq(d?.friendshipStatus, 'PENDING_RECEIVED', 'C7: friendshipStatus=PENDING_RECEIVED');
    assertEq(d?.isFriend, false, 'C7: isFriend=false');
    assertEq(d?.isPrivate, false, 'C7: isPrivate=false (Y is public)');
    // Public profile: rich sections accessible even with pending request
    assert(Array.isArray(d?.stories), 'C7: stories is array');
    assert(Array.isArray(d?.communities), 'C7: communities is array');
    assert(d?.bio === 'Bio for Y', 'C7: bio populated (public)');
    assert(d?.firstName === 'FirstY', 'C7: firstName present');
  }
}

async function testGetUserStatsByUserId() {
  console.log('\n══════════════════════════════════════════');
  console.log('getUserStatsByUserId (userController.js ~873)');
  console.log('══════════════════════════════════════════');

  // ─────────────────────────────────────────────────────────────────────
  // CASE 8: Self (V views V)
  // friendshipStatus=SELF, isPrivate=false, real stats
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n--- Case 8: Self stats ---');
  {
    const r = await callGetUserStatsByUserId(ctx.V.id, ctx.V.id);
    assertEq(r.status, 200, 'C8: status 200');
    assertEq(r.json?.success, true, 'C8: success=true');
    const d = r.json?.data;
    assert(!!d, 'C8: data present');
    assertEq(d?.userId, ctx.V.id, 'C8: userId matches');
    assertEq(d?.friendshipStatus, 'SELF', 'C8: friendshipStatus=SELF');
    assertEq(d?.isPrivate, false, 'C8: isPrivate=false');
    // Real stats: V has 1 community membership + 2 friendships (F1, F2)
    assert(typeof d?.spotsVisited === 'number', 'C8: spotsVisited is number');
    assert(d?.spotsVisited >= 1, 'C8: spotsVisited >= 1 (seeded 1 locationPoint)');
    assert(typeof d?.friends === 'number', 'C8: friends is number');
    assert(d?.friends >= 2, 'C8: friends >= 2 (F1, F2 accepted)');
    assert(typeof d?.community === 'number', 'C8: community is number');
    assert(d?.community >= 1, 'C8: community >= 1 (seeded membership)');
    assert(typeof d?.challengesCompleted === 'number', 'C8: challengesCompleted is number');
    // V created the community so myCommunity should be populated
    assert(d?.myCommunity !== undefined, 'C8: myCommunity field present');
    // bodyType can be null (none seeded) — just check field exists
    assert('bodyType' in d, 'C8: bodyType field present');
  }

  // ─────────────────────────────────────────────────────────────────────
  // CASE 9: Friend of private target (V views F1 — F1 is private, V is friend)
  // isPrivate=false (friend bypass), real stats, friendshipStatus=ACCEPTED
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n--- Case 9: Friend + private target stats ---');
  {
    const r = await callGetUserStatsByUserId(ctx.V.id, ctx.F1.id);
    assertEq(r.status, 200, 'C9: status 200');
    const d = r.json?.data;
    assertEq(d?.userId, ctx.F1.id, 'C9: userId=F1');
    assertEq(d?.friendshipStatus, 'ACCEPTED', 'C9: friendshipStatus=ACCEPTED');
    assertEq(d?.isPrivate, false, 'C9: isPrivate=false (friend bypass)');
    // Real stats for F1: 1 community membership + 1 friendship (V)
    assert(d?.spotsVisited >= 1, 'C9: spotsVisited >= 1');
    assert(d?.friends >= 1, 'C9: friends >= 1 (V is friend)');
    assert(d?.community >= 1, 'C9: community >= 1');
    // F1 is not the community creator so myCommunity may be null
    assert('myCommunity' in d, 'C9: myCommunity field present');
  }

  // ─────────────────────────────────────────────────────────────────────
  // CASE 10: Non-friend + PRIVATE target (V views PRV)
  // isPrivate=true, all stat numbers 0/null, friendshipStatus=NONE
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n--- Case 10: Non-friend + private target stats ---');
  {
    const r = await callGetUserStatsByUserId(ctx.V.id, ctx.PRV.id);
    assertEq(r.status, 200, 'C10: status 200');
    assertEq(r.json?.success, true, 'C10: success=true');
    const d = r.json?.data;
    assertEq(d?.userId, ctx.PRV.id, 'C10: userId=PRV');
    assertEq(d?.isPrivate, true, 'C10: isPrivate=true');
    assertEq(d?.friendshipStatus, 'NONE', 'C10: friendshipStatus=NONE');
    // All stat numbers must be 0 or null
    assertEq(d?.spotsVisited, 0, 'C10: spotsVisited=0');
    assertEq(d?.friends, 0, 'C10: friends=0');
    assertEq(d?.community, 0, 'C10: community=0');
    assertEq(d?.challengesCompleted, 0, 'C10: challengesCompleted=0');
    assertEq(d?.myCommunity, null, 'C10: myCommunity=null');
    assertEq(d?.bodyType, null, 'C10: bodyType=null');
  }

  // ─────────────────────────────────────────────────────────────────────
  // CASE 11: Non-friend + PUBLIC target (V views PUB)
  // isPrivate=false, real stats, friendshipStatus=NONE
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n--- Case 11: Non-friend + public target stats ---');
  {
    const r = await callGetUserStatsByUserId(ctx.V.id, ctx.PUB.id);
    assertEq(r.status, 200, 'C11: status 200');
    assertEq(r.json?.success, true, 'C11: success=true');
    const d = r.json?.data;
    assertEq(d?.userId, ctx.PUB.id, 'C11: userId=PUB');
    assertEq(d?.isPrivate, false, 'C11: isPrivate=false');
    assertEq(d?.friendshipStatus, 'NONE', 'C11: friendshipStatus=NONE');
    // PUB has no seeded location points or communities, so:
    assertEq(d?.spotsVisited, 0, 'C11: spotsVisited=0 (none seeded for PUB)');
    assert(typeof d?.friends === 'number', 'C11: friends is number');
    assert(typeof d?.community === 'number', 'C11: community is number');
    assert(typeof d?.challengesCompleted === 'number', 'C11: challengesCompleted is number');
    // Real stats path reached (not private gate)
    assert('bodyType' in d, 'C11: bodyType field present');
    assert('myCommunity' in d, 'C11: myCommunity field present');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Profile Privacy End-to-End Tests ===\n');

  let dbReturned = false;

  try {
    await recordBaseline();
    await seed();

    await testGetUserProfile();
    await testGetUserStatsByUserId();

  } finally {
    console.log('\n[TEARDOWN] Cleaning up seeded fixtures...');
    try {
      await teardown();
      console.log('[TEARDOWN] Done.');
    } catch (err) {
      console.error('[TEARDOWN ERROR]', err.message);
    }

    dbReturned = await verifyBaseline();

    await prisma.$disconnect();
  }

  // ── Final report ─────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════');
  console.log('FINAL RESULTS');
  console.log('══════════════════════════════════════════');

  const total = passed + failed;
  console.log(`Total:  ${total}`);
  console.log(`Passed: ${passed} ✓`);
  console.log(`Failed: ${failed} ✗`);
  console.log(`DB baseline restored: ${dbReturned ? 'YES' : 'NO — LEAK DETECTED'}`);

  if (failures.length > 0) {
    console.log('\nFAILURES:');
    failures.forEach(({ label, detail }, i) => {
      console.log(`  ${i + 1}. ${label}`);
      if (detail) console.log(`     -> ${detail}`);
    });
  }

  console.log('══════════════════════════════════════════');

  // Exit non-zero so CI fails on test failures
  if (failed > 0 || !dbReturned) process.exit(1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  prisma.$disconnect();
  process.exit(1);
});
