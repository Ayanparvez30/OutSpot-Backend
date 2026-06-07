#!/usr/bin/env node
/**
 * End-to-end test: friend-of-friend (FoF) friendshipStatus badging
 *
 * Tests the `getViewerFriendshipStatusMap` helper (module-local, not exported)
 * indirectly through the two public controllers that use it:
 *   1. exports.getUserProfile   — friendController.js ~line 1470
 *   2. exports.getFriendProfile — friendController.js ~line 1249
 *
 * Strategy:
 *   - Call controllers directly with mocked req/res (no HTTP server).
 *   - Use the LIVE DB via Prisma.
 *   - Record baseline counts before seeding; restore exactly in finally.
 *   - Seed fixture users (V, B, C, D, E, F) with the relationship graph:
 *       V <-> B  ACCEPTED  (so V can call getFriendProfile on B)
 *       V <-> C  ACCEPTED  (C is also B's friend => expect "ACCEPTED" in B's list)
 *       V  -> D  PENDING   (V sent request   => expect "PENDING_SENT")
 *       E  -> V  PENDING   (E sent to V      => expect "PENDING_RECEIVED")
 *       [F has no relationship with V]       => expect "NONE"
 *       B <-> C  ACCEPTED
 *       B <-> D  ACCEPTED
 *       B <-> E  ACCEPTED
 *       B <-> F  ACCEPTED
 *   - Also seeds V itself as B's friend: if V appears in B's friend list => "SELF".
 *
 * Usage:
 *   node tests/friend-of-friend-status.test.js
 */

'use strict';

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

// ── Controllers under test ────────────────────────────────────────────────────
const { getUserProfile, getFriendProfile } = require('../controllers/friendController');

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

// ── Baseline tracking ─────────────────────────────────────────────────────────

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
// V = viewer
// B = V's ACCEPTED friend  (so V can call getFriendProfile(B))
// C = V's ACCEPTED friend  + B's ACCEPTED friend  => "ACCEPTED" in B's friend list
// D = V sent PENDING to D  + B's ACCEPTED friend  => "PENDING_SENT"
// E = E sent PENDING to V  + B's ACCEPTED friend  => "PENDING_RECEIVED"
// F = no relationship with V + B's ACCEPTED friend => "NONE"
// (V is also B's ACCEPTED friend — the V<->B row means V appears in B's friend
//  list from B's perspective; if the controller includes V it should show "SELF")

const ctx = {
  V: null, B: null, C: null, D: null, E: null, F: null,
};

async function seed() {
  const hash = await bcrypt.hash('TestFoF!1', 10);
  const ts = Date.now();

  async function createUser(tag) {
    return prisma.user.create({
      data: {
        username: `test-fof-${tag}-${ts}`,
        email:    `test-fof-${tag}-${ts}@example.com`,
        password: hash,
        isVerified: true,
        firstName:  `FoF${tag}`,
        lastName:   `Tester`,
        bio:        `Bio ${tag}`,
        totalPoints: 0,
        isProfilePrivate: false,
      },
    });
  }

  [ctx.V, ctx.B, ctx.C, ctx.D, ctx.E, ctx.F] = await Promise.all([
    createUser('V'),
    createUser('B'),
    createUser('C'),
    createUser('D'),
    createUser('E'),
    createUser('F'),
  ]);

  // All six relationships with V:
  //   V <-> B  ACCEPTED
  //   V <-> C  ACCEPTED
  //   V  -> D  PENDING  (V is requester => PENDING_SENT from V's view)
  //   E  -> V  PENDING  (E is requester => PENDING_RECEIVED from V's view)
  //   [no row for F]
  //
  // B's accepted friendships (so C/D/E/F all appear in B's friend list):
  //   B <-> C  ACCEPTED
  //   B <-> D  ACCEPTED
  //   B <-> E  ACCEPTED
  //   B <-> F  ACCEPTED
  //   NOTE: B<->V is already covered by the V<->B row above.

  await prisma.friendship.createMany({
    data: [
      // V's relationships
      { requesterId: ctx.V.id, receiverId: ctx.B.id, status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.V.id, receiverId: ctx.C.id, status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.V.id, receiverId: ctx.D.id, status: 'PENDING' },
      { requesterId: ctx.E.id, receiverId: ctx.V.id, status: 'PENDING' },
      // B's extra accepted friendships (beyond V<->B above)
      { requesterId: ctx.B.id, receiverId: ctx.C.id, status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.B.id, receiverId: ctx.D.id, status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.B.id, receiverId: ctx.E.id, status: 'ACCEPTED', acceptedAt: new Date() },
      { requesterId: ctx.B.id, receiverId: ctx.F.id, status: 'ACCEPTED', acceptedAt: new Date() },
    ],
  });

  console.log(
    `[SEED] V=${ctx.V.id} B=${ctx.B.id} C=${ctx.C.id} D=${ctx.D.id} E=${ctx.E.id} F=${ctx.F.id}`
  );
}

async function teardown() {
  const ids = [ctx.V, ctx.B, ctx.C, ctx.D, ctx.E, ctx.F]
    .filter(Boolean)
    .map((u) => u.id);

  if (ids.length === 0) return;

  // Friendship rows cascade-delete from User (onDelete: Cascade in schema).
  // Deleting users will cascade friendships, stories, locationPoints, etc.
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

// ── req/res mock builders ─────────────────────────────────────────────────────

/**
 * Build mock req/res for getUserProfile.
 * req shape: { authData: { id: viewerId }, params: { userId: String(targetId) }, query: {} }
 */
function mockGetUserProfile(viewerId, targetId, query = {}) {
  let resolve;
  const result = new Promise((res) => { resolve = res; });

  const res = {
    _status: 200,
    status(code) { this._status = code; return this; },
    json(payload) { resolve({ status: this._status, json: payload }); return this; },
  };

  const req = {
    authData: { id: viewerId },
    params: { userId: String(targetId) },
    query,
  };

  return { req, res, result };
}

/**
 * Build mock req/res for getFriendProfile.
 * req shape: { authData: { id: viewerId }, params: { friendId: String(targetId) }, query: {} }
 */
function mockGetFriendProfile(viewerId, friendId, query = {}) {
  let resolve;
  const result = new Promise((res) => { resolve = res; });

  const res = {
    _status: 200,
    status(code) { this._status = code; return this; },
    json(payload) { resolve({ status: this._status, json: payload }); return this; },
  };

  const req = {
    authData: { id: viewerId },
    params: { friendId: String(friendId) },
    query,
  };

  return { req, res, result };
}

async function callGetUserProfile(viewerId, targetId) {
  const { req, res, result } = mockGetUserProfile(viewerId, targetId);
  getUserProfile(req, res);
  return result;
}

async function callGetFriendProfile(viewerId, targetId) {
  const { req, res, result } = mockGetFriendProfile(viewerId, targetId);
  getFriendProfile(req, res);
  return result;
}

// ── Helper to find a specific user in a list by id ───────────────────────────

function findById(arr, id) {
  return Array.isArray(arr) ? arr.find((item) => item.id === id) : undefined;
}

// ── Test suites ───────────────────────────────────────────────────────────────

async function testGetUserProfile_FoFBadging() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('Suite 1: getUserProfile — FoF badging in data.friends[]');
  console.log('Viewer=V opens B\'s profile. Checks friendshipStatus on each of B\'s friends.');
  console.log('══════════════════════════════════════════════════════════════');

  const r = await callGetUserProfile(ctx.V.id, ctx.B.id);

  // ── 1.0: Top-level response sanity ───────────────────────────────────────
  console.log('\n--- 1.0: Response sanity ---');
  assertEq(r.status, 200, '1.0 status 200');
  assertEq(r.json?.success, true, '1.0 success=true');

  const data = r.json?.data;
  assert(!!data, '1.0 data object present');

  // ── 1.1: V and B are ACCEPTED friends → profile is not gated ────────────
  console.log('\n--- 1.1: V is friends with B (profile visible) ---');
  assertEq(data?.isFriend, true, '1.1 isFriend=true (V<->B ACCEPTED)');
  assertEq(data?.isPrivate, false, '1.1 isPrivate=false (friend bypass)');
  assertEq(data?.id, ctx.B.id, '1.1 returned correct user (B)');

  // ── 1.2: friends[] array is present and non-empty ───────────────────────
  console.log('\n--- 1.2: friends[] array ---');
  const friends = data?.friends;
  assert(Array.isArray(friends), '1.2 data.friends is an array');
  assert(friends?.length > 0, '1.2 data.friends is non-empty');

  // ── 1.3: FoF status per member (the core assertions) ────────────────────
  console.log('\n--- 1.3: Per-member friendshipStatus badges ---');

  // C — V's ACCEPTED friend: expect "ACCEPTED"
  const cEntry = findById(friends, ctx.C.id);
  assert(!!cEntry, '1.3 C found in B\'s friend list');
  assertEq(cEntry?.friendshipStatus, 'ACCEPTED',
    `1.3 C.friendshipStatus="ACCEPTED" (V<->C are friends)`);

  // D — V sent PENDING to D: expect "PENDING_SENT"
  const dEntry = findById(friends, ctx.D.id);
  assert(!!dEntry, '1.3 D found in B\'s friend list');
  assertEq(dEntry?.friendshipStatus, 'PENDING_SENT',
    `1.3 D.friendshipStatus="PENDING_SENT" (V sent request to D)`);

  // E — E sent PENDING to V: expect "PENDING_RECEIVED"
  const eEntry = findById(friends, ctx.E.id);
  assert(!!eEntry, '1.3 E found in B\'s friend list');
  assertEq(eEntry?.friendshipStatus, 'PENDING_RECEIVED',
    `1.3 E.friendshipStatus="PENDING_RECEIVED" (E sent request to V)`);

  // F — no relationship with V: expect "NONE"
  const fEntry = findById(friends, ctx.F.id);
  assert(!!fEntry, '1.3 F found in B\'s friend list');
  assertEq(fEntry?.friendshipStatus, 'NONE',
    `1.3 F.friendshipStatus="NONE" (no V<->F relationship)`);

  // ── 1.4: If V appears in B's friend list, status must be "SELF" ─────────
  console.log('\n--- 1.4: V in B\'s friend list → "SELF" ---');
  const vEntry = findById(friends, ctx.V.id);
  if (vEntry) {
    assertEq(vEntry.friendshipStatus, 'SELF',
      `1.4 V.friendshipStatus="SELF" when V appears in B's friend list`);
  } else {
    // V not appearing in B's list is also valid if the controller excludes self.
    // Document the observation but do not fail.
    console.log(`  INFO  1.4 V (id=${ctx.V.id}) did not appear in B's friend list (controller may exclude self — acceptable)`);
  }

  // ── 1.5: Sanity — statuses reflect V's relationships, not B's ───────────
  console.log('\n--- 1.5: Sanity check — all C/D/E/F are B\'s ACCEPTED friends ---');
  // All of C,D,E,F have ACCEPTED friendship with B, yet their statuses from
  // V's point of view differ — proving the map is viewer-relative, not B's.
  if (cEntry && dEntry && eEntry && fEntry) {
    const notAllAccepted =
      cEntry.friendshipStatus !== dEntry.friendshipStatus ||
      cEntry.friendshipStatus !== eEntry.friendshipStatus ||
      cEntry.friendshipStatus !== fEntry.friendshipStatus;
    assert(
      notAllAccepted,
      '1.5 C/D/E/F have DIFFERENT statuses (proving viewer-relative mapping, not B-relative)'
    );
  }
}

async function testGetFriendProfile_FoFBadging() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('Suite 2: getFriendProfile — FoF badging in data.friendFriends[]');
  console.log('Viewer=V opens B\'s friend profile. V&B must be ACCEPTED friends.');
  console.log('══════════════════════════════════════════════════════════════');

  // ── 2.0: 403 guard — non-friend cannot access friend profile ─────────────
  console.log('\n--- 2.0: 403 guard for non-friend access ---');
  {
    const r = await callGetFriendProfile(ctx.C.id, ctx.F.id);  // C and F are NOT friends
    assertEq(r.status, 403, '2.0 status 403 when viewer and target are not friends');
  }

  // ── 2.1: 200 when V and B are ACCEPTED friends ───────────────────────────
  console.log('\n--- 2.1: 200 for V -> B (ACCEPTED friends) ---');
  const r = await callGetFriendProfile(ctx.V.id, ctx.B.id);
  assertEq(r.status, 200, '2.1 status 200 (V&B are friends)');
  assertEq(r.json?.success, true, '2.1 success=true');

  const data = r.json?.data;
  assert(!!data, '2.1 data object present');
  assertEq(data?.id, ctx.B.id, '2.1 returned correct user (B)');

  // ── 2.2: friendFriends[] is present and non-empty ───────────────────────
  console.log('\n--- 2.2: friendFriends[] array ---');
  const ff = data?.friendFriends;
  assert(Array.isArray(ff), '2.2 data.friendFriends is an array');
  assert(ff?.length > 0, '2.2 data.friendFriends is non-empty');

  // ── 2.3: FoF status per member (same graph, same expectations) ───────────
  console.log('\n--- 2.3: Per-member friendshipStatus badges ---');

  const cEntry = findById(ff, ctx.C.id);
  assert(!!cEntry, '2.3 C found in friendFriends');
  assertEq(cEntry?.friendshipStatus, 'ACCEPTED',
    `2.3 C.friendshipStatus="ACCEPTED" (V<->C are friends)`);

  const dEntry = findById(ff, ctx.D.id);
  assert(!!dEntry, '2.3 D found in friendFriends');
  assertEq(dEntry?.friendshipStatus, 'PENDING_SENT',
    `2.3 D.friendshipStatus="PENDING_SENT" (V sent request to D)`);

  const eEntry = findById(ff, ctx.E.id);
  assert(!!eEntry, '2.3 E found in friendFriends');
  assertEq(eEntry?.friendshipStatus, 'PENDING_RECEIVED',
    `2.3 E.friendshipStatus="PENDING_RECEIVED" (E sent request to V)`);

  const fEntry = findById(ff, ctx.F.id);
  assert(!!fEntry, '2.3 F found in friendFriends');
  assertEq(fEntry?.friendshipStatus, 'NONE',
    `2.3 F.friendshipStatus="NONE" (no V<->F relationship)`);

  // ── 2.4: V in friendFriends → "SELF" ────────────────────────────────────
  console.log('\n--- 2.4: V in friendFriends → "SELF" ---');
  const vEntry = findById(ff, ctx.V.id);
  if (vEntry) {
    assertEq(vEntry.friendshipStatus, 'SELF',
      `2.4 V.friendshipStatus="SELF" when V appears in friendFriends`);
  } else {
    console.log(`  INFO  2.4 V (id=${ctx.V.id}) did not appear in friendFriends (controller may exclude self — acceptable)`);
  }

  // ── 2.5: friendFriends entries have required shape ───────────────────────
  console.log('\n--- 2.5: Entry shape sanity ---');
  if (ff && ff.length > 0) {
    const entry = ff[0];
    assert(typeof entry.id === 'number',            '2.5 entry.id is a number');
    assert(typeof entry.username === 'string',      '2.5 entry.username is a string');
    assert('friendshipStatus' in entry,             '2.5 entry has friendshipStatus field');
    assert(typeof entry.totalPoints === 'number',   '2.5 entry.totalPoints is a number');
    assert(typeof entry.thisWeekPoints === 'number','2.5 entry.thisWeekPoints is a number');
  }
}

async function testEdgeCases() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('Suite 3: Edge cases');
  console.log('══════════════════════════════════════════════════════════════');

  // ── 3.1: getUserProfile — self view, friendshipStatus="NONE" (no self row) ─
  console.log('\n--- 3.1: getUserProfile self-view (V views V) ---');
  {
    const r = await callGetUserProfile(ctx.V.id, ctx.V.id);
    assertEq(r.status, 200, '3.1 status 200');
    assertEq(r.json?.data?.isSelf, true, '3.1 isSelf=true');
    // V viewing V: the top-level friendshipStatus on the profile itself is NONE
    // (no Friendship row exists for V->V). Rich data must still be present.
    const d = r.json?.data;
    assert(Array.isArray(d?.friends), '3.1 friends array present for self view');
    // V has friends B and C (ACCEPTED). Each should appear with their statuses.
    // B and C are both ACCEPTED from V's perspective.
    if (Array.isArray(d?.friends)) {
      const bEntry = findById(d.friends, ctx.B.id);
      if (bEntry) {
        assertEq(bEntry.friendshipStatus, 'ACCEPTED', '3.1 B in V\'s own friend list has "ACCEPTED"');
      } else {
        console.log('  INFO  3.1 B not found in V\'s own friend list');
      }
      const cEntry2 = findById(d.friends, ctx.C.id);
      if (cEntry2) {
        assertEq(cEntry2.friendshipStatus, 'ACCEPTED', '3.1 C in V\'s own friend list has "ACCEPTED"');
      } else {
        console.log('  INFO  3.1 C not found in V\'s own friend list');
      }
    }
  }

  // ── 3.2: getUserProfile — non-existent user returns 404 ─────────────────
  console.log('\n--- 3.2: getUserProfile non-existent target ---');
  {
    const r = await callGetUserProfile(ctx.V.id, 999999999);
    assertEq(r.status, 404, '3.2 status 404 for non-existent user');
  }

  // ── 3.3: getFriendProfile — non-existent friend returns 403 or 404 ──────
  console.log('\n--- 3.3: getFriendProfile non-existent friendId ---');
  {
    const r = await callGetFriendProfile(ctx.V.id, 999999999);
    assert(r.status === 403 || r.status === 404,
      `3.3 status 403 or 404 for non-existent friendId (got ${r.status})`);
  }

  // ── 3.4: getFriendProfile — PENDING friendship not enough (must be ACCEPTED) ─
  console.log('\n--- 3.4: getFriendProfile with only PENDING friendship ---');
  {
    // V sent a PENDING request to D; D has not accepted. V cannot view D's friend profile.
    const r = await callGetFriendProfile(ctx.V.id, ctx.D.id);
    assertEq(r.status, 403, '3.4 status 403 when friendship is only PENDING (not ACCEPTED)');
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function main() {
  console.log('=== Friend-of-Friend Status Badging Tests ===');
  console.log('controllers/friendController.js — getViewerFriendshipStatusMap (indirect)');
  console.log(`Started: ${new Date().toISOString()}\n`);

  await recordBaseline();

  try {
    await seed();

    await testGetUserProfile_FoFBadging();
    await testGetFriendProfile_FoFBadging();
    await testEdgeCases();

  } finally {
    console.log('\n[TEARDOWN] Removing fixture rows …');
    try {
      await teardown();
      console.log('[TEARDOWN] Done.');
    } catch (err) {
      console.error('[TEARDOWN] Error during teardown:', err.message);
    }

    const dbReturned = await verifyBaseline();

    // ── Final report ──────────────────────────────────────────────────────
    console.log('\n════════════════════════════════════════════');
    console.log('RESULTS');
    console.log('════════════════════════════════════════════');
    console.log(`Total  : ${passed + failed}`);
    console.log(`Passed : ${passed}`);
    console.log(`Failed : ${failed}`);
    if (failures.length > 0) {
      console.log('\nFailed assertions:');
      for (const f of failures) {
        if (f.detail) {
          console.log(`  - ${f.label}`);
          console.log(`    ${f.detail}`);
        } else {
          console.log(`  - ${f.label}`);
        }
      }
    }
    console.log(`\nDB baseline restored: ${dbReturned ? 'YES' : 'NO — LEAK DETECTED'}`);
    console.log('════════════════════════════════════════════');

    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  }
}

main().catch(async (err) => {
  console.error('[FATAL]', err);
  try { await teardown(); } catch (_) {}
  await prisma.$disconnect();
  process.exit(2);
});
