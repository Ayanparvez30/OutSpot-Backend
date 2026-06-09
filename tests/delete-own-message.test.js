/**
 * Delete-own-message — item 1 of the chat-moderation baseline.
 *
 * Tests the deleteOwnMessages helper from utils/socket.js end-to-end:
 *   • own ids → deleted + messagesDeleted emitted with the exact ids
 *   • mixed own/other → only own ids deleted, others silently dropped
 *   • non-existent / wrong chat → no-op
 *   • empty / invalid payload → no-op (no throw)
 *   • imageUrl messages route through deleteS3IfOrphanBulk
 *
 * Zero HTTP, zero DB. Pure stubs.
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// Stub s3Cleanup BEFORE we load socket.js (which does `require('../utils/s3Cleanup')`
// lazily inside the handler, so the cache substitution catches it).
const s3Path = require.resolve('../utils/s3Cleanup');
const s3DeleteCalls = [];
require.cache[s3Path] = {
  id: s3Path, filename: s3Path, loaded: true,
  exports: {
    deleteS3IfOrphanBulk: async (urls) => {
      s3DeleteCalls.push(urls);
      return urls.length;
    },
  },
};

const { deleteOwnMessages } = require('../utils/socket');

// ---- Fake io recorder ----
let emitRecord = [];
const makeIO = () => ({
  to: (room) => ({
    emit: (event, payload) => emitRecord.push({ room, event, payload }),
  }),
});

// ---- Fake prisma with a controllable message table ----
function makePrisma(initialRows) {
  const rows = initialRows.slice();
  return {
    _rows: rows,
    message: {
      findMany: async ({ where, select }) => {
        const idsIn = where.id?.in;
        return rows
          .filter((r) =>
            (!idsIn || idsIn.includes(r.id)) &&
            (where.chatId === undefined || r.chatId === where.chatId) &&
            (where.senderId === undefined || r.senderId === where.senderId)
          )
          .map((r) => {
            if (!select) return { ...r };
            const out = {};
            for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
            return out;
          });
      },
      deleteMany: async ({ where }) => {
        const idsIn = where.id?.in || [];
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (idsIn.includes(rows[i].id)) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      },
    },
  };
}

(async () => {
  // ---------- 1. Own messages only — all deleted, emit fires ----------
  console.log('\n[1] All-owned ids → all deleted + messagesDeleted emitted');

  emitRecord = []; s3DeleteCalls.length = 0;
  const p1 = makePrisma([
    { id: 100, chatId: 7, senderId: 42, imageUrl: null },
    { id: 101, chatId: 7, senderId: 42, imageUrl: 's3://a.jpg' },
    { id: 102, chatId: 7, senderId: 42, imageUrl: null },
  ]);
  const r1 = await deleteOwnMessages({
    prisma: p1, io: makeIO(),
    callerId: 42, chatId: 7, messageIds: [100, 101, 102],
  });
  eq('returned ids', r1.sort((a,b)=>a-b), [100, 101, 102]);
  eq('all rows gone', p1._rows.length, 0);
  eq('emit count', emitRecord.length, 1);
  eq('emit room', emitRecord[0]?.room, 'chat_7');
  eq('emit event', emitRecord[0]?.event, 'messagesDeleted');
  eq('emit payload chatId', emitRecord[0]?.payload?.chatId, 7);
  eq('emit payload ids', emitRecord[0]?.payload?.messageIds.sort((a,b)=>a-b), [100, 101, 102]);
  eq('s3 cleanup called for image-bearing msg', s3DeleteCalls[0], ['s3://a.jpg']);

  // ---------- 2. Mixed own/other — only own deleted, silent on others ----------
  console.log('\n[2] Mixed own + other ids — only own deleted, others ignored');

  emitRecord = []; s3DeleteCalls.length = 0;
  const p2 = makePrisma([
    { id: 200, chatId: 5, senderId: 42, imageUrl: null }, // own
    { id: 201, chatId: 5, senderId: 99, imageUrl: null }, // someone else's
    { id: 202, chatId: 5, senderId: 42, imageUrl: null }, // own
  ]);
  const r2 = await deleteOwnMessages({
    prisma: p2, io: makeIO(),
    callerId: 42, chatId: 5, messageIds: [200, 201, 202],
  });
  eq('returned only own ids', r2.sort((a,b)=>a-b), [200, 202]);
  ok('other-user msg preserved', !!p2._rows.find((r) => r.id === 201));
  eq('emit only includes own ids', emitRecord[0]?.payload?.messageIds.sort((a,b)=>a-b), [200, 202]);

  // ---------- 3. Wrong chatId for owned msg — no-op ----------
  console.log('\n[3] Wrong chatId for the listed ids → no delete, no emit');

  emitRecord = [];
  const p3 = makePrisma([
    { id: 300, chatId: 5, senderId: 42, imageUrl: null },
  ]);
  const r3 = await deleteOwnMessages({
    prisma: p3, io: makeIO(),
    callerId: 42, chatId: 999, messageIds: [300], // chat mismatch
  });
  eq('returned empty', r3, []);
  eq('row preserved', p3._rows.length, 1);
  eq('no emit', emitRecord.length, 0);

  // ---------- 4. Empty / invalid payload — no-op, no throw ----------
  console.log('\n[4] Empty / invalid payload → no-op');

  emitRecord = [];
  eq('empty array',     await deleteOwnMessages({ prisma: makePrisma([]), io: makeIO(), callerId: 42, chatId: 5, messageIds: [] }), []);
  eq('null messageIds', await deleteOwnMessages({ prisma: makePrisma([]), io: makeIO(), callerId: 42, chatId: 5, messageIds: null }), []);
  eq('missing chatId',  await deleteOwnMessages({ prisma: makePrisma([]), io: makeIO(), callerId: 42, chatId: null, messageIds: [1, 2] }), []);
  eq('missing callerId',await deleteOwnMessages({ prisma: makePrisma([]), io: makeIO(), callerId: null, chatId: 5, messageIds: [1, 2] }), []);
  eq('garbage ids',     await deleteOwnMessages({ prisma: makePrisma([]), io: makeIO(), callerId: 42, chatId: 5, messageIds: ['x', null, -3, 0] }), []);
  eq('no emit on no-ops', emitRecord.length, 0);

  // ---------- 5. Cap at 100 ids ----------
  console.log('\n[5] Cap at 100 ids per call');

  emitRecord = []; s3DeleteCalls.length = 0;
  const big = Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, chatId: 1, senderId: 42, imageUrl: null }));
  const p5 = makePrisma(big);
  const r5 = await deleteOwnMessages({
    prisma: p5, io: makeIO(),
    callerId: 42, chatId: 1,
    messageIds: big.map((m) => m.id), // 150 ids
  });
  eq('at most 100 deleted', r5.length, 100);
  eq('50 rows remain',      p5._rows.length, 50);

  // ---------- 6. Stranger trying to delete someone else's message ----------
  console.log('\n[6] Stranger CANNOT delete another user\'s message');

  emitRecord = [];
  const p6 = makePrisma([{ id: 600, chatId: 5, senderId: 99, imageUrl: null }]);
  const r6 = await deleteOwnMessages({
    prisma: p6, io: makeIO(),
    callerId: 42, chatId: 5, messageIds: [600],
  });
  eq('no delete', r6, []);
  eq('row intact', p6._rows.length, 1);
  eq('no emit',   emitRecord.length, 0);

  // ---------- 7. No imageUrl → no S3 call ----------
  console.log('\n[7] Text-only message → no S3 cleanup attempt');

  s3DeleteCalls.length = 0;
  const p7 = makePrisma([{ id: 700, chatId: 1, senderId: 42, imageUrl: null }]);
  await deleteOwnMessages({
    prisma: p7, io: makeIO(),
    callerId: 42, chatId: 1, messageIds: [700],
  });
  eq('s3 not called for text-only', s3DeleteCalls.length, 0);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => {
  console.error('TEST CRASH', err);
  process.exit(1);
});
