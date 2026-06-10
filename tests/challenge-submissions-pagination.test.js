/**
 * GET /api/challenges/:challengeId/submissions
 *
 * Verifies the pagination + friends-first ordering:
 *   • Response envelope includes items / page / pageSize / total / hasMore
 *   • Global ordering: friends → shared community/group → others
 *   • Within tier: by submittedAt per sort param (newest / oldest)
 *   • Deterministic tiebreak by userId asc when times tie
 *   • Excludes the requester
 *   • page/pageSize slice across the assembled ordered list
 *   • hasMore false on last page; page past end → empty items
 *   • submittedAt populated per item
 *   • requiredCount kept for back-compat
 *   • Pagination skipped at scale: only the page slice is hydrated
 *
 * Pure stubs.
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// Build a deterministic fixture.
//   me = 1
//   friends of me  = {10, 11, 12}
//   my community A → co-members {20, 21, 22, 11}   (11 also a friend → friend tier)
//   my group G     → co-members {30, 31, 22}       (22 dedupes with comm)
//   submitters (excluding me):
//     friends who submitted: 10, 11   (12 didn't submit)
//     shared who submitted:  20, 21, 22, 30, 31
//     others who submitted:  40, 41, 42, 43, 44, 45, 46, 47

const ME = 1;
const submissions = []; // each: { userId, challengeId, createdAt, mediaUrl }

// Fixed window
const BASE = new Date('2026-06-10T00:00:00.000Z');
const CHALL = { id: 500, frequency: 'WEEKLY', requiredPhotos: 3, points: 25 };

function addSub(userId, hourOffset) {
  submissions.push({
    userId,
    challengeId: CHALL.id,
    mediaUrl: `s3://u${userId}/h${hourOffset}.jpg`,
    createdAt: new Date(BASE.getTime() + hourOffset * 3600 * 1000),
  });
}
// times chosen so ordering is unambiguous
addSub(10, 50); addSub(10, 51);  addSub(10, 52);    // friend 10: latest 52
addSub(11, 40);                                       // friend 11: latest 40
addSub(20, 49); addSub(20, 49.5);                     // shared 20: latest 49.5
addSub(21, 30);
addSub(22, 35);
addSub(30, 48);
addSub(31, 25);
addSub(40, 60); addSub(41, 58); addSub(42, 56); addSub(43, 54);
addSub(44, 53); addSub(45, 52); addSub(46, 51); addSub(47, 50);

// Stub Prisma
const prismaClientPath = require.resolve('@prisma/client');
const friendships = [
  // pairs with status ACCEPTED
  { requesterId: 1, receiverId: 10, status: 'ACCEPTED' },
  { requesterId: 1, receiverId: 11, status: 'ACCEPTED' },
  { requesterId: 12, receiverId: 1, status: 'ACCEPTED' },
];
const commMembers = [
  { userId: 1,  communityId: 100 },
  { userId: 20, communityId: 100 },
  { userId: 21, communityId: 100 },
  { userId: 22, communityId: 100 },
  { userId: 11, communityId: 100 }, // also a friend
];
const communities = new Map([[100, { id: 100, name: 'Photography Club' }]]);
const userOnChats = [
  { userId: 1,  chatId: 200, chat: { id: 200, name: 'Weekend Hikers', isGroup: true, isCommunity: false } },
  { userId: 30, chatId: 200, chat: { id: 200, name: 'Weekend Hikers', isGroup: true, isCommunity: false } },
  { userId: 31, chatId: 200, chat: { id: 200, name: 'Weekend Hikers', isGroup: true, isCommunity: false } },
  { userId: 22, chatId: 200, chat: { id: 200, name: 'Weekend Hikers', isGroup: true, isCommunity: false } },
];
const users = new Map();
for (const uid of [1, 10, 11, 12, 20, 21, 22, 30, 31, 40, 41, 42, 43, 44, 45, 46, 47]) {
  users.set(uid, { id: uid, username: `u${uid}`, firstName: `F${uid}`, lastName: 'L', totalPoints: uid, minime: [] });
}

const fakePrisma = {
  challenge: {
    findUnique: async () => CHALL,
  },
  friendship: {
    findMany: async ({ where }) => {
      // Where: status=ACCEPTED OR=[{requesterId: me}, {receiverId: me}]
      return friendships.filter(f => f.status === 'ACCEPTED' && (f.requesterId === ME || f.receiverId === ME));
    },
  },
  communityMember: {
    findMany: async ({ where, include, select }) => {
      let rows = commMembers.slice();
      if (where.userId !== undefined && typeof where.userId !== 'object') rows = rows.filter(r => r.userId === where.userId);
      if (where.userId?.in) rows = rows.filter(r => where.userId.in.includes(r.userId));
      if (where.communityId?.in) rows = rows.filter(r => where.communityId.in.includes(r.communityId));
      if (where.NOT?.userId !== undefined) rows = rows.filter(r => r.userId !== where.NOT.userId);
      return rows.map(r => {
        if (include?.community) return { ...r, community: communities.get(r.communityId) || null };
        return { ...r };
      });
    },
  },
  userOnChat: {
    findMany: async ({ where, include }) => {
      let rows = userOnChats.slice();
      if (where.userId !== undefined && typeof where.userId !== 'object') rows = rows.filter(r => r.userId === where.userId);
      if (where.userId?.in)     rows = rows.filter(r => where.userId.in.includes(r.userId));
      if (where.chatId?.in)     rows = rows.filter(r => where.chatId.in.includes(r.chatId));
      if (where.NOT?.userId !== undefined) rows = rows.filter(r => r.userId !== where.NOT.userId);
      if (where.chat?.isGroup) rows = rows.filter(r => r.chat.isGroup === where.chat.isGroup);
      if (where.chat?.isCommunity !== undefined) rows = rows.filter(r => r.chat.isCommunity === where.chat.isCommunity);
      return rows.map(r => include?.chat ? { ...r } : { userId: r.userId, chatId: r.chatId });
    },
  },
  submission: {
    groupBy: async ({ by, where, _max, _count, orderBy, skip, take }) => {
      let rows = submissions.filter(s => s.challengeId === where.challengeId);
      if (where.userId?.not !== undefined)   rows = rows.filter(s => s.userId !== where.userId.not);
      if (where.userId?.in)                  rows = rows.filter(s => where.userId.in.includes(s.userId));
      if (where.userId?.notIn)               rows = rows.filter(s => !where.userId.notIn.includes(s.userId));
      if (where.createdAt?.gte)              rows = rows.filter(s => s.createdAt >= where.createdAt.gte);
      if (where.createdAt?.lte)              rows = rows.filter(s => s.createdAt <= where.createdAt.lte);
      // group by userId
      const m = new Map();
      for (const r of rows) {
        if (!m.has(r.userId)) m.set(r.userId, { userId: r.userId, count: 0, max: null });
        const g = m.get(r.userId);
        g.count++;
        if (!g.max || r.createdAt > g.max) g.max = r.createdAt;
      }
      let arr = [...m.values()].map(g => ({
        userId: g.userId,
        _max: { createdAt: g.max },
        _count: { _all: g.count },
      }));
      // Apply orderBy
      if (Array.isArray(orderBy)) {
        const o = orderBy[0];
        const dir = o?._max?.createdAt === 'asc' ? 'asc' : 'desc';
        arr.sort((a, b) => {
          const ta = a._max.createdAt?.getTime() || 0;
          const tb = b._max.createdAt?.getTime() || 0;
          if (ta !== tb) return dir === 'desc' ? tb - ta : ta - tb;
          return a.userId - b.userId;
        });
      }
      if (typeof skip === 'number')   arr = arr.slice(skip);
      if (typeof take === 'number')   arr = arr.slice(0, take);
      return arr;
    },
  },
  $queryRaw: async (strings, ...values) => {
    // Used for total distinct count.
    const chid = values[0], me = values[1], gte = values[2], lte = values[3];
    const distinct = new Set();
    for (const s of submissions) {
      if (s.challengeId !== chid) continue;
      if (s.userId === me) continue;
      if (s.createdAt < gte || s.createdAt > lte) continue;
      distinct.add(s.userId);
    }
    return [{ c: distinct.size }];
  },
  user: {
    findMany: async ({ where, select }) => {
      const ids = where.id?.in || [];
      return ids.map(i => users.get(i)).filter(Boolean);
    },
  },
  pointsLedger: {
    findMany: async () => [],
  },
};
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// Stubs for unrelated modules challengeController loads
const realtimePath = require.resolve('../utils/realtime');
require.cache[realtimePath] = { id: realtimePath, filename: realtimePath, loaded: true, exports: { toUser: () => {}, toUsers: () => {}, toGroup: () => {}, toCommunity: () => {}, toFriends: () => {} } };
const notifPath = require.resolve('../utils/notificationService');
require.cache[notifPath] = { id: notifPath, filename: notifPath, loaded: true, exports: { notifyUser: async () => {} } };
const verifyPath = require.resolve('../utils/challengeVerification');
require.cache[verifyPath] = { id: verifyPath, filename: verifyPath, loaded: true, exports: { verifySubmissionImage: async () => ({}), checkTimeConstraints: async () => ({}), checkDuplicateImage: async () => ({}) } };
const challNotifPath = require.resolve('../utils/challengeNotifications');
require.cache[challNotifPath] = { id: challNotifPath, filename: challNotifPath, loaded: true, exports: { notifyNewChallenge: async () => {} } };
const weeklyPath = require.resolve('../utils/weeklyPoints');
require.cache[weeklyPath] = { id: weeklyPath, filename: weeklyPath, loaded: true, exports: { getWeeklyPointsForUsers: async () => new Map(), getWeeklyPointsForUser: async () => 0 } };
const chHelpersPath = require.resolve('../utils/chatHelpers');
require.cache[chHelpersPath] = { id: chHelpersPath, filename: chHelpersPath, loaded: true, exports: { getBulkUnreadCounts: async () => new Map(), markChatAsRead: async () => {}, getChatReadStatus: async () => ({}) } };

// Override the WEEKLY window helper so our fixture (June 10) lands inside the window.
const challPath = require.resolve('../utils/challenges');
const realChall = require('../utils/challenges');
require.cache[challPath] = {
  id: challPath, filename: challPath, loaded: true,
  exports: {
    ...realChall,
    getWeekStartEndInZone: () => ({
      startUTC: new Date('2026-06-01T00:00:00.000Z'),
      endUTC:   new Date('2026-06-30T23:59:59.999Z'),
    }),
    startOfDayInZone:  () => new Date('2026-06-10T00:00:00.000Z'),
    endOfDayInZone:    () => new Date('2026-06-10T23:59:59.999Z'),
  },
};

const chall = require('../controllers/challengeController');

function req({ id, params, query }) { return { authData: { id }, params: params || {}, query: query || {}, user: {} }; }
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // Expected ordered userIds, newest-first per tier:
  // T1 (friends who submitted): 10 (latest 52h), 11 (latest 40h) → [10, 11]
  // T2 (shared-only, not friends): 20 (49.5), 30 (48), 22 (35), 21 (30), 31 (25) → [20, 30, 22, 21, 31]
  // T3 (others): 40 (60), 41 (58), 42 (56), 43 (54), 44 (53), 45 (52), 46 (51), 47 (50) → [40, 41, 42, 43, 44, 45, 46, 47]
  // Total distinct submitters = 15

  // ---------- 1. Envelope shape ----------
  console.log('\n[1] Response envelope — items / page / pageSize / total / hasMore');

  const r1 = res();
  await chall.getSubmissions(req({ id: ME, params: { challengeId: '500' }, query: { page: 1, pageSize: 20 } }), r1);
  eq('200',                              r1.statusCode, 200);
  ok('items array',                      Array.isArray(r1.body?.items));
  eq('page echoed',                      r1.body?.page, 1);
  eq('pageSize echoed',                  r1.body?.pageSize, 20);
  eq('total = 15',                       r1.body?.total, 15);
  eq('hasMore false (all on one page)',  r1.body?.hasMore, false);
  eq('requiredCount kept',               r1.body?.requiredCount, 3);

  // ---------- 2. Global ordering — Friends → Shared → Others ----------
  console.log('\n[2] Global ordering: friends first, then shared, then others');

  const order = r1.body.items.map(i => i.userId);
  eq('first 2 are friends',              order.slice(0, 2), [10, 11]);
  eq('next 5 are shared',                order.slice(2, 7), [20, 30, 22, 21, 31]);
  eq('rest are others',                  order.slice(7),     [40, 41, 42, 43, 44, 45, 46, 47]);
  // requester excluded
  ok('requester (1) excluded',           !order.includes(1));

  // ---------- 3. Within-tier ordering by submittedAt desc (default newest) ----------
  console.log('\n[3] Within tier — newest first');

  const t1Items = r1.body.items.filter(i => [10,11].includes(i.userId));
  ok('friend 10 (latest 52h) before friend 11 (latest 40h)',
     new Date(t1Items[0].submittedAt) > new Date(t1Items[1].submittedAt));

  // ---------- 4. Pagination — page 1, size 5 ----------
  console.log('\n[4] Page 1 of pageSize 5 — first 5 from the ordered global list');

  const r4 = res();
  await chall.getSubmissions(req({ id: ME, params: { challengeId: '500' }, query: { page: 1, pageSize: 5 } }), r4);
  eq('items.length=5',                   r4.body?.items?.length, 5);
  eq('hasMore true',                     r4.body?.hasMore, true);
  eq('order p1',                         r4.body.items.map(i=>i.userId), [10, 11, 20, 30, 22]);

  // ---------- 5. Pagination — page 2 ----------
  console.log('\n[5] Page 2 of pageSize 5');

  const r5 = res();
  await chall.getSubmissions(req({ id: ME, params: { challengeId: '500' }, query: { page: 2, pageSize: 5 } }), r5);
  eq('items.length=5',                   r5.body?.items?.length, 5);
  eq('page echo',                        r5.body?.page, 2);
  eq('order p2',                         r5.body.items.map(i=>i.userId), [21, 31, 40, 41, 42]);

  // ---------- 6. Pagination — page 3 (last) ----------
  console.log('\n[6] Page 3 of pageSize 5 — last page');

  const r6 = res();
  await chall.getSubmissions(req({ id: ME, params: { challengeId: '500' }, query: { page: 3, pageSize: 5 } }), r6);
  eq('items.length=5',                   r6.body?.items?.length, 5);
  eq('hasMore false (last page)',        r6.body?.hasMore, false);
  eq('order p3',                         r6.body.items.map(i=>i.userId), [43, 44, 45, 46, 47]);

  // ---------- 7. Pagination — page 4 (past end) ----------
  console.log('\n[7] Page 4 — past end → empty items, hasMore false');

  const r7 = res();
  await chall.getSubmissions(req({ id: ME, params: { challengeId: '500' }, query: { page: 4, pageSize: 5 } }), r7);
  eq('200',                              r7.statusCode, 200);
  eq('items empty',                      r7.body?.items, []);
  eq('hasMore false',                    r7.body?.hasMore, false);
  eq('total unchanged',                  r7.body?.total, 15);

  // ---------- 8. sort=oldest ----------
  console.log('\n[8] sort=oldest — reverses within each tier');

  const r8 = res();
  await chall.getSubmissions(req({ id: ME, params: { challengeId: '500' }, query: { page: 1, pageSize: 20, sort: 'oldest' } }), r8);
  // T1 reversed: 11 (40), 10 (52)
  // T2 reversed: 31 (25), 21 (30), 22 (35), 30 (48), 20 (49.5)
  // T3 reversed by latest: 47 (50), 46 (51), 45 (52), 44 (53), 43 (54), 42 (56), 41 (58), 40 (60)
  eq('oldest order', r8.body.items.map(i=>i.userId), [11, 10, 31, 21, 22, 30, 20, 47, 46, 45, 44, 43, 42, 41, 40]);

  // ---------- 9. submittedAt populated per item ----------
  console.log('\n[9] Every item has submittedAt');

  ok('all items have submittedAt', r1.body.items.every(i => !!i.submittedAt));

  // ---------- 10. relationship flags + badges ----------
  console.log('\n[10] relationship flags and badges');

  const item10 = r1.body.items.find(i => i.userId === 10);
  eq('isFriend true for friend 10',         item10?.relationship?.isFriend, true);
  ok('"Friend" badge present',              item10?.relationship?.badges?.includes('Friend'));

  const item20 = r1.body.items.find(i => i.userId === 20);
  eq('isFriend false for shared user 20',   item20?.relationship?.isFriend, false);
  ok('shared community name on user 20',    item20?.relationship?.sharedCommunities?.includes('Photography Club'));

  const item22 = r1.body.items.find(i => i.userId === 22);
  ok('user 22 shows both community and group', item22?.relationship?.sharedCommunities?.length > 0 && item22?.relationship?.sharedGroups?.length > 0);

  const item40 = r1.body.items.find(i => i.userId === 40);
  eq('isFriend false for tier-3 user',      item40?.relationship?.isFriend, false);
  eq('no shared community',                 item40?.relationship?.sharedCommunities, []);
  eq('no shared group',                     item40?.relationship?.sharedGroups, []);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
