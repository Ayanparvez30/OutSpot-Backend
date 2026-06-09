/**
 * Item 5a — community ban / unban.
 *  • Creator can ban → CommunityBan stored + member removed + realtime emits
 *  • Banned user's joinCommunity → 403
 *  • Non-creator ban attempt → 403
 *  • Creator can unban → CommunityBan row deleted
 *  • Creator cannot ban themselves
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const prismaClientPath = require.resolve('@prisma/client');

const mockDb = {
  community: new Map(),         // id → { id, creatorId }
  members:   [],                // { id, userId, communityId }
  bans:      [],                // CommunityBan rows
  histories: [],
};
let mockMembershipsFor = (userId) => mockDb.members.filter(m => m.userId === userId);

const fakePrisma = {
  community: {
    findUnique: async ({ where, select }) => {
      const c = mockDb.community.get(where.id);
      if (!c) return null;
      if (!select) return c;
      const out = {};
      for (const k of Object.keys(select)) if (select[k]) out[k] = c[k];
      return out;
    },
  },
  communityMember: {
    findFirst: async ({ where, include }) => {
      const m = mockDb.members.find(m => (where.userId === undefined || m.userId === where.userId) && (where.communityId === undefined || m.communityId === where.communityId));
      if (!m) return null;
      const result = { ...m };
      if (include?.community) {
        const c = mockDb.community.get(m.communityId);
        result.community = c ? { id: c.id, name: c.name || `c${c.id}` } : null;
      }
      return result;
    },
    create: async ({ data }) => {
      const row = { id: mockDb.members.length + 1, ...data };
      mockDb.members.push(row);
      return row;
    },
    delete: async ({ where }) => {
      const idx = mockDb.members.findIndex(m => m.id === where.id);
      if (idx >= 0) mockDb.members.splice(idx, 1);
    },
  },
  userOnChat: {
    findFirst: async () => null,
    create: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
  },
  communityHistory: {
    create: async ({ data }) => { mockDb.histories.push(data); return {}; },
  },
  communityBan: {
    findFirst: async ({ where, select }) => {
      const ban = mockDb.bans.find(b => b.communityId === where.communityId && b.userId === where.userId);
      return ban || null;
    },
    upsert: async ({ where, update, create }) => {
      const found = mockDb.bans.find(b => b.communityId === where.communityId_userId.communityId && b.userId === where.communityId_userId.userId);
      if (found) Object.assign(found, update);
      else mockDb.bans.push({ id: mockDb.bans.length + 1, ...create });
    },
    deleteMany: async ({ where }) => {
      const before = mockDb.bans.length;
      mockDb.bans = mockDb.bans.filter(b => !(b.communityId === where.communityId && b.userId === where.userId));
      return { count: before - mockDb.bans.length };
    },
  },
  $transaction: async (ops) => Promise.all(ops),
};

require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

const realtimePath = require.resolve('../utils/realtime');
const emits = [];
require.cache[realtimePath] = {
  id: realtimePath, filename: realtimePath, loaded: true,
  exports: {
    toUser: (uid, event, payload) => emits.push({ to: 'user', uid, event, payload }),
    toCommunity: (cid, event, payload) => emits.push({ to: 'community', cid, event, payload }),
    toGroup: () => {},
    toUsers: () => {},
    toFriends: () => {},
  },
};

const community = require('../controllers/communityController');

function req({ id, params, body }) { return { authData: { id }, params: params || {}, body: body || {} }; }
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // ---------- 1. Creator can ban an existing member ----------
  console.log('\n[1] Creator can ban a member → ban row + member removed + realtime emits');

  mockDb.community.set(10, { id: 10, creatorId: 42 });
  mockDb.members.push({ id: 1, userId: 99, communityId: 10 });
  mockDb.bans = [];
  emits.length = 0;

  const r1 = res();
  await community.banMember(req({
    id: 42, params: { communityId: '10', userId: '99' },
    body: { reason: 'harassment' },
  }), r1);
  eq('ban returns 200', r1.statusCode, 200);
  eq('one ban row',     mockDb.bans.length, 1);
  eq('ban target',      mockDb.bans[0].userId, 99);
  eq('ban reason',      mockDb.bans[0].reason, 'harassment');
  eq('bannedById',      mockDb.bans[0].bannedById, 42);
  eq('member removed',  mockDb.members.length, 0);
  ok('community.member_banned emitted',  emits.some(e => e.event === 'community.member_banned' && e.to === 'community'));
  ok('per-user banned emit',             emits.some(e => e.event === 'community.member_banned' && e.uid === 99));

  // ---------- 2. Banned user's joinCommunity → 403 ----------
  console.log('\n[2] Banned user cannot join');

  // Set up bans
  mockDb.bans = [{ id: 1, communityId: 10, userId: 99, bannedById: 42, reason: 'spam' }];
  mockDb.members = [];

  const r2 = res();
  await community.joinCommunity(req({ id: 99, body: { communityId: 10 } }), r2);
  eq('join returns 403',       r2.statusCode, 403);
  eq('error mentions banned',  /banned/i.test(String(r2.body?.error || '')), true);
  eq('member not added',       mockDb.members.length, 0);

  // ---------- 3. Non-creator cannot ban ----------
  console.log('\n[3] Non-creator → 403');

  mockDb.community.set(20, { id: 20, creatorId: 1 }); // someone else creator
  mockDb.members.push({ id: 2, userId: 99, communityId: 20 });
  mockDb.bans = [];

  const r3 = res();
  await community.banMember(req({
    id: 42, params: { communityId: '20', userId: '99' },
    body: {},
  }), r3);
  eq('returns 403',      r3.statusCode, 403);
  eq('no ban row',       mockDb.bans.length, 0);
  eq('member preserved', mockDb.members.find(m => m.userId === 99 && m.communityId === 20) !== undefined, true);

  // ---------- 4. Creator cannot ban themselves ----------
  console.log('\n[4] Creator banning self → 403');

  mockDb.community.set(30, { id: 30, creatorId: 42 });
  mockDb.bans = [];

  const r4 = res();
  await community.banMember(req({
    id: 42, params: { communityId: '30', userId: '42' },
    body: {},
  }), r4);
  eq('returns 403',  r4.statusCode, 403);
  eq('no ban row',   mockDb.bans.length, 0);

  // ---------- 5. Unban ----------
  console.log('\n[5] Unban removes the row');

  mockDb.community.set(40, { id: 40, creatorId: 42 });
  mockDb.bans = [{ id: 99, communityId: 40, userId: 99, bannedById: 42, reason: null }];
  emits.length = 0;

  const r5 = res();
  await community.unbanMember(req({ id: 42, params: { communityId: '40', userId: '99' } }), r5);
  eq('unban returns 200', r5.statusCode, 200);
  eq('ban row gone',      mockDb.bans.length, 0);
  ok('member_unbanned emit', emits.some(e => e.event === 'community.member_unbanned' && e.uid === 99));

  // ---------- 6. Non-creator unban → 403 ----------
  console.log('\n[6] Non-creator unban → 403');

  mockDb.community.set(50, { id: 50, creatorId: 1 });
  mockDb.bans = [{ id: 99, communityId: 50, userId: 99, bannedById: 1, reason: null }];

  const r6 = res();
  await community.unbanMember(req({ id: 42, params: { communityId: '50', userId: '99' } }), r6);
  eq('returns 403', r6.statusCode, 403);
  eq('ban preserved', mockDb.bans.length, 1);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
