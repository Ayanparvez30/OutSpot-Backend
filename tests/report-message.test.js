/**
 * Report message (item 2) + unify user-report (item 3).
 *
 *  • POST /chats/messages/:id/report — member can report, non-member 403,
 *    invalid input rejected, row stored with full context (type=message,
 *    chatId, contextType, communityId, messageId)
 *  • POST /api/report (existing) — still works with old payload (writes
 *    type='user' via column default); optionally accepts reason/note
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const prismaClientPath = require.resolve('@prisma/client');

let mockMessages = [];
let createdReports = [];
const fakePrisma = {
  message: {
    findUnique: async ({ where }) => mockMessages.find((m) => m.id === where.id) || null,
  },
  report: {
    create: async ({ data }) => {
      const row = { id: createdReports.length + 1, createdAt: new Date(), type: 'user', ...data };
      createdReports.push(row);
      return row;
    },
  },
};

require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// Stubs chatController loads
const chatHelpersPath = require.resolve('../utils/chatHelpers');
require.cache[chatHelpersPath] = {
  id: chatHelpersPath, filename: chatHelpersPath, loaded: true,
  exports: { getBulkUnreadCounts: async () => new Map(), markChatAsRead: async () => {}, getChatReadStatus: async () => ({}) },
};
const weeklyPath = require.resolve('../utils/weeklyPoints');
require.cache[weeklyPath] = {
  id: weeklyPath, filename: weeklyPath, loaded: true,
  exports: { getWeeklyPointsForUsers: async () => new Map(), getWeeklyPointsForUser: async () => 0 },
};

const chat = require('../controllers/chatController');
const reportCtrl = require('../controllers/reportController');

function req({ id, params, body, query }) {
  return { authData: { id }, params: params || {}, body: body || {}, query: query || {} };
}
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // ---------- 1. Member of DM can report ----------
  console.log('\n[1] Member of DM can report → 201 + row stored');

  mockMessages = [{
    id: 11, senderId: 99, chatId: 5, content: 'bad',
    chat: { id: 5, isCommunity: false, isGroup: false, communityId: null, users: [
      { userId: 42 }, { userId: 99 },
    ]},
  }];
  createdReports = [];

  const r1 = res();
  await chat.reportMessage(req({
    id: 42, params: { messageId: '11' },
    body: { reason: 'harassment', note: 'rude language' },
  }), r1);

  eq('returns 201',                   r1.statusCode, 201);
  eq('success',                       r1.body?.success, true);
  eq('one row created',               createdReports.length, 1);
  const row = createdReports[0];
  eq('type=message',                  row.type, 'message');
  eq('reporterId',                    row.reporterId, 42);
  eq('reportedId = message.senderId', row.reportedId, 99);
  eq('messageId',                     row.messageId, 11);
  eq('chatId',                        row.chatId, 5);
  eq('contextType=dm',                row.contextType, 'dm');
  eq('communityId null for dm',       row.communityId, null);
  eq('reason stored',                 row.reason, 'harassment');
  eq('note stored',                   row.note, 'rude language');
  eq('status=PENDING',                row.status, 'PENDING');

  // ---------- 2. Group context ----------
  console.log('\n[2] Group context derives contextType="group"');

  mockMessages = [{
    id: 12, senderId: 100, chatId: 7,
    chat: { id: 7, isCommunity: false, isGroup: true, communityId: null, users: [
      { userId: 42 }, { userId: 100 }, { userId: 200 },
    ]},
  }];
  createdReports = [];

  const r2 = res();
  await chat.reportMessage(req({
    id: 42, params: { messageId: '12' },
    body: { reason: 'spam' },
  }), r2);
  eq('contextType=group', createdReports[0]?.contextType, 'group');
  eq('communityId null', createdReports[0]?.communityId, null);
  eq('note null when omitted', createdReports[0]?.note, null);

  // ---------- 3. Community context ----------
  console.log('\n[3] Community context derives contextType="community" + communityId');

  mockMessages = [{
    id: 13, senderId: 101, chatId: 9,
    chat: { id: 9, isCommunity: true, isGroup: false, communityId: 555, users: [
      { userId: 42 }, { userId: 101 },
    ]},
  }];
  createdReports = [];

  const r3 = res();
  await chat.reportMessage(req({
    id: 42, params: { messageId: '13' },
    body: { reason: 'nudity' },
  }), r3);
  eq('contextType=community', createdReports[0]?.contextType, 'community');
  eq('communityId set',        createdReports[0]?.communityId, 555);

  // ---------- 4. Non-member → 403 ----------
  console.log('\n[4] Non-member of chat → 403');

  mockMessages = [{
    id: 14, senderId: 200, chatId: 10,
    chat: { id: 10, isCommunity: false, isGroup: true, communityId: null, users: [
      { userId: 99 }, { userId: 200 }, // 42 is NOT a member
    ]},
  }];
  createdReports = [];

  const r4 = res();
  await chat.reportMessage(req({
    id: 42, params: { messageId: '14' }, body: { reason: 'spam' },
  }), r4);
  eq('returns 403',          r4.statusCode, 403);
  eq('no row stored',        createdReports.length, 0);

  // ---------- 5. Missing reason → 400 ----------
  console.log('\n[5] Missing reason → 400');

  mockMessages = [{ id: 15, senderId: 100, chatId: 5, chat: { id: 5, isCommunity: false, isGroup: false, communityId: null, users: [{ userId: 42 }, { userId: 100 }] } }];
  createdReports = [];
  const r5 = res();
  await chat.reportMessage(req({ id: 42, params: { messageId: '15' }, body: {} }), r5);
  eq('returns 400', r5.statusCode, 400);

  // ---------- 6. Message not found → 404 ----------
  console.log('\n[6] Non-existent messageId → 404');

  mockMessages = [];
  const r6 = res();
  await chat.reportMessage(req({ id: 42, params: { messageId: '9999' }, body: { reason: 'spam' } }), r6);
  eq('returns 404', r6.statusCode, 404);

  // ---------- 7. Existing /api/report still works (regression) ----------
  console.log('\n[7] Existing /api/report (user-report) still works');

  createdReports = [];
  const r7 = res();
  await reportCtrl.reportUser(req({ id: 42, body: { reportedId: 99 } }), r7);
  eq('returns 201',                    r7.statusCode, 201);
  eq('one row stored',                 createdReports.length, 1);
  eq('reporterId',                     createdReports[0]?.reporterId, 42);
  eq('reportedId',                     createdReports[0]?.reportedId, 99);
  // type field is NOT explicitly written by reportUser — it comes from the
  // DB column default 'user'. The mock simulates that.
  eq('type defaults to user',          createdReports[0]?.type, 'user');
  ok('no reason set (legacy payload)', !('reason' in createdReports[0]) || createdReports[0].reason === undefined);

  // ---------- 8. /api/report accepts optional reason/note ----------
  console.log('\n[8] /api/report accepts optional reason/note');

  createdReports = [];
  const r8 = res();
  await reportCtrl.reportUser(req({ id: 42, body: { reportedId: 99, reason: 'impersonation', note: 'fake profile' } }), r8);
  eq('reason forwarded', createdReports[0]?.reason, 'impersonation');
  eq('note forwarded',   createdReports[0]?.note, 'fake profile');

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
