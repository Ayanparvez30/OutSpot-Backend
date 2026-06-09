/**
 * Item 7 — admin reports pipeline (backend).
 *  • listReports accepts ?type=user|message
 *  • deleteReportedMessage hard-deletes the message, emits messagesDeleted,
 *    marks the report Resolved
 *  • Non-message report → 400
 *  • Report not found → 404
 *  • Missing messageId → 400
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const prismaClientPath = require.resolve('@prisma/client');

const mockDb = {
  reports: [],   // { id, type, status, messageId?, chatId? }
  messages: [],  // { id, chatId, imageUrl }
};
let lastFindManyWhere = null;
const fakePrisma = {
  report: {
    findMany: async ({ where, include, orderBy, skip, take }) => {
      lastFindManyWhere = where;
      return mockDb.reports
        .filter((r) =>
          (!where.status || r.status === where.status) &&
          (!where.type   || r.type   === where.type)
        )
        .map((r) => ({ ...r, reporter: { id: 42, username: 'u42' }, reported: { id: r.reportedId, username: `u${r.reportedId}` } }));
    },
    count: async ({ where }) => mockDb.reports.filter((r) =>
      (!where.status || r.status === where.status) &&
      (!where.type   || r.type   === where.type)
    ).length,
    findUnique: async ({ where, select }) => {
      const r = mockDb.reports.find((x) => x.id === where.id);
      if (!r) return null;
      if (!select) return r;
      const out = {};
      for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
      return out;
    },
    update: async ({ where, data }) => {
      const r = mockDb.reports.find((x) => x.id === where.id);
      if (r) Object.assign(r, data);
      return r;
    },
  },
  message: {
    findUnique: async ({ where, select }) => {
      const m = mockDb.messages.find((x) => x.id === where.id);
      if (!m) return null;
      if (!select) return m;
      const out = {};
      for (const k of Object.keys(select)) if (select[k]) out[k] = m[k];
      return out;
    },
    delete: async ({ where }) => {
      mockDb.messages = mockDb.messages.filter((m) => m.id !== where.id);
    },
  },
};
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// Stub notificationService (loaded by adminReportController)
const notifPath = require.resolve('../utils/notificationService');
require.cache[notifPath] = {
  id: notifPath, filename: notifPath, loaded: true,
  exports: { notifyUser: async () => {} },
};

// Stub socket.getIO + s3Cleanup
const socketPath = require.resolve('../utils/socket');
const emits = [];
require.cache[socketPath] = {
  id: socketPath, filename: socketPath, loaded: true,
  exports: {
    getIO: () => ({ to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }) }),
    deleteOwnMessages: async () => [],
  },
};
const s3Path = require.resolve('../utils/s3Cleanup');
const s3Calls = [];
require.cache[s3Path] = {
  id: s3Path, filename: s3Path, loaded: true,
  exports: { deleteS3IfOrphanBulk: async (urls) => { s3Calls.push(urls); return urls.length; } },
};

const ctrl = require('../controllers/admin/adminReportController');

function req({ params, query, body }) { return { params: params || {}, query: query || {}, body: body || {}, flash: () => {} }; }
function res() {
  return { statusCode: 200, body: null, rendered: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    render(view, data) { this.rendered = { view, data }; return this; },
    redirect() {},
  };
}

(async () => {
  // ---------- 1. listReports — no type filter → all ----------
  console.log('\n[1] listReports without type → returns both kinds');

  mockDb.reports = [
    { id: 1, type: 'user',    status: 'PENDING', reporterId: 42, reportedId: 99 },
    { id: 2, type: 'message', status: 'PENDING', reporterId: 42, reportedId: 100, messageId: 555, chatId: 5 },
    { id: 3, type: 'user',    status: 'PENDING', reporterId: 42, reportedId: 101 },
  ];
  const r1 = res();
  await ctrl.listReports(req({ query: {} }), r1);
  eq('default returns all 3', r1.rendered?.data?.reports?.length, 3);
  ok('no type filter in where', !lastFindManyWhere?.type);

  // ---------- 2. listReports ?type=message ----------
  console.log('\n[2] listReports ?type=message → only message reports');

  const r2 = res();
  await ctrl.listReports(req({ query: { type: 'message' } }), r2);
  eq('only message',         r2.rendered?.data?.reports?.length, 1);
  eq('that one is type=message', r2.rendered?.data?.reports?.[0]?.type, 'message');
  eq('typeFilter passed to view', r2.rendered?.data?.typeFilter, 'message');

  // ---------- 3. listReports ?type=user ----------
  console.log('\n[3] listReports ?type=user → only user reports');

  const r3 = res();
  await ctrl.listReports(req({ query: { type: 'user' } }), r3);
  eq('only user reports', r3.rendered?.data?.reports?.length, 2);

  // ---------- 4. Invalid type silently ignored ----------
  console.log('\n[4] Invalid type → ignored (default behavior)');

  const r4 = res();
  await ctrl.listReports(req({ query: { type: 'garbage' } }), r4);
  eq('all 3 returned', r4.rendered?.data?.reports?.length, 3);

  // ---------- 5. deleteReportedMessage happy path ----------
  console.log('\n[5] deleteReportedMessage hard-deletes + emits + marks Resolved');

  mockDb.reports = [
    { id: 10, type: 'message', status: 'PENDING', reporterId: 42, reportedId: 100, messageId: 777, chatId: 9 },
  ];
  mockDb.messages = [{ id: 777, chatId: 9, imageUrl: 's3://x.jpg' }];
  emits.length = 0; s3Calls.length = 0;

  const r5 = res();
  await ctrl.deleteReportedMessage(req({ params: { id: '10' } }), r5);
  eq('200',                       r5.statusCode, 200);
  eq('msg deleted',               mockDb.messages.length, 0);
  eq('report status Resolved',    mockDb.reports[0]?.status, 'Resolved');
  ok('reviewedAt set',            !!mockDb.reports[0]?.reviewedAt);
  eq('messagesDeleted emit',      emits.length, 1);
  eq('emit room',                 emits[0]?.room, 'chat_9');
  eq('emit event',                emits[0]?.event, 'messagesDeleted');
  eq('emit ids',                  emits[0]?.payload?.messageIds, [777]);
  eq('s3 cleanup called',         s3Calls[0], ['s3://x.jpg']);

  // ---------- 6. Non-message report → 400 ----------
  console.log('\n[6] Non-message report → 400');

  mockDb.reports = [{ id: 11, type: 'user', status: 'PENDING', reportedId: 99 }];
  const r6 = res();
  await ctrl.deleteReportedMessage(req({ params: { id: '11' } }), r6);
  eq('400', r6.statusCode, 400);

  // ---------- 7. Report not found → 404 ----------
  console.log('\n[7] Report not found → 404');

  mockDb.reports = [];
  const r7 = res();
  await ctrl.deleteReportedMessage(req({ params: { id: '999' } }), r7);
  eq('404', r7.statusCode, 404);

  // ---------- 8. Missing messageId → 400 ----------
  console.log('\n[8] Message report with no messageId → 400');

  mockDb.reports = [{ id: 12, type: 'message', status: 'PENDING', reportedId: 99, messageId: null, chatId: 5 }];
  const r8 = res();
  await ctrl.deleteReportedMessage(req({ params: { id: '12' } }), r8);
  eq('400', r8.statusCode, 400);

  // ---------- 9. Message already deleted → still mark resolved ----------
  console.log('\n[9] Underlying message already gone → still resolve the report');

  mockDb.reports = [{ id: 13, type: 'message', status: 'PENDING', reportedId: 99, messageId: 999, chatId: 5 }];
  mockDb.messages = [];
  emits.length = 0;
  const r9 = res();
  await ctrl.deleteReportedMessage(req({ params: { id: '13' } }), r9);
  eq('200',                       r9.statusCode, 200);
  eq('report still resolved',     mockDb.reports[0]?.status, 'Resolved');
  eq('deleted array empty',       r9.body?.deleted, []);
  eq('no emit when msg absent',   emits.length, 0);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
