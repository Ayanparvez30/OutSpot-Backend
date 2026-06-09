/**
 * GET /api/challenges/history — In Progress + Completed tabs.
 *
 * Verifies:
 *   • Submissions are grouped by (challengeId, derivedWindowKey)
 *   • windowKey uses dateKeyInZone for DAILY, weekKeyInZone for WEEKLY
 *     (in App TZ — America/New_York by default)
 *   • Completed = uploadedCount >= requiredCount
 *   • In Progress = 0 < uploadedCount < requiredCount
 *   • Card shape mirrors getFilteredChallenges (same FE card widget renders)
 *   • Per-user submissionMediaUrls are surfaced + preserved per-user
 *   • timeRemainingMs > 0 for current window, 0 for past windows
 *   • frequency filter (all|daily|weekly)
 *   • Pagination (page / pageSize / hasMore)
 *   • Sorted by submittedAt desc
 *
 * Pure stubs, no DB.
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const { DateTime } = require('luxon');

// Build realistic submission rows in America/New_York timezone.
const ZONE = 'America/New_York';
const todayDt = DateTime.now().setZone(ZONE);
const yesterdayDt = todayDt.minus({ days: 1 });
const lastWeekDt = todayDt.minus({ weeks: 1 });
const twoMonthsAgoDt = todayDt.minus({ months: 2 });

// Fixed challenge rows
const C_DAILY  = { id: 100, title: 'Snap a Sunset',  description: 'Capture today\'s sunset.',  frequency: 'DAILY',  tier: 'SILVER', points: 10, requiredPhotos: 1 };
const C_WEEKLY = { id: 200, title: 'Coffee Crawl',   description: 'Visit 3 different coffee shops.', frequency: 'WEEKLY', tier: 'GOLD', points: 25, requiredPhotos: 3 };
const C_WEEKLY_OTHER = { id: 201, title: 'City Best', description: 'Find your city best burger.', frequency: 'WEEKLY', tier: 'SILVER', points: 15, requiredPhotos: 1 };

const allSubs = [
  // Completed daily TODAY (1/1)
  { id: 1, userId: 42, challengeId: 100, mediaUrl: 's3://daily-today-1.jpg', createdAt: todayDt.toJSDate(), challenge: C_DAILY },

  // Completed daily YESTERDAY (1/1) — separate window key from today
  { id: 2, userId: 42, challengeId: 100, mediaUrl: 's3://daily-yest-1.jpg', createdAt: yesterdayDt.toJSDate(), challenge: C_DAILY },

  // Two-months-ago daily completed (history)
  { id: 3, userId: 42, challengeId: 100, mediaUrl: 's3://daily-old-1.jpg', createdAt: twoMonthsAgoDt.toJSDate(), challenge: C_DAILY },

  // Weekly THIS WEEK — only 2/3 → in progress
  { id: 4, userId: 42, challengeId: 200, mediaUrl: 's3://weekly-curr-1.jpg', createdAt: todayDt.toJSDate(),       challenge: C_WEEKLY },
  { id: 5, userId: 42, challengeId: 200, mediaUrl: 's3://weekly-curr-2.jpg', createdAt: todayDt.minus({hours:3}).toJSDate(), challenge: C_WEEKLY },

  // Weekly LAST WEEK — 3/3 → completed
  { id: 6, userId: 42, challengeId: 200, mediaUrl: 's3://weekly-last-1.jpg', createdAt: lastWeekDt.toJSDate(), challenge: C_WEEKLY },
  { id: 7, userId: 42, challengeId: 200, mediaUrl: 's3://weekly-last-2.jpg', createdAt: lastWeekDt.plus({hours:1}).toJSDate(), challenge: C_WEEKLY },
  { id: 8, userId: 42, challengeId: 200, mediaUrl: 's3://weekly-last-3.jpg', createdAt: lastWeekDt.plus({hours:2}).toJSDate(), challenge: C_WEEKLY },

  // Weekly other (requiredPhotos=1) — completed this week
  { id: 9, userId: 42, challengeId: 201, mediaUrl: 's3://w-other-1.jpg', createdAt: todayDt.minus({hours:6}).toJSDate(), challenge: C_WEEKLY_OTHER },
];

// Stub Prisma
const prismaClientPath = require.resolve('@prisma/client');
const fakePrisma = {
  submission: {
    findMany: async ({ where, include, orderBy }) => {
      let rows = allSubs.filter(s => s.userId === where.userId);
      // frequency-narrow filter:
      if (where.challenge?.frequency) rows = rows.filter(s => s.challenge.frequency === where.challenge.frequency);
      // sort desc createdAt:
      rows.sort((a, b) => b.createdAt - a.createdAt);
      return rows.map(r => ({ ...r }));
    },
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

// challengeVerification pulls in OpenAI which requires an API key at import.
const verifyPath = require.resolve('../utils/challengeVerification');
require.cache[verifyPath] = { id: verifyPath, filename: verifyPath, loaded: true, exports: { verifySubmissionImage: async () => ({}), checkTimeConstraints: async () => ({}), checkDuplicateImage: async () => ({}) } };
const challNotifPath = require.resolve('../utils/challengeNotifications');
require.cache[challNotifPath] = { id: challNotifPath, filename: challNotifPath, loaded: true, exports: { notifyNewChallenge: async () => {} } };

const chall = require('../controllers/challengeController');

function req({ id, query }) { return { authData: { id }, query: query || {}, user: {} }; }
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // ---------- 1. Completed tab — both historical + current ----------
  console.log('\n[1] Completed tab — all fully-submitted (historical + current)');

  const r1 = res();
  await chall.getChallengeHistory(req({ id: 42, query: { tab: 'completed' } }), r1);
  const items1 = r1.body?.items || [];
  eq('200',                             r1.statusCode, 200);

  // Completed groups: daily today, daily yesterday, daily 2-months-ago, weekly last week, weekly_other this week = 5
  eq('5 completed groups',              items1.length, 5);
  ok('all status=completed',            items1.every(i => i.status === 'completed'));
  ok('all uploadedCount >= requiredCount', items1.every(i => i.uploadedCount >= i.requiredCount));

  // ---------- 2. Card shape mirrors getFilteredChallenges ----------
  console.log('\n[2] Card shape matches existing FilteredChallenges card');

  const sample = items1[0];
  for (const k of ['id','title','preview','frequency','tier','points','requiredCount','uploadedCount','status','timeRemainingMs','windowKey','zone']) {
    ok(`field ${k} present`, k in sample);
  }
  eq('preview ≤ 120 chars',             sample.preview.length <= 120, true);
  // New optional extras for history
  ok('submittedAt present',             !!sample.submittedAt);
  ok('submissionMediaUrls is array',    Array.isArray(sample.submissionMediaUrls));

  // ---------- 3. In Progress tab — only weekly current (2/3) ----------
  console.log('\n[3] In Progress tab — only the half-done current weekly');

  const r3 = res();
  await chall.getChallengeHistory(req({ id: 42, query: { tab: 'in_progress' } }), r3);
  const items3 = r3.body?.items || [];
  eq('1 in-progress group',             items3.length, 1);
  eq('that group is weekly current',    items3[0]?.frequency, 'WEEKLY');
  eq('uploadedCount=2',                 items3[0]?.uploadedCount, 2);
  eq('requiredCount=3',                 items3[0]?.requiredCount, 3);
  eq('status=in_progress',              items3[0]?.status, 'in_progress');
  ok('timeRemainingMs > 0 (current window)', items3[0]?.timeRemainingMs > 0);

  // ---------- 4. submissionMediaUrls oldest→newest within each group ----------
  console.log('\n[4] Per-user submissionMediaUrls preserved + ordered oldest→newest');

  // For the weekly in-progress group with submissions on today + 3h-ago
  const wk = items3[0];
  eq('2 media urls',                    wk.submissionMediaUrls.length, 2);
  // The 3h-ago one was created BEFORE today's, so should appear FIRST in oldest→newest list
  // submissions sorted desc by createdAt → [today, 3h-ago]; .reverse() → [3h-ago, today]
  eq('first url = older',               wk.submissionMediaUrls[0], 's3://weekly-curr-2.jpg');
  eq('second url = newer',              wk.submissionMediaUrls[1], 's3://weekly-curr-1.jpg');

  // ---------- 5. Past-window cards have timeRemainingMs = 0 ----------
  console.log('\n[5] Past-window cards expose timeRemainingMs = 0');

  const yesterdayCard = items1.find(i => i.frequency === 'DAILY' && i.windowKey !== sample.windowKey);
  // pick the older daily
  const oldDailies = items1.filter(i => i.frequency === 'DAILY');
  const currentDailyKey = require('luxon').DateTime.now().setZone(ZONE).toFormat('yyyy-LL-dd');
  for (const d of oldDailies) {
    if (d.windowKey === currentDailyKey) ok(`current daily timeRemainingMs > 0`, d.timeRemainingMs > 0);
    else                                 ok(`past daily (${d.windowKey}) timeRemainingMs = 0`, d.timeRemainingMs === 0);
  }

  // ---------- 6. frequency=daily filter ----------
  console.log('\n[6] frequency=daily narrows to daily groups only');

  const r6 = res();
  await chall.getChallengeHistory(req({ id: 42, query: { tab: 'completed', frequency: 'daily' } }), r6);
  const items6 = r6.body?.items || [];
  eq('3 daily-only completed groups',   items6.length, 3);
  ok('all frequency=DAILY',             items6.every(i => i.frequency === 'DAILY'));

  // ---------- 7. frequency=weekly filter ----------
  console.log('\n[7] frequency=weekly narrows to weekly groups only');

  const r7 = res();
  await chall.getChallengeHistory(req({ id: 42, query: { tab: 'completed', frequency: 'weekly' } }), r7);
  const items7 = r7.body?.items || [];
  eq('2 weekly-only completed groups',  items7.length, 2);
  ok('all frequency=WEEKLY',            items7.every(i => i.frequency === 'WEEKLY'));

  // ---------- 8. Sort by submittedAt desc (newest first) ----------
  console.log('\n[8] Sorted by submittedAt desc');

  const r8 = res();
  await chall.getChallengeHistory(req({ id: 42, query: { tab: 'completed' } }), r8);
  const items8 = r8.body?.items || [];
  for (let i = 1; i < items8.length; i++) {
    ok(`item[${i}] submittedAt <= item[${i-1}]`,
       new Date(items8[i].submittedAt) <= new Date(items8[i-1].submittedAt));
  }

  // ---------- 9. Pagination ----------
  console.log('\n[9] Pagination — page=1, pageSize=2');

  const r9 = res();
  await chall.getChallengeHistory(req({ id: 42, query: { tab: 'completed', page: 1, pageSize: 2 } }), r9);
  eq('items.length = 2',                r9.body?.items?.length, 2);
  eq('total = 5',                       r9.body?.total, 5);
  eq('page = 1',                        r9.body?.page, 1);
  eq('hasMore = true',                  r9.body?.hasMore, true);

  const r9b = res();
  await chall.getChallengeHistory(req({ id: 42, query: { tab: 'completed', page: 3, pageSize: 2 } }), r9b);
  eq('items.length = 1 (last page)',    r9b.body?.items?.length, 1);
  eq('hasMore = false',                 r9b.body?.hasMore, false);

  // ---------- 10. Bad tab → 400 ----------
  console.log('\n[10] Bad tab → 400');

  const r10 = res();
  await chall.getChallengeHistory(req({ id: 42, query: { tab: 'all' } }), r10);
  eq('400',                             r10.statusCode, 400);

  // ---------- 11. Bad frequency → 400 ----------
  console.log('\n[11] Bad frequency → 400');

  const r11 = res();
  await chall.getChallengeHistory(req({ id: 42, query: { tab: 'completed', frequency: 'monthly' } }), r11);
  eq('400',                             r11.statusCode, 400);

  // ---------- 12. User isolation — only the caller's submissions appear ----------
  console.log('\n[12] User isolation — only the caller\'s submissions returned');

  // Add a foreign submission and ensure it never shows up
  allSubs.push({ id: 999, userId: 99, challengeId: 100, mediaUrl: 's3://foreign.jpg', createdAt: todayDt.toJSDate(), challenge: C_DAILY });
  const r12 = res();
  await chall.getChallengeHistory(req({ id: 42, query: { tab: 'completed' } }), r12);
  ok('foreign user\'s media never in this user\'s payload',
     !(r12.body?.items || []).flatMap(i => i.submissionMediaUrls).includes('s3://foreign.jpg'));

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
