/**
 * Rigorous end-to-end test for the "disappear-on-exit" chat feature.
 *
 * Uses the REAL implementations:
 *   - utils/socket.js -> clearChatOnExit, initSocket
 *   - controllers/chatController.js -> getMessages, getMessagesPaginated, exitChat
 *
 * Proves:
 *   - NORMAL (non-disappearing) chats are NOT broken.
 *   - IMMEDIATE (disappearingSeconds === 1) per-user clear + cross-member
 *     hard-delete behaves exactly.
 *   - Real socket disconnect triggers clearChatOnExit for the active chat.
 *
 * Seeds its own users/chats/messages, then restores the DB baseline EXACTLY
 * in finally (deletes everything it created; nothing pre-existing is touched).
 *
 * Run:  node tests/disappear-on-exit.test.js
 */

const http = require('http');
const { PrismaClient } = require('@prisma/client');
const { clearChatOnExit, initSocket } = require('../utils/socket');
const chatController = require('../controllers/chatController');
const { io: ioClient } = require('socket.io-client');

const prisma = new PrismaClient();

// ---------- assertion harness ----------
const results = []; // { n, name, pass, expected, received, mode }
let curMode = 'inspection';

function record(n, name, pass, expected, received) {
  results.push({ n, name, pass: !!pass, expected, received, mode: curMode });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] (${n}) ${name}` + (pass ? '' : `  expected=${JSON.stringify(expected)} received=${JSON.stringify(received)}`));
}
function eq(n, name, received, expected) {
  record(n, name, JSON.stringify(received) === JSON.stringify(expected), expected, received);
}

// ---------- fake express res ----------
function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

// call a controller and return { status, body }
async function callCtrl(fn, req) {
  const res = makeRes();
  await fn(req, res);
  return { status: res.statusCode, body: res.body };
}

const idsOf = (arr) => (Array.isArray(arr) ? arr.map(m => m.id).sort((a, b) => a - b) : arr);

// ---------- main ----------
(async () => {
  // Baseline counts for restoration proof
  const baseline = {
    users: await prisma.user.count(),
    chats: await prisma.chat.count(),
    userOnChats: await prisma.userOnChat.count(),
    messages: await prisma.message.count(),
  };
  console.log('DB baseline:', baseline);

  let A, B, CI, CN, httpServer, clientSock;
  const createdMsgIds = [];

  // helper to seed a message with content only (no imageUrl -> S3 no-op)
  async function seedMsg(chatId, senderId, content, expiresAt = null) {
    const m = await prisma.message.create({
      data: { chatId, senderId, content, imageUrl: null, expiresAt },
    });
    createdMsgIds.push(m.id);
    return m;
  }
  const VIEW_ONCE_SENTINEL = new Date('2099-01-01T00:00:00.000Z');

  async function clearedFor(userId, chatId) {
    const r = await prisma.userOnChat.findFirst({
      where: { userId, chatId },
      select: { clearedUpToMessageId: true },
    });
    return r ? r.clearedUpToMessageId : null;
  }
  async function msgRowsExist(ids) {
    const rows = await prisma.message.findMany({ where: { id: { in: ids } }, select: { id: true } });
    return rows.map(r => r.id).sort((a, b) => a - b);
  }

  try {
    // ===== SEED =====
    const uA = await prisma.user.create({
      data: { username: `test-dispexit-A-${Date.now()}`, email: `test-dispexit-a-${Date.now()}@example.com`, password: 'x', firstName: 'Alice', lastName: 'A' },
    });
    const uB = await prisma.user.create({
      data: { username: `test-dispexit-B-${Date.now()}`, email: `test-dispexit-b-${Date.now()}@example.com`, password: 'x', firstName: 'Bob', lastName: 'B' },
    });
    A = uA.id; B = uB.id;

    // IMMEDIATE chat
    const ci = await prisma.chat.create({
      data: {
        isGroup: false, isCommunity: false, disappearingSeconds: 1,
        users: { create: [{ userId: A, role: 'MEMBER' }, { userId: B, role: 'MEMBER' }] },
      },
    });
    CI = ci.id;

    // NORMAL chat
    const cn = await prisma.chat.create({
      data: {
        isGroup: false, isCommunity: false, disappearingSeconds: null,
        users: { create: [{ userId: A, role: 'MEMBER' }, { userId: B, role: 'MEMBER' }] },
      },
    });
    CN = cn.id;

    // Seed CN: 3 normal messages (no expiry)
    const n1 = await seedMsg(CN, A, 'cn-1');
    const n2 = await seedMsg(CN, B, 'cn-2');
    const n3 = await seedMsg(CN, A, 'cn-3');

    // Seed CI: 4 immediate messages. Mirror real sendMessage which sets
    // expiresAt = VIEW_ONCE_SENTINEL for disappearingSeconds===1.
    const m1 = await seedMsg(CI, A, 'ci-1', VIEW_ONCE_SENTINEL);
    const m2 = await seedMsg(CI, B, 'ci-2', VIEW_ONCE_SENTINEL);
    const m3 = await seedMsg(CI, A, 'ci-3', VIEW_ONCE_SENTINEL);
    const m4 = await seedMsg(CI, B, 'ci-4', VIEW_ONCE_SENTINEL);

    console.log(`Seeded: A=${A} B=${B} CI=${CI} CN=${CN}`);
    console.log(`  CN msgs: ${n1.id},${n2.id},${n3.id}`);
    console.log(`  CI msgs: ${m1.id},${m2.id},${m3.id},${m4.id}`);

    const reqGet = (chatId, uid) => ({ params: { chatId: String(chatId) }, authData: { id: uid } });
    const reqPag = (chatId, uid) => ({ params: { chatId: String(chatId) }, query: { page: 1, limit: 50 }, authData: { id: uid } });

    // =========================================================
    // SECTION 1 — NORMAL chat NOT broken (FIRST pass)
    // =========================================================
    console.log('\n== NORMAL chat (first pass) ==');
    curMode = 'end-to-end';

    let r = await callCtrl(chatController.getMessages, reqGet(CN, A));
    eq(1, 'getMessages(A,CN) returns all 3', idsOf(r.body), [n1.id, n2.id, n3.id]);
    r = await callCtrl(chatController.getMessages, reqGet(CN, B));
    eq(1, 'getMessages(B,CN) returns all 3', idsOf(r.body), [n1.id, n2.id, n3.id]);

    // 2: clearChatOnExit(A,CN) is no-op
    await clearChatOnExit(A, CN);
    eq(2, 'A cleared still 0 on normal chat', await clearedFor(A, CN), 0);
    r = await callCtrl(chatController.getMessages, reqGet(CN, A));
    eq(2, 'getMessages(A,CN) still all 3 after exit', idsOf(r.body), [n1.id, n2.id, n3.id]);
    r = await callCtrl(chatController.getMessagesPaginated, reqPag(CN, A));
    eq(2, 'getMessagesPaginated(A,CN) all 3 after exit', idsOf(r.body), [n1.id, n2.id, n3.id]);

    // =========================================================
    // SECTION 2 — IMMEDIATE chat core
    // =========================================================
    console.log('\n== IMMEDIATE chat ==');

    // 3: before exit, both see all 4
    r = await callCtrl(chatController.getMessages, reqGet(CI, A));
    eq(3, 'getMessages(A,CI) all 4 before exit', idsOf(r.body), [m1.id, m2.id, m3.id, m4.id]);
    r = await callCtrl(chatController.getMessages, reqGet(CI, B));
    eq(3, 'getMessages(B,CI) all 4 before exit', idsOf(r.body), [m1.id, m2.id, m3.id, m4.id]);

    // 4: A exits
    await clearChatOnExit(A, CI);
    eq(4, 'A.cleared == latest (m4)', await clearedFor(A, CI), m4.id);
    r = await callCtrl(chatController.getMessages, reqGet(CI, A));
    eq(4, 'getMessages(A,CI) now 0', idsOf(r.body), []);

    // 5: independence — B unaffected
    r = await callCtrl(chatController.getMessages, reqGet(CI, B));
    eq(5, 'getMessages(B,CI) still all 4', idsOf(r.body), [m1.id, m2.id, m3.id, m4.id]);
    eq(5, 'B.cleared still 0', await clearedFor(B, CI), 0);

    // 6: re-entry hides old; new message m5 visible to A only-new
    r = await callCtrl(chatController.getMessages, reqGet(CI, A));
    eq(6, 'A re-opens, still 0 (old hidden)', idsOf(r.body), []);
    const m5 = await seedMsg(CI, B, 'ci-5', VIEW_ONCE_SENTINEL);
    r = await callCtrl(chatController.getMessages, reqGet(CI, A));
    eq(6, 'getMessages(A,CI) == [m5]', idsOf(r.body), [m5.id]);
    r = await callCtrl(chatController.getMessages, reqGet(CI, B));
    eq(6, 'getMessages(B,CI) all 5', idsOf(r.body), [m1.id, m2.id, m3.id, m4.id, m5.id]);

    // 7: hard-delete when all pass. B exits -> B.cleared=m5; min(A=m4,B=m5)=m4
    // => messages id <= m4 hard-deleted; id > m4 (m5) survive.
    await clearChatOnExit(B, CI);
    eq(7, 'B.cleared == m5 after exit', await clearedFor(B, CI), m5.id);
    eq(7, 'rows id<=m4 hard-deleted (m1..m4 gone)', await msgRowsExist([m1.id, m2.id, m3.id, m4.id]), []);
    eq(7, 'rows id>m4 survive (m5 present)', await msgRowsExist([m5.id]), [m5.id]);

    // 8: both exit past everything -> all CI messages gone
    // A re-opens then exits (A.cleared advances to m5). min(m5,m5)=m5 -> m5 deleted.
    await clearChatOnExit(A, CI);
    eq(8, 'A.cleared advances to m5', await clearedFor(A, CI), m5.id);
    eq(8, 'all CI message rows gone', await msgRowsExist([m1.id, m2.id, m3.id, m4.id, m5.id]), []);
    r = await callCtrl(chatController.getMessages, reqGet(CI, A));
    eq(8, 'getMessages(A,CI) == 0', idsOf(r.body), []);
    r = await callCtrl(chatController.getMessages, reqGet(CI, B));
    eq(8, 'getMessages(B,CI) == 0', idsOf(r.body), []);

    // 9: exitChat HTTP controller advances pointer.
    // Seed a fresh m6 so there's something new to clear.
    const m6 = await seedMsg(CI, A, 'ci-6', VIEW_ONCE_SENTINEL);
    // Reset A's pointer below m6 so the advance is observable... actually A.cleared=m5 < m6 already.
    const beforeExit = await clearedFor(A, CI);
    r = await callCtrl(chatController.exitChat, { params: { chatId: String(CI) }, authData: { id: A } });
    eq(9, 'exitChat returns 200', r.status, 200);
    const afterExit = await clearedFor(A, CI);
    record(9, 'exitChat advanced A pointer (>=m6)', afterExit === m6.id && afterExit > beforeExit, m6.id, afterExit);
    // m6: only A passed it; B.cleared=m5 < m6 => min=m5, but m1..m5 already deleted, so no new delete; m6 survives for B.
    eq(9, 'm6 still exists (B has not passed)', await msgRowsExist([m6.id]), [m6.id]);
    r = await callCtrl(chatController.getMessages, reqGet(CI, B));
    eq(9, 'getMessages(B,CI) == [m6]', idsOf(r.body), [m6.id]);

    // clean m6 fully so CI ends empty (B exits)
    await clearChatOnExit(B, CI);

    // 10: edge cases
    console.log('\n== Edge cases ==');
    let threw = false;
    try { await clearChatOnExit(999999999, CI); } catch (e) { threw = true; }
    record(10, 'non-member userId: no throw', !threw, false, threw);
    // B.cleared unaffected by bogus user (still m6)
    eq(10, 'non-member did not change B.cleared', await clearedFor(B, CI), m6.id);

    // zero-message chat: seed a brand-new immediate chat with no messages
    const emptyChat = await prisma.chat.create({
      data: { isGroup: false, isCommunity: false, disappearingSeconds: 1,
        users: { create: [{ userId: A, role: 'MEMBER' }, { userId: B, role: 'MEMBER' }] } },
    });
    threw = false;
    try { await clearChatOnExit(A, emptyChat.id); } catch (e) { threw = true; }
    record(10, 'zero-message chat: no throw', !threw, false, threw);
    eq(10, 'zero-message chat: A.cleared stays 0 (no-op)', await clearedFor(A, emptyChat.id), 0);

    // =========================================================
    // SECTION 1b — NORMAL chat NOT broken (LAST pass, after all
    // immediate-chat churn, to prove it was never collaterally damaged)
    // =========================================================
    console.log('\n== NORMAL chat (last pass) ==');
    curMode = 'end-to-end';
    r = await callCtrl(chatController.getMessages, reqGet(CN, A));
    eq(1, '[last] getMessages(A,CN) still all 3', idsOf(r.body), [n1.id, n2.id, n3.id]);
    r = await callCtrl(chatController.getMessages, reqGet(CN, B));
    eq(1, '[last] getMessages(B,CN) still all 3', idsOf(r.body), [n1.id, n2.id, n3.id]);
    eq(2, '[last] A.cleared(CN) still 0', await clearedFor(A, CN), 0);
    eq(2, '[last] B.cleared(CN) still 0', await clearedFor(B, CN), 0);

    // =========================================================
    // SECTION 3 — Real socket disconnect path (end-to-end)
    // =========================================================
    console.log('\n== Real socket disconnect ==');
    curMode = 'end-to-end';

    // Fresh immediate chat with a message so clearChatOnExit has work to do.
    const sockChat = await prisma.chat.create({
      data: { isGroup: false, isCommunity: false, disappearingSeconds: 1,
        users: { create: [{ userId: A, role: 'MEMBER' }, { userId: B, role: 'MEMBER' }] } },
    });
    const sm1 = await prisma.message.create({
      data: { chatId: sockChat.id, senderId: B, content: 'sock-1', imageUrl: null, expiresAt: VIEW_ONCE_SENTINEL },
    });
    createdMsgIds.push(sm1.id);

    httpServer = http.createServer();
    initSocket(httpServer);
    await new Promise((resolve) => httpServer.listen(0, resolve));
    const port = httpServer.address().port;

    let socketTestDone = false;
    await new Promise((resolve) => {
      clientSock = ioClient(`http://localhost:${port}`, {
        query: { userId: String(A) },
        transports: ['websocket'],
        forceNew: true,
      });
      clientSock.on('socket:ready', () => {
        // mark CI active via enterChat, then forcibly disconnect
        clientSock.emit('enterChat', sockChat.id);
        setTimeout(() => {
          clientSock.disconnect();
          socketTestDone = true;
          resolve();
        }, 400);
      });
      // safety timeout
      setTimeout(() => resolve(), 4000);
    });

    // wait for server-side disconnect handler to run clearChatOnExit
    let advanced = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      advanced = await clearedFor(A, sockChat.id);
      if (advanced === sm1.id) break;
    }
    record(11, 'real socket disconnect advanced A.cleared (end-to-end)',
      socketTestDone && advanced === sm1.id, sm1.id, advanced);

  } catch (err) {
    console.error('TEST CRASHED:', err);
    record(0, 'test harness crash', false, 'no crash', err.message);
  } finally {
    // ===== RESTORE BASELINE EXACTLY =====
    console.log('\n== Cleanup / restore ==');
    try { if (clientSock) clientSock.close(); } catch (_) {}
    try { if (httpServer) await new Promise(res => httpServer.close(res)); } catch (_) {}

    // Delete all seeded data. onDelete:Cascade on UserOnChat/Message via Chat & User.
    // Delete chats first (cascades userOnChat + messages), then users.
    try {
      const chatIds = [CI, CN].filter(Boolean);
      // also any extra immediate/empty/sock chats created for A&B in this run:
      // collect chats that have BOTH A and B and were created during test by name-less + our flags.
      // Safest: delete by explicit ids we tracked.
    } catch (_) {}

    // We must restore EXACTLY. Delete chats by id where users include A or B (test-only users),
    // which cascades messages + userOnChat. Then delete users A, B (cascades anything left).
    try {
      if (A || B) {
        const testChats = await prisma.chat.findMany({
          where: { users: { some: { userId: { in: [A, B].filter(Boolean) } } } },
          select: { id: true },
        });
        const ids = testChats.map(c => c.id);
        if (ids.length) {
          await prisma.message.deleteMany({ where: { chatId: { in: ids } } });
          await prisma.userOnChat.deleteMany({ where: { chatId: { in: ids } } });
          await prisma.chat.deleteMany({ where: { id: { in: ids } } });
        }
      }
      if (A) await prisma.user.delete({ where: { id: A } }).catch(() => {});
      if (B) await prisma.user.delete({ where: { id: B } }).catch(() => {});
    } catch (e) {
      console.error('Cleanup error:', e);
    }

    const after = {
      users: await prisma.user.count(),
      chats: await prisma.chat.count(),
      userOnChats: await prisma.userOnChat.count(),
      messages: await prisma.message.count(),
    };
    const restored = JSON.stringify(after) === JSON.stringify(baseline);
    console.log('DB after restore:', after);
    console.log('Baseline restored EXACTLY:', restored, restored ? '' : `(baseline=${JSON.stringify(baseline)})`);

    // ===== REPORT =====
    console.log('\n================ RESULT TABLE ================');
    const byNum = {};
    for (const x of results) {
      byNum[x.n] = byNum[x.n] || { pass: true, mode: x.mode, lines: [] };
      byNum[x.n].pass = byNum[x.n].pass && x.pass;
      byNum[x.n].lines.push(x);
    }
    for (const n of Object.keys(byNum).sort((a, b) => a - b)) {
      const g = byNum[n];
      console.log(`Test ${n}: ${g.pass ? 'PASS' : 'FAIL'} [${g.mode}]`);
      for (const l of g.lines) {
        if (!l.pass) console.log(`    - ${l.name}: expected=${JSON.stringify(l.expected)} received=${JSON.stringify(l.received)}`);
      }
    }
    const allPass = results.every(x => x.pass) && restored;
    console.log('\nOVERALL:', allPass ? 'ALL PASS + DB RESTORED' : 'SEE FAILURES ABOVE');

    await prisma.$disconnect();
    process.exit(allPass ? 0 : 1);
  }
})();
