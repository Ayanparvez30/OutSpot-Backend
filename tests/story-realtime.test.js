#!/usr/bin/env node
/**
 * Integration test: story realtime signals
 *
 * Two signals under test:
 *
 *   Signal A — removeStory (END-TO-END)
 *     The REAL mediaController.removeStory is invoked via a mock req/res.
 *     The controller deletes the Story row from the DB and emits:
 *       realtime.toFriends(userId, 'story.removed', { storyId, userId })
 *       realtime.toUser(userId,    'story.removed', { storyId, userId })
 *     Assertions 1-5.
 *
 *   Signal B — story.expired cron emit (MIRRORED)
 *     server.js cannot be imported (it boots cron jobs, full express, etc.).
 *     The emit block is MIRRORED from server.js lines 118-127:
 *
 *       const realtime = require('./utils/realtime');
 *       const ownerIds = [...new Set(doomed.map(s => s.userId))];
 *       for (const ownerId of ownerIds) {
 *         realtime.toFriends(ownerId, 'story.expired', { userId: ownerId });
 *         realtime.toUser(ownerId,    'story.expired', { userId: ownerId });
 *       }
 *
 *     The test seeds ACTIVE stories with a past createdAt (so the cron WHERE
 *     clause `status:'ACTIVE', createdAt:{lt:expiry}, savedBy:{none:{}}` would
 *     match them), performs the deleteMany itself exactly as the cron does, then
 *     runs the mirrored emit loop to prove the signal contract.
 *     Assertions 6-10.
 *
 * Usage:
 *   node tests/story-realtime.test.js
 *
 * Requirements: DATABASE_URL set in .env
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http             = require('http');
const { PrismaClient } = require('@prisma/client');
const { initSocket, getIO } = require('../utils/socket');
const realtime         = require('../utils/realtime');
const ioClient         = require('socket.io-client');
const mediaController  = require('../controllers/mediaController');

const prisma = new PrismaClient();

// ── Config ────────────────────────────────────────────────────────────────────
const SETTLE_MS          = 800;   // wait after all clients connect for server async room-joins
const CONNECT_TIMEOUT_MS = 10000;
const SIGNAL_WAIT_MS     = 1500;  // generous window to wait for a signal to arrive
const NO_SIGNAL_WAIT_MS  = 1800;  // window used to assert silence

// ── Result tracking ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results  = []; // { id, label, ok, detail }

function pass(id, label) {
  passed++;
  results.push({ id, label, ok: true, detail: '' });
  console.log(`  PASS  [${id}] ${label}`);
}

function fail(id, label, detail = '') {
  failed++;
  const msg = detail ? `${label} — ${detail}` : label;
  results.push({ id, label, ok: false, detail });
  console.log(`  FAIL  [${id}] ${msg}`);
}

function assert(condition, id, label, detail = '') {
  condition ? pass(id, label) : fail(id, label, detail);
}

// ── Socket utilities ──────────────────────────────────────────────────────────

function connectClient(port, userId) {
  return ioClient(`http://127.0.0.1:${port}`, {
    query:        { userId: String(userId) },
    transports:   ['websocket'],
    reconnection: false,
  });
}

function waitReady(sock, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`socket:ready timeout (userId=${sock.io?.opts?.query?.userId})`)),
      timeoutMs
    );
    sock.once('socket:ready', () => { clearTimeout(t); resolve(); });
    sock.once('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Collect all 'realtime' events on sock within windowMs.
 * Returns [{data, ts}].
 */
function collectEvents(sock, windowMs) {
  return new Promise((resolve) => {
    const events = [];
    const handler = (data) => events.push({ data, ts: Date.now() });
    sock.on('realtime', handler);
    setTimeout(() => { sock.off('realtime', handler); resolve(events); }, windowMs);
  });
}

/**
 * Wait for at least `count` realtime events matching `predicate` within timeoutMs.
 * Resolves with all matched events (may be < count on timeout).
 */
function waitEvents(sock, count, timeoutMs, predicate = () => true) {
  return new Promise((resolve) => {
    const events = [];
    const t = setTimeout(() => { sock.off('realtime', handler); resolve(events); }, timeoutMs);
    function handler(data) {
      if (predicate(data)) {
        events.push({ data, ts: Date.now() });
        if (events.length >= count) { clearTimeout(t); sock.off('realtime', handler); resolve(events); }
      }
    }
    sock.on('realtime', handler);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Mock req/res builder ──────────────────────────────────────────────────────

function mockReqRes({ userId, params = {}, body = {}, query = {} } = {}) {
  let resolve;
  const resultP = new Promise((r) => { resolve = r; });
  const res = {
    _status: 200,
    status(code) { this._status = code; return this; },
    json(payload) { resolve({ status: this._status, body: payload }); return this; },
    send(payload) { resolve({ status: this._status, body: payload }); return this; },
  };
  const req = { authData: { id: userId }, params, body, query };
  return { req, res, resultP };
}

// ── DB seed helpers ───────────────────────────────────────────────────────────

const TS = Date.now();
let seqCtr = 0;
function uid(label) { return `story_rt_${label}_${TS}_${++seqCtr}`; }

async function seedUser(label) {
  return prisma.user.create({
    data: {
      username: uid(label),
      email:    `test-storyrt-${uid(label)}@example.com`,
      password: 'testhash',
    },
    select: { id: true, username: true },
  });
}

async function seedFriendship(requesterId, receiverId) {
  return prisma.friendship.create({
    data: { requesterId, receiverId, status: 'ACCEPTED' },
  });
}

/**
 * Create a plain ACTIVE story owned by userId.
 * mediaUrl must be a URL (not a local path) so that the s3Cleanup helper
 * does not attempt to call AWS. We use a dummy https URL. The Story row
 * is always hard-deleted by removeStory regardless; S3 cleanup is fire-and-
 * forget and any fetch error is swallowed by the controller.
 */
async function seedStory(userId) {
  return prisma.story.create({
    data: {
      userId,
      mediaUrl:   `https://example.com/test-story-${Date.now()}-${Math.random()}.jpg`,
      type:       'IMAGE',
      visibility: 'profile',
      status:     'ACTIVE',
    },
    select: { id: true, userId: true, mediaUrl: true, createdAt: true },
  });
}

/**
 * Seed an expired ACTIVE story: sets createdAt well in the past so that the
 * cron's `createdAt: { lt: expiry }` filter matches it.
 * We do this with a raw updateMany after create because Prisma doesn't allow
 * setting @default(now()) createdAt on create from client.
 */
async function seedExpiredStory(userId) {
  const story = await seedStory(userId);
  // Set createdAt 48 hours in the past — well beyond any STORY_TTL_MINUTES setting
  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await prisma.$executeRaw`UPDATE Story SET createdAt = ${oldDate} WHERE id = ${story.id}`;
  return story;
}

// ── DB baseline snapshot ──────────────────────────────────────────────────────

async function snapshotDB() {
  return {
    users:       await prisma.user.count(),
    friendships: await prisma.friendship.count(),
    stories:     await prisma.story.count(),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Story Realtime Signals — Integration Test (assertions 1-10)');
  console.log('══════════════════════════════════════════════════════════════\n');

  // Snapshot DB baseline BEFORE any seeding
  const baseline = await snapshotDB();
  console.log('DB baseline:', baseline);

  // Boot in-process http server + Socket.IO (no express needed for signal tests)
  const server = http.createServer();
  initSocket(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  console.log(`\nServer listening on port ${port}\n`);

  // Clear any leftover throttle state from prior test runs
  realtime._sweepThrottleKeys(0);

  // Tracked for teardown
  const seededUserIds  = [];
  const seededStoryIds = [];
  const allClients     = [];

  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // SEED
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('── Seeding ────────────────────────────────────────────────────');

    // Primary owner O with 2 ACCEPTED friends F1, F2 and one non-friend N
    const O  = await seedUser('O');  seededUserIds.push(O.id);
    const F1 = await seedUser('F1'); seededUserIds.push(F1.id);
    const F2 = await seedUser('F2'); seededUserIds.push(F2.id);
    const N  = await seedUser('N');  seededUserIds.push(N.id);
    await seedFriendship(O.id, F1.id);
    await seedFriendship(O.id, F2.id);
    // N is intentionally NOT friends with O

    console.log(`  O=${O.id}, F1=${F1.id}, F2=${F2.id}, N=${N.id} (non-friend)`);

    // Seed 2 ACTIVE stories for O (for removeStory tests)
    const story1 = await seedStory(O.id); seededStoryIds.push(story1.id);
    const story2 = await seedStory(O.id); seededStoryIds.push(story2.id);
    console.log(`  O's stories: story1=${story1.id}, story2=${story2.id}`);

    // Seed a story owned by someone else (for authorization guard test, assertion 5)
    const OTHER = await seedUser('OTHER'); seededUserIds.push(OTHER.id);
    const otherStory = await seedStory(OTHER.id); seededStoryIds.push(otherStory.id);
    console.log(`  OTHER=${OTHER.id}, otherStory=${otherStory.id} (O must NOT be able to delete this)`);

    // Second owner O2 + friend F3 for per-owner fan-out isolation test (assertions 9-10)
    const O2 = await seedUser('O2'); seededUserIds.push(O2.id);
    const F3 = await seedUser('F3'); seededUserIds.push(F3.id);
    await seedFriendship(O2.id, F3.id);
    console.log(`  O2=${O2.id}, F3=${F3.id} (friend of O2 only)`);

    // ═══════════════════════════════════════════════════════════════════════════
    // CONNECT CLIENTS
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n── Connecting clients ──────────────────────────────────────────');

    const oSock  = connectClient(port, O.id);   allClients.push(oSock);
    const f1Sock = connectClient(port, F1.id);  allClients.push(f1Sock);
    const f2Sock = connectClient(port, F2.id);  allClients.push(f2Sock);
    const nSock  = connectClient(port, N.id);   allClients.push(nSock);
    const o2Sock = connectClient(port, O2.id);  allClients.push(o2Sock);
    const f3Sock = connectClient(port, F3.id);  allClients.push(f3Sock);

    await Promise.all([
      waitReady(oSock),
      waitReady(f1Sock),
      waitReady(f2Sock),
      waitReady(nSock),
      waitReady(o2Sock),
      waitReady(f3Sock),
    ]);

    console.log(`  All 6 clients connected. Settling ${SETTLE_MS}ms for async room-joins...`);
    await sleep(SETTLE_MS);
    console.log('  Ready.\n');

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSERTION 1 — removeStory: controller returns success + DB row deleted
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('── [1] removeStory: controller returns success + Story row deleted from DB ─');
    {
      const storyIdToDelete = story1.id;

      const { req, res, resultP } = mockReqRes({
        userId: O.id,
        params: { storyId: String(storyIdToDelete) },
      });

      // Fire the real controller; collect signals in parallel
      const f1P = waitEvents(f1Sock, 1, SIGNAL_WAIT_MS, (d) => d.type === 'story.removed' && d.storyId === storyIdToDelete);
      mediaController.removeStory(req, res);
      const ctrlResult = await resultP;

      // Give socket events time to propagate before checking DB
      await f1P; // already waiting; won't block longer than SIGNAL_WAIT_MS

      const dbRow = await prisma.story.findUnique({ where: { id: storyIdToDelete } });

      console.log(`  [1] Controller response: status=${ctrlResult.status}, body=${JSON.stringify(ctrlResult.body)}`);
      assert(ctrlResult.status === 200, '1a', 'removeStory returns HTTP 200', `status=${ctrlResult.status}`);
      assert(
        typeof ctrlResult.body?.message === 'string' && ctrlResult.body.message.includes('removed'),
        '1b',
        'Response body contains success message',
        `body=${JSON.stringify(ctrlResult.body)}`
      );
      assert(dbRow === null, '1c', `Story row ${storyIdToDelete} deleted from DB`, dbRow ? 'row still exists' : '');

      // story1 is now deleted — remove from seededStoryIds so teardown doesn't double-delete
      const idx = seededStoryIds.indexOf(storyIdToDelete);
      if (idx !== -1) seededStoryIds.splice(idx, 1);

      console.log('  [1 path] END-TO-END: real mediaController.removeStory invoked');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSERTION 2 — story.removed delivered to F1 and F2 (friends of O)
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n── [2] story.removed delivered to F1 and F2 via friendOf:{O} ───────────');
    {
      const storyIdToDelete = story2.id;

      // Set up collectors BEFORE invoking controller
      const f1P = waitEvents(f1Sock, 1, SIGNAL_WAIT_MS, (d) => d.type === 'story.removed' && d.storyId === storyIdToDelete);
      const f2P = waitEvents(f2Sock, 1, SIGNAL_WAIT_MS, (d) => d.type === 'story.removed' && d.storyId === storyIdToDelete);

      const { req, res, resultP } = mockReqRes({
        userId: O.id,
        params: { storyId: String(storyIdToDelete) },
      });

      mediaController.removeStory(req, res);
      await resultP; // wait for controller to finish

      const [f1Events, f2Events] = await Promise.all([f1P, f2P]);

      assert(f1Events.length === 1, '2a', 'F1 receives story.removed', `got ${f1Events.length}`);
      assert(f2Events.length === 1, '2b', 'F2 receives story.removed', `got ${f2Events.length}`);

      // Envelope payload check on F1's event
      if (f1Events.length >= 1) {
        const ev = f1Events[0].data;
        assert(ev.storyId === storyIdToDelete, '2c', `payload.storyId === ${storyIdToDelete}`, `got ${ev.storyId}`);
        assert(ev.userId  === O.id,            '2d', `payload.userId === O=${O.id}`,             `got ${ev.userId}`);
      }

      // story2 is deleted; remove from tracked ids
      const idx = seededStoryIds.indexOf(storyIdToDelete);
      if (idx !== -1) seededStoryIds.splice(idx, 1);

      console.log('  [2 path] END-TO-END: realtime.toFriends(userId,"story.removed",...) at mediaController.js:693');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSERTION 3 — story.removed delivered to O's own client (user:{O})
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n── [3] story.removed delivered to O own client (user:{O}) ──────────────');
    {
      // Seed a fresh story for this test
      const storyForOwner = await seedStory(O.id);
      seededStoryIds.push(storyForOwner.id);

      const oP = waitEvents(oSock, 1, SIGNAL_WAIT_MS, (d) => d.type === 'story.removed' && d.storyId === storyForOwner.id);

      const { req, res, resultP } = mockReqRes({
        userId: O.id,
        params: { storyId: String(storyForOwner.id) },
      });

      mediaController.removeStory(req, res);
      await resultP;

      const oEvents = await oP;

      assert(oEvents.length === 1, '3a', 'O (owner) receives story.removed on user:{O}', `got ${oEvents.length}`);
      if (oEvents.length >= 1) {
        const ev = oEvents[0].data;
        assert(ev.type    === 'story.removed',    '3b', 'type === story.removed',     `got ${ev.type}`);
        assert(ev.storyId === storyForOwner.id,   '3c', `storyId === ${storyForOwner.id}`, `got ${ev.storyId}`);
        assert(ev.userId  === O.id,               '3d', `userId === O=${O.id}`,        `got ${ev.userId}`);
      }

      // Mark as deleted
      const idx = seededStoryIds.indexOf(storyForOwner.id);
      if (idx !== -1) seededStoryIds.splice(idx, 1);

      console.log('  [3 path] END-TO-END: realtime.toUser(userId,"story.removed",...) at mediaController.js:694');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSERTION 4 — Non-friend N receives NOTHING on story.removed
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n── [4] Non-friend N receives NOTHING on story.removed ───────────────────');
    {
      const storyForN = await seedStory(O.id);
      seededStoryIds.push(storyForN.id);

      // Silence window for N
      const nP = collectEvents(nSock, NO_SIGNAL_WAIT_MS);

      const { req, res, resultP } = mockReqRes({
        userId: O.id,
        params: { storyId: String(storyForN.id) },
      });

      mediaController.removeStory(req, res);
      await resultP;

      const nEvents = await nP;
      const nRelevant = nEvents.filter((e) => e.data.type === 'story.removed');

      assert(nRelevant.length === 0, '4', 'Non-friend N receives 0 story.removed events', `got ${nRelevant.length}`);

      // Mark as deleted
      const idx = seededStoryIds.indexOf(storyForN.id);
      if (idx !== -1) seededStoryIds.splice(idx, 1);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSERTION 5 — Unauthorized: removeStory for story NOT owned by caller → 403, no emit
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n── [5] Unauthorized: removeStory on other\'s story → 403, no emit ────────');
    {
      // otherStory is owned by OTHER; O tries to delete it
      const silenceP = collectEvents(f1Sock, NO_SIGNAL_WAIT_MS);

      const { req, res, resultP } = mockReqRes({
        userId: O.id, // caller is O
        params: { storyId: String(otherStory.id) },
      });

      mediaController.removeStory(req, res);
      const ctrlResult = await resultP;

      const leakEvents = await silenceP;
      const relevant   = leakEvents.filter((e) => e.data.type === 'story.removed');

      // DB row should still exist
      const dbRow = await prisma.story.findUnique({ where: { id: otherStory.id } });

      console.log(`  [5] Controller response: status=${ctrlResult.status}`);
      assert(ctrlResult.status === 403, '5a', 'removeStory with wrong owner returns 403', `status=${ctrlResult.status}`);
      assert(dbRow !== null,            '5b', 'otherStory row still exists in DB (not deleted)', dbRow ? '' : 'row was deleted!');
      assert(relevant.length === 0,     '5c', 'F1 receives 0 story.removed events on 403 attempt', `got ${relevant.length}`);

      console.log('  [5 path] END-TO-END: controller guard at mediaController.js:671: story.userId !== userId → 403');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSERTION 6-7 — story.expired: F1,F2 receive + O receives (MIRRORED CRON)
    //
    // MIRRORED from server.js lines 118-127:
    //   const realtime = require('./utils/realtime');
    //   const ownerIds = [...new Set(doomed.map(s => s.userId))];
    //   for (const ownerId of ownerIds) {
    //     realtime.toFriends(ownerId, 'story.expired', { userId: ownerId });
    //     realtime.toUser(ownerId,    'story.expired', { userId: ownerId });
    //   }
    //
    // NOTE: This is MIRRORED cron logic, not end-to-end through server.js.
    //   server.js is NOT imported — importing it would boot cron jobs, the full
    //   express app, and attempt port 3000 binding. Instead we seed expired
    //   stories, do the deleteMany exactly as the cron does, then run the
    //   mirrored emit loop against the real socket.io instance.
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n── [6-7] story.expired mirrored cron emit: F1,F2 + O receive ───────────');
    console.log('  NOTE: MIRRORED cron logic (server.js lines 118-127). Not end-to-end.');
    {
      // Seed expired stories for O (createdAt set 48h in the past by seedExpiredStory)
      const exp1 = await seedExpiredStory(O.id);
      const exp2 = await seedExpiredStory(O.id);
      seededStoryIds.push(exp1.id, exp2.id);
      console.log(`  Seeded expired stories for O: ${exp1.id}, ${exp2.id}`);

      // Set up event collectors before the deleteMany+emit
      const f1P = waitEvents(f1Sock, 1, SIGNAL_WAIT_MS, (d) => d.type === 'story.expired' && d.userId === O.id);
      const f2P = waitEvents(f2Sock, 1, SIGNAL_WAIT_MS, (d) => d.type === 'story.expired' && d.userId === O.id);
      const oP  = waitEvents(oSock,  1, SIGNAL_WAIT_MS, (d) => d.type === 'story.expired' && d.userId === O.id);

      // Mirror the cron's WHERE clause (TTL = 5 min dev default; our stories are 48h old)
      const STORY_TTL_MINUTES = Number(process.env.STORY_TTL_MINUTES || 5);
      const expiry = new Date(Date.now() - STORY_TTL_MINUTES * 60 * 1000);

      const doomed = await prisma.story.findMany({
        where: {
          status:  'ACTIVE',
          createdAt: { lt: expiry },
          savedBy: { none: {} },
        },
        select: { id: true, mediaUrl: true, userId: true },
      });

      // Confirm our seeded stories are in the doomed list
      const doomedIds = new Set(doomed.map((s) => s.id));
      console.log(`  Doomed story ids found: ${[...doomedIds].join(', ')}`);
      assert(
        doomedIds.has(exp1.id) && doomedIds.has(exp2.id),
        '6-pre',
        'Seeded expired stories appear in cron WHERE query result',
        `doomed=${[...doomedIds].join(',')}`
      );

      // Mirror the cron's deleteMany
      const ids = doomed.map((s) => s.id);
      await prisma.story.deleteMany({ where: { id: { in: ids } } });
      console.log(`  deleteMany executed (${ids.length} rows deleted)`);

      // Remove deleted ids from seededStoryIds so teardown doesn't double-delete
      for (const id of ids) {
        const idx = seededStoryIds.indexOf(id);
        if (idx !== -1) seededStoryIds.splice(idx, 1);
      }

      // MIRRORED EMIT BLOCK — exact copy of server.js lines 119-124
      const ownerIds = [...new Set(doomed.map((s) => s.userId))];
      for (const ownerId of ownerIds) {
        realtime.toFriends(ownerId, 'story.expired', { userId: ownerId });
        realtime.toUser(ownerId,    'story.expired', { userId: ownerId });
      }

      const [f1Events, f2Events, oEvents] = await Promise.all([f1P, f2P, oP]);

      assert(f1Events.length >= 1, '6a', 'F1 receives story.expired for O (mirrored cron emit)', `got ${f1Events.length}`);
      assert(f2Events.length >= 1, '6b', 'F2 receives story.expired for O (mirrored cron emit)', `got ${f2Events.length}`);

      if (f1Events.length >= 1) {
        assert(f1Events[0].data.userId === O.id, '6c', `F1 event payload.userId === O=${O.id}`, `got ${f1Events[0].data.userId}`);
      }

      // Assertion 7: O receives on user:{O}
      assert(oEvents.length >= 1, '7', 'O (owner) receives story.expired on user:{O} (mirrored cron emit)', `got ${oEvents.length}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSERTION 8 — Non-friend N receives NOTHING on story.expired
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n── [8] Non-friend N receives NOTHING on story.expired ───────────────────');
    {
      const expForN = await seedExpiredStory(O.id);
      seededStoryIds.push(expForN.id);

      const nSilenceP = collectEvents(nSock, NO_SIGNAL_WAIT_MS);

      // Delete + emit for O only
      await prisma.story.deleteMany({ where: { id: expForN.id } });
      const idx = seededStoryIds.indexOf(expForN.id);
      if (idx !== -1) seededStoryIds.splice(idx, 1);

      // Mirrored emit (single owner)
      realtime.toFriends(O.id, 'story.expired', { userId: O.id });
      realtime.toUser(O.id,    'story.expired', { userId: O.id });

      const nEvents = await nSilenceP;
      const nRelevant = nEvents.filter((e) => e.data.type === 'story.expired');

      assert(nRelevant.length === 0, '8', 'Non-friend N receives 0 story.expired events', `got ${nRelevant.length}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSERTION 9 — Per-owner fan-out isolation: O and O2 each have expired
    //               stories; F3 (friend of O2 only) must receive O2's expiry
    //               but NOT O's; F1/F2 (friends of O only) must receive O's
    //               but NOT O2's.
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n── [9] Per-owner fan-out isolation: O2 → F3 only; O → F1,F2 only ────────');
    {
      // Seed expired stories for BOTH O and O2
      const expO  = await seedExpiredStory(O.id);
      const expO2 = await seedExpiredStory(O2.id);
      seededStoryIds.push(expO.id, expO2.id);
      console.log(`  Expired stories: O=${expO.id}, O2=${expO2.id}`);

      // Collectors for all relevant sockets
      const f1P  = collectEvents(f1Sock, NO_SIGNAL_WAIT_MS);
      const f2P  = collectEvents(f2Sock, NO_SIGNAL_WAIT_MS);
      const f3P  = collectEvents(f3Sock, NO_SIGNAL_WAIT_MS);
      const nP   = collectEvents(nSock,  NO_SIGNAL_WAIT_MS);

      // Delete both
      await prisma.story.deleteMany({ where: { id: { in: [expO.id, expO2.id] } } });
      seededStoryIds.splice(seededStoryIds.indexOf(expO.id), 1);
      seededStoryIds.splice(seededStoryIds.indexOf(expO2.id), 1);

      // Simulate doomed list with both owners
      const doomedForBoth = [
        { userId: O.id },
        { userId: O2.id },
      ];

      // MIRRORED emit loop — server.js lines 120-124
      const ownerIds = [...new Set(doomedForBoth.map((s) => s.userId))];
      for (const ownerId of ownerIds) {
        realtime.toFriends(ownerId, 'story.expired', { userId: ownerId });
        realtime.toUser(ownerId,    'story.expired', { userId: ownerId });
      }

      const [f1Events, f2Events, f3Events, nEvents] = await Promise.all([f1P, f2P, f3P, nP]);

      // F1 and F2 are friends of O — should get O's expiry, NOT O2's
      const f1ForO  = f1Events.filter((e) => e.data.type === 'story.expired' && e.data.userId === O.id);
      const f1ForO2 = f1Events.filter((e) => e.data.type === 'story.expired' && e.data.userId === O2.id);
      const f2ForO  = f2Events.filter((e) => e.data.type === 'story.expired' && e.data.userId === O.id);
      const f2ForO2 = f2Events.filter((e) => e.data.type === 'story.expired' && e.data.userId === O2.id);

      // F3 is friend of O2 only — should get O2's expiry, NOT O's
      const f3ForO2 = f3Events.filter((e) => e.data.type === 'story.expired' && e.data.userId === O2.id);
      const f3ForO  = f3Events.filter((e) => e.data.type === 'story.expired' && e.data.userId === O.id);

      assert(f1ForO.length  >= 1, '9a', 'F1 receives story.expired for O',       `got ${f1ForO.length}`);
      assert(f1ForO2.length === 0,'9b', 'F1 does NOT receive story.expired for O2 (no cross-leak)', `got ${f1ForO2.length}`);
      assert(f2ForO.length  >= 1, '9c', 'F2 receives story.expired for O',       `got ${f2ForO.length}`);
      assert(f2ForO2.length === 0,'9d', 'F2 does NOT receive story.expired for O2 (no cross-leak)', `got ${f2ForO2.length}`);
      assert(f3ForO2.length >= 1, '9e', 'F3 receives story.expired for O2',      `got ${f3ForO2.length}`);
      assert(f3ForO.length  === 0,'9f', 'F3 does NOT receive story.expired for O (no cross-leak)',  `got ${f3ForO.length}`);

      const nRelevant = nEvents.filter((e) => e.data.type === 'story.expired');
      assert(nRelevant.length === 0, '9g', 'Non-friend N receives 0 story.expired events in multi-owner test', `got ${nRelevant.length}`);

      console.log('  [9 path] MIRRORED per-owner loop: server.js lines 120-124');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSERTION 10 — Envelope: channel='realtime', type top-level, no nested payload wrapper
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n── [10] Envelope: channel="realtime", type top-level, no payload wrapper ──');
    {
      realtime._sweepThrottleKeys(0);

      let received = null;
      oSock.once('realtime', (data) => { received = data; });

      // Trigger a story.removed signal directly (avoids depending on another DB row)
      realtime.toUser(O.id, 'story.removed', { storyId: 9999, userId: O.id });
      await sleep(500);

      assert(received !== null,                                        '10a', 'Event received on channel "realtime"');
      assert(typeof received === 'object' && !Array.isArray(received), '10b', 'Payload is a plain object');
      assert('type' in received,                                        '10c', 'Payload has top-level "type" key');
      assert(received?.type === 'story.removed',                        '10d', 'type === "story.removed" (top-level, not nested)', `got ${received?.type}`);
      assert(!('payload' in (received || {})),                          '10e', 'No nested "payload" wrapper (flat spread confirmed)');
      assert(received?.storyId === 9999,                                '10f', 'storyId is top-level field', `got storyId=${received?.storyId}`);
      assert(received?.userId  === O.id,                                '10g', 'userId is top-level field', `got userId=${received?.userId}`);

      console.log('  [10] Envelope shape: { type, storyId, userId } — all flat, no wrapper');
    }

  } finally {
    // ═══════════════════════════════════════════════════════════════════════════
    // TEARDOWN — restore DB exactly to baseline
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n── Teardown ─────────────────────────────────────────────────────────────');

    // Disconnect all clients
    for (const sock of allClients) {
      try { sock.disconnect(); } catch (_) {}
    }
    console.log(`  Disconnected ${allClients.length} client sockets`);

    // Close Socket.IO + HTTP server
    try {
      const io = getIO();
      await new Promise((r) => io.close(r));
    } catch (_) {}
    await new Promise((r) => server.close(r));
    console.log('  HTTP server + Socket.IO closed');

    // Delete any remaining seeded stories (those not deleted by the tests above)
    if (seededStoryIds.length > 0) {
      const { count: storyCount } = await prisma.story.deleteMany({
        where: { id: { in: seededStoryIds } },
      }).catch(() => ({ count: 0 }));
      console.log(`  Deleted ${storyCount} remaining seeded Story row(s)`);
    }

    // Delete seeded users — cascade removes Friendship + any remaining Story rows
    if (seededUserIds.length > 0) {
      const { count: userCount } = await prisma.user.deleteMany({
        where: { id: { in: seededUserIds } },
      }).catch(() => ({ count: 0 }));
      console.log(`  Deleted ${userCount} seeded User(s) (cascade: Friendship, Story)`);
    }

    // Verify baseline restored
    const after = await snapshotDB();
    await prisma.$disconnect();

    const baselineOk =
      after.users       === baseline.users       &&
      after.friendships === baseline.friendships  &&
      after.stories     === baseline.stories;

    console.log('\n  Baseline verification:');
    console.log(`    Before: ${JSON.stringify(baseline)}`);
    console.log(`    After:  ${JSON.stringify(after)}`);

    if (!baselineOk) {
      const deltas = Object.keys(baseline)
        .filter((k) => after[k] !== baseline[k])
        .map((k) => `${k}: ${baseline[k]} → ${after[k]} (delta ${after[k] - baseline[k]})`)
        .join(', ');
      fail('DB', 'DB baseline fully restored after teardown', deltas);
    } else {
      pass('DB', 'DB baseline fully restored after teardown');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FINAL REPORT
    // ═══════════════════════════════════════════════════════════════════════════

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  PASS / FAIL TABLE');
    console.log('══════════════════════════════════════════════════════════════');

    const table = [
      { id: '1',  desc: 'removeStory (real controller): 200 + Story row deleted from DB' },
      { id: '2',  desc: 'removeStory: F1 + F2 receive story.removed via friendOf:{O}' },
      { id: '3',  desc: 'removeStory: O (owner) receives story.removed via user:{O}' },
      { id: '4',  desc: 'removeStory: non-friend N receives NOTHING' },
      { id: '5',  desc: 'removeStory unauthorized: 403 returned, DB row intact, no emit' },
      { id: '6',  desc: 'story.expired (mirrored cron): F1 + F2 receive story.expired for O' },
      { id: '7',  desc: 'story.expired (mirrored cron): O receives story.expired via user:{O}' },
      { id: '8',  desc: 'story.expired: non-friend N receives NOTHING' },
      { id: '9',  desc: 'story.expired per-owner isolation: F3 gets O2\'s only; F1/F2 get O\'s only; N gets nothing' },
      { id: '10', desc: 'Envelope: channel=realtime, type top-level, no payload wrapper' },
    ];

    for (const row of table) {
      const relevant = results.filter((r) => String(r.id).startsWith(row.id) && String(r.id).match(new RegExp(`^${row.id}[a-z]?$`)));
      const anyFail  = relevant.some((r) => !r.ok);
      const icon     = anyFail ? 'FAIL' : (relevant.length > 0 ? 'PASS' : 'N/A ');
      const failList = relevant.filter((r) => !r.ok).map((r) => `[${r.id}] ${r.label}${r.detail ? ': ' + r.detail : ''}`);
      console.log(`  ${icon}  [${row.id.padEnd(2)}] ${row.desc}`);
      for (const f of failList) {
        console.log(`         ↳ ${f}`);
      }
    }

    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  END-TO-END vs MIRRORED');
    console.log('──────────────────────────────────────────────────────────────');
    console.log('  END-TO-END (real controller invoked, signal traced through socket):');
    console.log('    Assertions 1-5: real mediaController.removeStory invoked via mock req/res');
    console.log('    Signal path: mediaController.js:693-694 → utils/realtime.js → socket.io → client');
    console.log('');
    console.log('  MIRRORED CRON LOGIC (server.js NOT imported — lines 118-127 copied):');
    console.log('    Assertions 6-10: story.expired emit block mirrored from server.js:118-127');
    console.log('    Reason: server.js imports cron, boots express, would bind port 3000.');
    console.log('    The test seeds expired stories, runs the same deleteMany, then runs');
    console.log('    the exact emit loop. This proves the signal contract without importing server.');
    console.log('    Exact lines mirrored:');
    console.log('      const ownerIds = [...new Set(doomed.map(s => s.userId))];');
    console.log('      for (const ownerId of ownerIds) {');
    console.log('        realtime.toFriends(ownerId, "story.expired", { userId: ownerId }); // server.js:122');
    console.log('        realtime.toUser(ownerId,    "story.expired", { userId: ownerId }); // server.js:123');
    console.log('      }');

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  FINAL RESULTS');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(`  Total assertions : ${passed + failed}`);
    console.log(`  PASSED           : ${passed}`);
    console.log(`  FAILED           : ${failed}`);
    if (failed > 0) {
      console.log('\n  Failed assertions:');
      results.filter((r) => !r.ok).forEach((r) => {
        console.log(`    FAIL  [${r.id}] ${r.label}${r.detail ? ' — ' + r.detail : ''}`);
      });
    }
    console.log('══════════════════════════════════════════════════════════════\n');

    process.exit(failed > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('\nFATAL ERROR:', e);
  prisma.$disconnect().finally(() => process.exit(2));
});
