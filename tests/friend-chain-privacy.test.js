#!/usr/bin/env node
/**
 * End-to-end test: friend-of-friend DRILL-DOWN CHAIN self-terminates at a private profile.
 *
 * Claim under test:
 *   A user navigating by repeatedly tapping friends-of-friends can CONTINUE through
 *   PUBLIC (or friend) profiles (non-empty friends list returned) and STOPS the moment
 *   they open a PRIVATE profile that is NOT their friend (friends list is EMPTY, so
 *   there is nothing left to tap).
 *
 * Strategy:
 *   - Call exports.getUserProfile (controllers/friendController.js ~line 1470) directly
 *     with mocked req/res objects — no HTTP server.
 *   - Use the LIVE DB via Prisma.
 *   - Seed a deliberate linear chain: V → B (public) → C (public) → D (private) → E (public).
 *   - Record baseline counts BEFORE seeding; verify EXACT restoration in the finally block.
 *   - A negative-control sub-case temporarily makes V friends with D to prove the gate
 *     opens correctly for friends, then tears that friendship down before final cleanup.
 *
 * Graph:
 *   V   — viewer
 *   B   — PUBLIC, NOT V's friend. B's friends: C, Bx (extra accepted friend)
 *   C   — PUBLIC, NOT V's friend. C is B's friend. C's friends: D, Cx (extra accepted friend)
 *   D   — PRIVATE (isProfilePrivate=true), NOT V's friend. D is C's friend. D's friends: E, Dx
 *   E   — PUBLIC. E is D's friend. E exists to give D a real (but hidden) friend list in the DB.
 *   Bx  — extra friend of B (makes B's friend list genuinely non-empty beyond just C)
 *   Cx  — extra friend of C (makes C's friend list genuinely non-empty beyond just D)
 *   Dx  — extra friend of D (makes D's friend list genuinely non-empty beyond just E)
 *
 * Usage:
 *   node tests/friend-chain-privacy.test.js
 */

'use strict';

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

// Controller under test
const { getUserProfile } = require('../controllers/friendController');

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

// ── Baseline tracking ─────────────────────────────────────────────────────────

const baseline = {
  users: 0,
  friendships: 0,
  communities: 0,
  communityMembers: 0,
  stories: 0,
  locationPoints: 0,
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
    console.log('  WARNING: DB did NOT return to baseline. Rows were not fully cleaned up.');
  }
  return allMatch;
}

// ── Fixture context ───────────────────────────────────────────────────────────

const ctx = {
  V: null,   // viewer
  B: null,   // public, NOT V's friend; friends: C, Bx
  C: null,   // public, NOT V's friend; B's friend; C's friends: D, Cx
  D: null,   // PRIVATE, NOT V's friend; C's friend; D's friends: E, Dx
  E: null,   // public; D's friend (gives D a real friend list)
  Bx: null,  // extra friend of B
  Cx: null,  // extra friend of C
  Dx: null,  // extra friend of D
};

async function seed() {
  const hash = await bcrypt.hash('TestChain!1', 10);
  const ts = Date.now();

  async function createUser(tag, extra = {}) {
    return prisma.user.create({
      data: {
        username:    `test-chain-${tag}-${ts}`,
        email:       `test-chain-${tag}-${ts}@example.com`,
        password:    hash,
        isVerified:  true,
        firstName:   `Chain${tag}`,
        lastName:    `Tester`,
        bio:         `Bio for ${tag}`,
        totalPoints: 10,
        isProfilePrivate: false,
        ...extra,
      },
    });
  }

  // Create all users in parallel
  [ctx.V, ctx.B, ctx.C, ctx.D, ctx.E, ctx.Bx, ctx.Cx, ctx.Dx] = await Promise.all([
    createUser('V'),
    createUser('B'),
    createUser('C'),
    createUser('D', { isProfilePrivate: true }),
    createUser('E'),
    createUser('Bx'),
    createUser('Cx'),
    createUser('Dx'),
  ]);

  // Friendships — all ACCEPTED:
  //   B <-> C   (chain hop 1→2)
  //   B <-> Bx  (B has extra friend so list is truly multi-member)
  //   C <-> D   (chain hop 2→3)
  //   C <-> Cx  (C has extra friend)
  //   D <-> E   (D has E as friend — hidden by privacy gate)
  //   D <-> Dx  (D has Dx as second friend — also hidden)
  //
  // V has NO friendship with B, C, D, E, Bx, Cx, or Dx.
  await prisma.friendship.createMany({
    data: [
      { requesterId: ctx.B.id,  receiverId: ctx.C.id,  status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.B.id,  receiverId: ctx.Bx.id, status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.C.id,  receiverId: ctx.D.id,  status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.C.id,  receiverId: ctx.Cx.id, status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.D.id,  receiverId: ctx.E.id,  status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.D.id,  receiverId: ctx.Dx.id, status: 'ACCEPTED', acceptedAt: new Date() },
    ],
  });

  console.log(
    `[SEED] V=${ctx.V.id} B=${ctx.B.id} C=${ctx.C.id} D=${ctx.D.id} ` +
    `E=${ctx.E.id} Bx=${ctx.Bx.id} Cx=${ctx.Cx.id} Dx=${ctx.Dx.id}`
  );
  console.log(`[SEED] D.isProfilePrivate=${ctx.D.isProfilePrivate} (must be true)`);
}

async function teardown() {
  const users = [ctx.V, ctx.B, ctx.C, ctx.D, ctx.E, ctx.Bx, ctx.Cx, ctx.Dx].filter(Boolean);
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  // Friendship rows have onDelete: Cascade from User, so deleting users cascades all
  // friendships, stories, locationPoints, communityMembers automatically.
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

// ── Mock req/res factory ──────────────────────────────────────────────────────

function callGetUserProfile(viewerId, targetId) {
  let resolveFn;
  const result = new Promise((res) => { resolveFn = res; });

  const mockRes = {
    _status: 200,
    status(code) { this._status = code; return this; },
    json(payload) { resolveFn({ status: this._status, json: payload }); return this; },
  };

  const mockReq = {
    authData: { id: viewerId },
    params:   { userId: String(targetId) },
    query:    {},
  };

  getUserProfile(mockReq, mockRes);
  return result;
}

// ── Helper ────────────────────────────────────────────────────────────────────

function findById(arr, id) {
  return Array.isArray(arr) ? arr.find((item) => item.id === id) : undefined;
}

// ── Test suite ────────────────────────────────────────────────────────────────

async function runChainDrillTest() {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('Friend-of-Friend Drill-Down Chain Privacy Test');
  console.log('Simulates the in-app navigation: V opens B → C → D (dead end)');
  console.log('══════════════════════════════════════════════════════════════════════');

  // ──────────────────────────────────────────────────────────────────────────
  // HOP 1: V opens B (public, non-friend)
  // Expectation: isPrivate=false, friends NON-EMPTY, C present in list
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- HOP 1: V opens B (public, NOT V\'s friend) ---');

  const hop1 = await callGetUserProfile(ctx.V.id, ctx.B.id);

  assertEq(hop1.status, 200,
    'HOP1: status 200');
  assertEq(hop1.json?.success, true,
    'HOP1: success=true');

  const hop1Data = hop1.json?.data;
  assert(!!hop1Data,
    'HOP1: data object present');
  assertEq(hop1Data?.isPrivate, false,
    'HOP1: isPrivate=false (B is public)');
  assertEq(hop1Data?.isFriend, false,
    'HOP1: isFriend=false (V and B are not friends)');
  assertEq(hop1Data?.isSelf, false,
    'HOP1: isSelf=false');
  assertEq(hop1Data?.friendshipStatus, 'NONE',
    'HOP1: friendshipStatus=NONE');

  const hop1Friends = hop1Data?.friends;
  assert(Array.isArray(hop1Friends),
    'HOP1: data.friends is an array');
  assert(hop1Friends?.length >= 2,
    `HOP1: data.friends is NON-EMPTY (B has C and Bx; got length=${hop1Friends?.length})`);

  // C must be present — it is the next hop
  const cInB = findById(hop1Friends, ctx.C.id);
  assert(!!cInB,
    'HOP1: C is present in B.friends (chain can continue to C)');

  // V and C are not friends, so C's status badge relative to V must be NONE
  assertEq(cInB?.friendshipStatus, 'NONE',
    'HOP1: C.friendshipStatus="NONE" relative to V (V and C are not friends)');

  // Bx must also be present (proves the list is genuinely populated, not just C)
  const bxInB = findById(hop1Friends, ctx.Bx.id);
  assert(!!bxInB,
    'HOP1: Bx is present in B.friends (list is genuinely populated)');

  // D must NOT appear in B's friends (D is C's friend, not B's)
  const dInB = findById(hop1Friends, ctx.D.id);
  assert(!dInB,
    'HOP1: D is NOT in B.friends (D is only C\'s friend, not B\'s — sanity check)');

  console.log('  --> HOP 1 COMPLETE: chain can continue (B.friends is non-empty, C found)');

  // ──────────────────────────────────────────────────────────────────────────
  // HOP 2: V opens C (public, non-friend) — arrived via B.friends
  // Expectation: isPrivate=false, friends NON-EMPTY, D present in list
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- HOP 2: V opens C (public, NOT V\'s friend, arrived via B.friends) ---');

  const hop2 = await callGetUserProfile(ctx.V.id, ctx.C.id);

  assertEq(hop2.status, 200,
    'HOP2: status 200');
  assertEq(hop2.json?.success, true,
    'HOP2: success=true');

  const hop2Data = hop2.json?.data;
  assert(!!hop2Data,
    'HOP2: data object present');
  assertEq(hop2Data?.isPrivate, false,
    'HOP2: isPrivate=false (C is public)');
  assertEq(hop2Data?.isFriend, false,
    'HOP2: isFriend=false (V and C are not friends)');
  assertEq(hop2Data?.isSelf, false,
    'HOP2: isSelf=false');
  assertEq(hop2Data?.friendshipStatus, 'NONE',
    'HOP2: friendshipStatus=NONE');

  const hop2Friends = hop2Data?.friends;
  assert(Array.isArray(hop2Friends),
    'HOP2: data.friends is an array');
  assert(hop2Friends?.length >= 2,
    `HOP2: data.friends is NON-EMPTY (C has D and Cx; got length=${hop2Friends?.length})`);

  // D must be present — it is the next hop
  const dInC = findById(hop2Friends, ctx.D.id);
  assert(!!dInC,
    'HOP2: D is present in C.friends (chain can continue to D)');

  // V and D are not friends, and D is private, but D still appears in the LIST
  // of C's friends. The privacy gate fires when V actually opens D's profile —
  // not when D appears as an item in someone else's friend list.
  // D's friendshipStatus badge from V's perspective: NONE
  assertEq(dInC?.friendshipStatus, 'NONE',
    'HOP2: D.friendshipStatus="NONE" relative to V (no relationship between V and D)');

  // Cx must also be present
  const cxInC = findById(hop2Friends, ctx.Cx.id);
  assert(!!cxInC,
    'HOP2: Cx is present in C.friends (list is genuinely populated)');

  console.log('  --> HOP 2 COMPLETE: chain can continue (C.friends is non-empty, D found)');

  // ──────────────────────────────────────────────────────────────────────────
  // HOP 3: V opens D (PRIVATE, non-friend) — arrived via C.friends
  // THIS IS WHERE THE CHAIN MUST STOP.
  // Expectation: isPrivate=true, friends=[], friendCount=0, stories=[], communities=[]
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- HOP 3: V opens D (PRIVATE, NOT V\'s friend) — CHAIN TERMINATION POINT ---');

  const hop3 = await callGetUserProfile(ctx.V.id, ctx.D.id);

  assertEq(hop3.status, 200,
    'HOP3: status 200 (200 with empty payload, not 403)');
  assertEq(hop3.json?.success, true,
    'HOP3: success=true');

  const hop3Data = hop3.json?.data;
  assert(!!hop3Data,
    'HOP3: data object present');
  assertEq(hop3Data?.isPrivate, true,
    'HOP3: isPrivate=true (D is private and V is not D\'s friend)');
  assertEq(hop3Data?.isFriend, false,
    'HOP3: isFriend=false');
  assertEq(hop3Data?.isSelf, false,
    'HOP3: isSelf=false');
  assertEq(hop3Data?.friendshipStatus, 'NONE',
    'HOP3: friendshipStatus=NONE');

  // The critical assertion: friends list MUST be empty — nothing to tap
  const hop3Friends = hop3Data?.friends;
  assertDeepEq(hop3Friends, [],
    'HOP3: data.friends === [] (EMPTY — chain terminates here, nothing left to tap)');
  assertEq(hop3Data?.friendCount, 0,
    'HOP3: friendCount===0 (privacy gate hides count)');
  assertDeepEq(hop3Data?.stories, [],
    'HOP3: stories=[] (hidden by privacy gate)');
  assertDeepEq(hop3Data?.communities, [],
    'HOP3: communities=[] (hidden by privacy gate)');
  assertDeepEq(hop3Data?.recentVisitedSpots, [],
    'HOP3: recentVisitedSpots=[] (hidden by privacy gate)');
  assertEq(hop3Data?.spotsVisited, 0,
    'HOP3: spotsVisited=0 (hidden by privacy gate)');
  assertEq(hop3Data?.mostRecent, null,
    'HOP3: mostRecent=null (hidden by privacy gate)');
  assertEq(hop3Data?.bio, null,
    'HOP3: bio=null (hidden by privacy gate)');

  // Identity fields must still be present (app needs them to render the lock screen)
  assert(typeof hop3Data?.id === 'number',
    'HOP3: id present (identity visible)');
  assert(typeof hop3Data?.username === 'string' && hop3Data.username.length > 0,
    'HOP3: username present (identity visible)');
  assert(hop3Data?.firstName === 'ChainD',
    'HOP3: firstName present (identity visible)');
  assert(typeof hop3Data?.totalPoints === 'number',
    'HOP3: totalPoints present (identity visible)');
  assert(typeof hop3Data?.thisWeekPoints === 'number',
    'HOP3: thisWeekPoints present (identity visible)');

  console.log('  --> HOP 3: CHAIN STOPPED. friends=[] — nothing to tap further.');

  // ──────────────────────────────────────────────────────────────────────────
  // DEAD-END PROOF: E IS D's friend in the DB but must NOT be reachable
  // Confirm at DB level that D actually HAS friends (the data exists but was hidden)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- DEAD-END PROOF: confirm E is D\'s friend in DB (data exists, was hidden) ---');

  const dFriendshipCount = await prisma.friendship.count({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: ctx.D.id },
        { receiverId: ctx.D.id },
      ],
    },
  });

  assert(dFriendshipCount >= 2,
    `DEAD-END: D has ${dFriendshipCount} accepted friends in DB (E and Dx exist — data is real, not absent)`);

  const eIsReallyDsFriend = await prisma.friendship.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: ctx.D.id, receiverId: ctx.E.id },
        { requesterId: ctx.E.id, receiverId: ctx.D.id },
      ],
    },
  });
  assert(!!eIsReallyDsFriend,
    'DEAD-END: E is confirmed D\'s friend at DB level (privacy gate deliberately hid E from V)');

  // E does NOT appear in hop3 friends response — double check
  const eInHop3 = findById(hop3Friends, ctx.E.id);
  assert(!eInHop3,
    'DEAD-END: E does NOT appear in D\'s response.friends (correctly hidden from V)');

  // ──────────────────────────────────────────────────────────────────────────
  // NEGATIVE CONTROL: If V WERE D's friend, the gate OPENS
  // Create a V<->D friendship, re-call, assert friends list is non-empty,
  // then remove that friendship before returning.
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- NEGATIVE CONTROL: create V<->D friendship, verify gate opens ---');

  let negativeControlFriendshipId = null;
  try {
    // Temporarily add V<->D as ACCEPTED friends
    const tempFriendship = await prisma.friendship.create({
      data: {
        requesterId: ctx.V.id,
        receiverId:  ctx.D.id,
        status:      'ACCEPTED',
        acceptedAt:  new Date(),
      },
    });
    negativeControlFriendshipId = tempFriendship.id;

    // Re-call getUserProfile with V as viewer, D as target
    const negCtrl = await callGetUserProfile(ctx.V.id, ctx.D.id);

    assertEq(negCtrl.status, 200,
      'NEG-CTRL: status 200');
    assertEq(negCtrl.json?.success, true,
      'NEG-CTRL: success=true');

    const negData = negCtrl.json?.data;
    assert(!!negData,
      'NEG-CTRL: data object present');
    assertEq(negData?.isPrivate, false,
      'NEG-CTRL: isPrivate=false (V is now D\'s friend — friendship bypasses privacy gate)');
    assertEq(negData?.isFriend, true,
      'NEG-CTRL: isFriend=true (V<->D ACCEPTED)');
    assertEq(negData?.friendshipStatus, 'ACCEPTED',
      'NEG-CTRL: friendshipStatus=ACCEPTED');

    const negFriends = negData?.friends;
    assert(Array.isArray(negFriends),
      'NEG-CTRL: data.friends is an array');
    assert(negFriends?.length >= 2,
      `NEG-CTRL: data.friends is NON-EMPTY now that V is D\'s friend (got length=${negFriends?.length})`);

    // E must now be visible
    const eInNeg = findById(negFriends, ctx.E.id);
    assert(!!eInNeg,
      'NEG-CTRL: E is now visible in D.friends (gate opened for friend V)');

    // Bio must now be visible
    assert(negData?.bio === 'Bio for D',
      'NEG-CTRL: bio visible (gate opened)');

    console.log('  --> NEGATIVE CONTROL PASSED: friendship gate opened correctly for V<->D friend.');

  } finally {
    // Always remove the temporary friendship regardless of assertion outcome
    if (negativeControlFriendshipId !== null) {
      await prisma.friendship.delete({ where: { id: negativeControlFriendshipId } }).catch(() => {});
      negativeControlFriendshipId = null;
      console.log('  [NEG-CTRL CLEANUP] Temporary V<->D friendship removed.');
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Per-item viewer-relative status sanity along the chain
  // In HOP 1 (B's friends): C's badge is "NONE" (V and C are not friends)
  // Already asserted above in HOP1 section. Confirm again explicitly:
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- STATUS SANITY: viewer-relative badges in B.friends ---');

  // Re-use hop1Friends from HOP 1
  if (Array.isArray(hop1Friends)) {
    const cEntry = findById(hop1Friends, ctx.C.id);
    if (cEntry) {
      assertEq(cEntry.friendshipStatus, 'NONE',
        'STATUS: C.friendshipStatus="NONE" in B.friends (V is not friends with C)');
    } else {
      // Already asserted presence above; this is a guard only.
      console.log('  INFO  STATUS: C not found in hop1Friends (already failed above)');
    }

    const bxEntry = findById(hop1Friends, ctx.Bx.id);
    if (bxEntry) {
      assertEq(bxEntry.friendshipStatus, 'NONE',
        'STATUS: Bx.friendshipStatus="NONE" in B.friends (V is not friends with Bx)');
    }
  }

  // In HOP 2 (C's friends): D's badge is "NONE" (V and D are not friends — temp friendship was removed)
  if (Array.isArray(hop2Friends)) {
    const dEntry = findById(hop2Friends, ctx.D.id);
    if (dEntry) {
      assertEq(dEntry.friendshipStatus, 'NONE',
        'STATUS: D.friendshipStatus="NONE" in C.friends (V is not friends with D)');
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Friend-of-Friend Drill-Down Chain Privacy — End-to-End Test ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('Controller: exports.getUserProfile (controllers/friendController.js ~line 1470)\n');

  let dbReturned = false;

  try {
    await recordBaseline();
    await seed();

    await runChainDrillTest();

  } finally {
    console.log('\n[TEARDOWN] Removing all seeded fixture rows...');
    try {
      await teardown();
      console.log('[TEARDOWN] Done.');
    } catch (tearErr) {
      console.error('[TEARDOWN ERROR]', tearErr.message);
    }

    dbReturned = await verifyBaseline();

    await prisma.$disconnect();
  }

  // ── Final report ──────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('FINAL RESULTS');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`Total  : ${total}`);
  console.log(`Passed : ${passed}`);
  console.log(`Failed : ${failed}`);
  console.log(`DB baseline restored: ${dbReturned ? 'YES' : 'NO — LEAK DETECTED'}`);

  if (failures.length > 0) {
    console.log('\nFAILED ASSERTIONS:');
    failures.forEach(({ label, detail }, i) => {
      console.log(`  ${i + 1}. ${label}`);
      if (detail) console.log(`     -> ${detail}`);
    });
  } else if (failed === 0) {
    console.log('\nAll assertions passed.');
  }

  console.log('══════════════════════════════════════════════════════════════════════');

  if (failed > 0 || !dbReturned) process.exit(1);
}

main().catch(async (err) => {
  console.error('\n[FATAL]', err);
  try { await teardown(); } catch (_) {}
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(2);
});
