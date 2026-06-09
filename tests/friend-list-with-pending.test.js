/**
 * Friend list merge + cancel-request revert.
 *
 * Verifies:
 *   1. GET /api/friends returns ACCEPTED friends with status="ACCEPTED"
 *   2. Outgoing PENDING requests merged into same data[], status="PENDING_SENT"
 *   3. Accepted-first ordering preserved
 *   4. declineFriendRequest deletes the receiver's FRIEND_REQUEST notification row
 *      keyed by userId + type + actorId
 *   5. declineFriendRequest works for BOTH cancel-sent and decline-received paths
 *
 * Zero HTTP, zero DB. Pure stubs.
 */

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, got, want) { assert(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// --- Stub PrismaClient before requiring the controller ---
const prismaClientPath = require.resolve('@prisma/client');
const mockDb = {
  friendships: [
    // 42 is current user
    { id: 1, requesterId: 42, receiverId: 100, status: 'ACCEPTED' },
    { id: 2, requesterId: 101, receiverId: 42, status: 'ACCEPTED' },
    // outgoing pending (42 → 200, 201)
    { id: 3, requesterId: 42, receiverId: 200, status: 'PENDING' },
    { id: 4, requesterId: 42, receiverId: 201, status: 'PENDING' },
    // incoming pending (300 → 42) — should NOT appear in friend list
    { id: 5, requesterId: 300, receiverId: 42, status: 'PENDING' },
  ],
  users: new Map([
    [100, { id: 100, username: 'alice', firstName: 'Alice', lastName: 'A', totalPoints: 50, minime: [{ avatarUrl: 'a.png' }] }],
    [101, { id: 101, username: 'bob',   firstName: 'Bob',   lastName: 'B', totalPoints: 70, minime: [] }],
    [200, { id: 200, username: 'sheek', firstName: 'Sheek', lastName: 'S', totalPoints: 0,  minime: [{ avatarUrl: 's.png' }] }],
    [201, { id: 201, username: 'bappi', firstName: 'Bappi', lastName: 'K', totalPoints: 5,  minime: [] }],
  ]),
  notifications: [
    { id: 11, userId: 200, type: 'FRIEND_REQUEST', actorId: 42, title: 'X sent you' },
    { id: 12, userId: 201, type: 'FRIEND_REQUEST', actorId: 42, title: 'X sent you' },
    { id: 13, userId: 200, type: 'NEW_CHALLENGE', actorId: null, title: 'Other' }, // must not be touched
    { id: 14, userId: 42,  type: 'FRIEND_REQUEST', actorId: 300, title: '300 sent you' },
  ],
};

const fakePrisma = {
  friendship: {
    findMany: async ({ where, include }) => {
      let rows = mockDb.friendships.slice();
      if (where.status) rows = rows.filter(r => r.status === where.status);
      if (where.OR) {
        rows = rows.filter(r => where.OR.some(c =>
          (c.requesterId === undefined || c.requesterId === r.requesterId) &&
          (c.receiverId === undefined || c.receiverId === r.receiverId)
        ));
      }
      if (where.requesterId !== undefined) rows = rows.filter(r => r.requesterId === where.requesterId);
      if (where.receiverId !== undefined) rows = rows.filter(r => r.receiverId === where.receiverId);
      return rows.map(r => ({
        ...r,
        requester: include?.requester ? mockDb.users.get(r.requesterId) : undefined,
        receiver: include?.receiver ? mockDb.users.get(r.receiverId) : undefined,
      }));
    },
    findFirst: async ({ where }) => {
      const rows = mockDb.friendships.filter(r => {
        if (where.status && r.status !== where.status) return false;
        if (where.OR) {
          return where.OR.some(c =>
            (c.requesterId === undefined || c.requesterId === r.requesterId) &&
            (c.receiverId === undefined || c.receiverId === r.receiverId)
          );
        }
        return true;
      });
      return rows[0] || null;
    },
    delete: async ({ where }) => {
      mockDb.friendships = mockDb.friendships.filter(r => r.id !== where.id);
    },
  },
  notification: {
    deleteMany: async ({ where }) => {
      const before = mockDb.notifications.length;
      mockDb.notifications = mockDb.notifications.filter(n => !(
        n.userId === where.userId &&
        n.type === where.type &&
        n.actorId === where.actorId
      ));
      return { count: before - mockDb.notifications.length };
    },
  },
  pointsLedger: { findMany: async () => [], groupBy: async () => [] },
};

require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// Stub realtime to capture emits (silent — no actual side effect).
const realtimePath = require.resolve('../utils/realtime');
const realtimeEmits = [];
require.cache[realtimePath] = {
  id: realtimePath, filename: realtimePath, loaded: true,
  exports: {
    toUser: (uid, event, payload) => realtimeEmits.push({ uid, event, payload }),
    toUsers: (uids, event, payload) => realtimeEmits.push({ uids, event, payload }),
    toCommunity: () => {},
  },
};

const friend = require('../controllers/friendController');

function makeReq({ id, params }) { return { authData: { id }, params: params || {} }; }
function makeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  console.log('\n[1] getFriendList — merged + status field');

  const res = makeRes();
  await friend.getFriendList(makeReq({ id: 42 }), res);
  const data = res.body?.data || [];

  eq('returns success',           res.body?.success, true);
  eq('total entries = 4 (2 accepted + 2 pending)', data.length, 4);

  const accepted = data.filter(d => d.status === 'ACCEPTED');
  const pending  = data.filter(d => d.status === 'PENDING_SENT');
  eq('2 accepted', accepted.length, 2);
  eq('2 pending-sent', pending.length, 2);

  // Accepted-first ordering
  eq('first entry is ACCEPTED',  data[0]?.status, 'ACCEPTED');
  eq('last entry is PENDING_SENT', data[data.length - 1]?.status, 'PENDING_SENT');

  // Spot-check shape
  const alice = accepted.find(a => a.id === 100);
  eq('Alice firstName',       alice?.firstName, 'Alice');
  eq('Alice avatarUrl',       alice?.avatarUrl, 'a.png');
  eq('Alice status',          alice?.status, 'ACCEPTED');
  eq('Alice has thisWeekPoints', typeof alice?.thisWeekPoints, 'number');

  const sheek = pending.find(p => p.id === 200);
  eq('Sheek firstName',       sheek?.firstName, 'Sheek');
  eq('Sheek status',          sheek?.status, 'PENDING_SENT');
  eq('Sheek avatarUrl',       sheek?.avatarUrl, 's.png');
  eq('Sheek thisWeekPoints=0',sheek?.thisWeekPoints, 0);

  const bappi = pending.find(p => p.id === 201);
  eq('Bappi (no minime) avatarUrl=null', bappi?.avatarUrl, null);

  // Incoming pending (300 → 42) must NOT appear
  const incoming = data.find(d => d.id === 300);
  assert('incoming pending NOT in friend list', !incoming);

  // ---------- 2. Cancel sent request → notification cleanup ----------
  console.log('\n[2] declineFriendRequest (cancel sent) cleans notification row');

  realtimeEmits.length = 0;
  const beforeNotifCount = mockDb.notifications.length;
  const cancelRes = makeRes();
  await friend.declineFriendRequest(
    makeReq({ id: 42, params: { userId: '200' } }),
    cancelRes
  );

  eq('cancel returns 200', cancelRes.statusCode, 200);
  // Friendship row 3 should be gone
  assert('friendship row 3 deleted', !mockDb.friendships.find(r => r.id === 3));
  // Notification row 11 (recipient=200, type=FRIEND_REQUEST, actorId=42) deleted
  assert('receiver notification row deleted', !mockDb.notifications.find(n => n.id === 11));
  // Unrelated rows untouched
  assert('other-type notification preserved', !!mockDb.notifications.find(n => n.id === 13));
  assert('different recipient notification preserved', !!mockDb.notifications.find(n => n.id === 12));
  // Realtime emit toward the OTHER party (200)
  eq('realtime.toUser fired',         realtimeEmits.length, 1);
  eq('realtime target = 200',         realtimeEmits[0]?.uid, 200);
  eq('realtime event = request_declined', realtimeEmits[0]?.event, 'friend.request_declined');

  // ---------- 3. Decline RECEIVED request (other side cancels) ----------
  console.log('\n[3] declineFriendRequest (decline received) cleans notification row');

  // friendship row 5: requester=300 → receiver=42 (incoming).
  // Current user = 42 declines. Should delete notification 14 (userId=42, actorId=300).
  realtimeEmits.length = 0;
  const declineRes = makeRes();
  await friend.declineFriendRequest(
    makeReq({ id: 42, params: { userId: '300' } }),
    declineRes
  );

  eq('decline returns 200',                          declineRes.statusCode, 200);
  assert('friendship row 5 deleted',                 !mockDb.friendships.find(r => r.id === 5));
  assert('current-user notification 14 deleted',     !mockDb.notifications.find(n => n.id === 14));
  eq('realtime target = 300 (sender)',               realtimeEmits[0]?.uid, 300);

  // ---------- 4. Decline 404 if no pending row ----------
  console.log('\n[4] declineFriendRequest 404 when no pending row');

  const notFoundRes = makeRes();
  await friend.declineFriendRequest(
    makeReq({ id: 42, params: { userId: '9999' } }),
    notFoundRes
  );
  eq('404 when none', notFoundRes.statusCode, 404);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch(err => {
  console.error('TEST CRASH', err);
  process.exit(1);
});
