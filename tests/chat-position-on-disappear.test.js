/**
 * chat-position-on-disappear.test.js
 *
 * Verifies that deleting or hiding a chat's latest message does NOT change
 * that chat's position in the chat list for either participant.
 *
 * The fix: getMyChats sorts by _sortTime = max(latestMessage.createdAt,
 * chat.updatedAt, joinedAt). Because chat.updatedAt is bumped on every SEND
 * (and NOT touched by message deletion), deleting messages must leave
 * lastActivityAt unchanged and the chat must keep its list position.
 *
 * Setup
 * -----
 *   T   = T0 (oldest)
 *   T+1 = T0 + 60s
 *   T+2 = T0 + 120s (newest)
 *
 *   Chat D  (U1+U3 second)   updatedAt = T   → oldest for U1
 *   Chat A  (U1+U2)          updatedAt = T+1 → middle for U1
 *   Chat C  (U1+U3 first)    updatedAt = T+2 → newest for U1
 *
 *   For U2:
 *   Chat B  (U2+U3)          updatedAt = A.updatedAt + 30s → just above A for U2
 *
 * Assertions (numbered to match spec)
 * ------------------------------------
 *   1. BEFORE: U1 order = [C, A, D];  each item has lastActivityAt
 *   2. DISAPPEAR: prisma.message.deleteMany for chat A
 *   3. AFTER:  U1 order = [C, A, D];  A.latestMessage=null, A.lastActivityAt unchanged
 *   4. RECEIVER (U2): before [B, A, ...]; after A still below B, lastActivityAt unchanged
 *   5. DISAPPEAR-ON-EXIT: U2's clearedUpToMessageId = last msg id in A → A.latestMessage
 *      null but A.lastActivityAt still = A.updatedAt for U2
 *   6. SANITY: send fresh message in D → D.updatedAt bumps to now → U1 order [D, C, A]
 *
 * Uses REAL getMyChats / sendTextMessage against the live DB.
 * Restores baseline in finally (deletes every row created here).
 *
 * Run:  node tests/chat-position-on-disappear.test.js
 */

'use strict';

const { PrismaClient } = require('@prisma/client');
const chatCtrl = require('../controllers/chatController');

const prisma = new PrismaClient();

// ── assertion harness ──────────────────────────────────────────────────────────
const results = [];
function record(n, name, pass, expected, received) {
  results.push({ n, name, pass: !!pass, expected, received });
  const tag = pass ? 'PASS' : 'FAIL';
  const detail = pass ? '' : `\n    expected = ${JSON.stringify(expected)}\n    received = ${JSON.stringify(received)}`;
  console.log(`  [${tag}] (${n}) ${name}${detail}`);
}
function eq(n, name, received, expected) {
  record(n, name, JSON.stringify(received) === JSON.stringify(expected), expected, received);
}
function ok(n, name, cond, note = '') {
  record(n, name, !!cond, true, !!cond, note);
}

// ── fake express helpers ───────────────────────────────────────────────────────
function makeReq(userId, body = {}) {
  return { authData: { id: userId }, body, params: {} };
}
function makeRes() {
  const r = { statusCode: 200, body: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json   = (b) => { r.body = b; return r; };
  return r;
}
async function callCtrl(fn, userId, body = {}) {
  const res = makeRes();
  await fn(makeReq(userId, body), res);
  return { status: res.statusCode, body: res.body };
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  // ── baseline snapshot ─────────────────────────────────────────────────────
  const baseline = {
    users:      await prisma.user.count(),
    chats:      await prisma.chat.count(),
    userOnChat: await prisma.userOnChat.count(),
    messages:   await prisma.message.count(),
  };
  console.log('\nDB baseline:', baseline);

  // track everything we create
  const createdUserIds   = [];
  const createdChatIds   = [];
  const createdMsgIds    = [];

  // time anchors
  const T0   = new Date('2026-01-01T00:00:00.000Z');
  const T1   = new Date('2026-01-01T00:01:00.000Z'); // T0 + 1 min  (A)
  const T1B  = new Date('2026-01-01T00:01:30.000Z'); // T0 + 1.5 min (B — just above A for U2)
  const T2   = new Date('2026-01-01T00:02:00.000Z'); // T0 + 2 min  (C)

  try {
    // ── seed users ─────────────────────────────────────────────────────────
    const [U1, U2, U3] = await Promise.all([
      prisma.user.create({ data: { username: 'chatpos-u1', email: 'test-chatpos-u1@example.com', password: 'x' } }),
      prisma.user.create({ data: { username: 'chatpos-u2', email: 'test-chatpos-u2@example.com', password: 'x' } }),
      prisma.user.create({ data: { username: 'chatpos-u3', email: 'test-chatpos-u3@example.com', password: 'x' } }),
    ]);
    createdUserIds.push(U1.id, U2.id, U3.id);
    console.log(`\nSeeded users: U1=${U1.id}  U2=${U2.id}  U3=${U3.id}`);

    // ── seed chats (bare creation; updatedAt set explicitly below) ─────────
    // Chat D: U1 + U3 (second)  → updatedAt = T0 (oldest)
    const chatD = await prisma.chat.create({
      data: {
        users: { create: [
          { userId: U1.id, role: 'MEMBER', joinedAt: T0 },
          { userId: U3.id, role: 'MEMBER', joinedAt: T0 },
        ]},
      },
    });
    // Chat A: U1 + U2           → updatedAt = T1 (middle)
    const chatA = await prisma.chat.create({
      data: {
        users: { create: [
          { userId: U1.id, role: 'MEMBER', joinedAt: T1 },
          { userId: U2.id, role: 'MEMBER', joinedAt: T1 },
        ]},
      },
    });
    // Chat C: U1 + U3 (first)   → updatedAt = T2 (newest)
    const chatC = await prisma.chat.create({
      data: {
        users: { create: [
          { userId: U1.id, role: 'MEMBER', joinedAt: T2 },
          { userId: U3.id, role: 'MEMBER', joinedAt: T2 },
        ]},
      },
    });
    // Chat B: U2 + U3            → updatedAt = T1B (between T1 and T2 — above A, below C for U2)
    const chatB = await prisma.chat.create({
      data: {
        users: { create: [
          { userId: U2.id, role: 'MEMBER', joinedAt: T1B },
          { userId: U3.id, role: 'MEMBER', joinedAt: T1B },
        ]},
      },
    });
    createdChatIds.push(chatD.id, chatA.id, chatC.id, chatB.id);
    console.log(`Seeded chats: D=${chatD.id}  A=${chatA.id}  C=${chatC.id}  B=${chatB.id}`);

    // ── force exact updatedAt via raw update ───────────────────────────────
    // Prisma @updatedAt auto-stamps on update; we override with executeRaw.
    await prisma.$executeRaw`UPDATE \`Chat\` SET \`updatedAt\` = ${T0} WHERE \`id\` = ${chatD.id}`;
    await prisma.$executeRaw`UPDATE \`Chat\` SET \`updatedAt\` = ${T1} WHERE \`id\` = ${chatA.id}`;
    await prisma.$executeRaw`UPDATE \`Chat\` SET \`updatedAt\` = ${T2} WHERE \`id\` = ${chatC.id}`;
    await prisma.$executeRaw`UPDATE \`Chat\` SET \`updatedAt\` = ${T1B} WHERE \`id\` = ${chatB.id}`;

    // ── seed one message per chat (createdAt ≈ chat.updatedAt) ────────────
    const msgInD = await prisma.message.create({ data: { chatId: chatD.id, senderId: U3.id, content: 'D msg', createdAt: T0 } });
    const msgInA = await prisma.message.create({ data: { chatId: chatA.id, senderId: U2.id, content: 'A msg', createdAt: T1 } });
    const msgInC = await prisma.message.create({ data: { chatId: chatC.id, senderId: U3.id, content: 'C msg', createdAt: T2 } });
    const msgInB = await prisma.message.create({ data: { chatId: chatB.id, senderId: U3.id, content: 'B msg', createdAt: T1B } });
    createdMsgIds.push(msgInD.id, msgInA.id, msgInC.id, msgInB.id);
    console.log(`Seeded messages: D_msg=${msgInD.id}  A_msg=${msgInA.id}  C_msg=${msgInC.id}  B_msg=${msgInB.id}`);

    // ── helper: get ordered chat ids from getMyChats ───────────────────────
    async function getChatOrder(userId, filterIds) {
      const { status, body } = await callCtrl(chatCtrl.getMyChats, userId);
      if (status !== 200 || !Array.isArray(body)) throw new Error(`getMyChats(${userId}) status=${status} body=${JSON.stringify(body)}`);
      // filter to only our seeded chats so pre-existing chats don't interfere
      return body.filter(c => filterIds.includes(c.id));
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // ASSERTION 1 — BEFORE: U1 order = [C, A, D]; lastActivityAt present
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n── ASSERTION 1: BEFORE disappear (U1) ──');
    const u1BeforeChats = await getChatOrder(U1.id, [chatC.id, chatA.id, chatD.id]);
    const u1BeforeIds = u1BeforeChats.map(c => c.id);
    eq(1, 'BEFORE: U1 has exactly 3 seeded chats', u1BeforeChats.length, 3);
    eq(1, 'BEFORE: U1 order = [C, A, D]', u1BeforeIds, [chatC.id, chatA.id, chatD.id]);

    ok(1, 'BEFORE: C has lastActivityAt', typeof u1BeforeChats[0]?.lastActivityAt === 'string');
    ok(1, 'BEFORE: A has lastActivityAt', typeof u1BeforeChats[1]?.lastActivityAt === 'string');
    ok(1, 'BEFORE: D has lastActivityAt', typeof u1BeforeChats[2]?.lastActivityAt === 'string');
    ok(1, 'BEFORE: A has latestMessage (not null)', u1BeforeChats[1]?.latestMessage !== null);

    // capture A's lastActivityAt for later comparison
    const u1_A_lastActivityBefore = u1BeforeChats.find(c => c.id === chatA.id)?.lastActivityAt;
    console.log(`    A.lastActivityAt before = ${u1_A_lastActivityBefore}`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // U2 BEFORE check (for assertion 4 baseline)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n── U2 BEFORE check (for assertion 4 baseline) ──');
    const u2BeforeChats = await getChatOrder(U2.id, [chatB.id, chatA.id]);
    const u2BeforeIds = u2BeforeChats.map(c => c.id);
    eq('4-pre', 'BEFORE: U2 order = [B, A]', u2BeforeIds, [chatB.id, chatA.id]);
    const u2_A_lastActivityBefore = u2BeforeChats.find(c => c.id === chatA.id)?.lastActivityAt;
    console.log(`    U2 A.lastActivityAt before = ${u2_A_lastActivityBefore}`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // ASSERTION 2 — DISAPPEAR: delete A's message(s) (simulate cron)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n── ASSERTION 2: DISAPPEAR A messages (cron simulate) ──');
    const deleteResult = await prisma.message.deleteMany({ where: { chatId: chatA.id } });
    console.log(`    Deleted ${deleteResult.count} message(s) from chat A (${chatA.id}). chat.updatedAt NOT touched.`);
    // Note: msgInA is now gone from DB; remove from tracking so finally cleanup won't double-delete
    const aIdx = createdMsgIds.indexOf(msgInA.id);
    if (aIdx !== -1) createdMsgIds.splice(aIdx, 1);
    ok(2, `Deleted ${deleteResult.count} message(s) from chat A`, deleteResult.count >= 1);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // ASSERTION 3 — AFTER: U1 order still [C, A, D]; A.latestMessage=null;
    //               A.lastActivityAt unchanged
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n── ASSERTION 3: AFTER disappear (U1) ──');
    const u1AfterChats = await getChatOrder(U1.id, [chatC.id, chatA.id, chatD.id]);
    const u1AfterIds = u1AfterChats.map(c => c.id);
    const u1_A_after = u1AfterChats.find(c => c.id === chatA.id);

    eq(3, 'AFTER: U1 order still = [C, A, D]', u1AfterIds, [chatC.id, chatA.id, chatD.id]);
    ok(3, 'AFTER: A did NOT sink below D (A still in middle)', u1AfterIds.indexOf(chatA.id) < u1AfterIds.indexOf(chatD.id));
    ok(3, 'AFTER: A.latestMessage is null', u1_A_after?.latestMessage === null,
      `got ${JSON.stringify(u1_A_after?.latestMessage)}`);
    eq(3, 'AFTER: A.lastActivityAt unchanged from before',
      u1_A_after?.lastActivityAt, u1_A_lastActivityBefore);

    // Confirm A.lastActivityAt ≈ chat A's updatedAt (T1)
    const aLastActivity = new Date(u1_A_after?.lastActivityAt).getTime();
    const aUpdatedAt    = T1.getTime();
    ok(3, 'AFTER: A.lastActivityAt equals chat.updatedAt (T1)', aLastActivity === aUpdatedAt,
      `lastActivityAt=${u1_A_after?.lastActivityAt}  T1=${T1.toISOString()}`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // ASSERTION 4 — RECEIVER (U2): A keeps its position for U2 too
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n── ASSERTION 4: RECEIVER (U2) ──');
    const u2AfterChats = await getChatOrder(U2.id, [chatB.id, chatA.id]);
    const u2AfterIds   = u2AfterChats.map(c => c.id);
    const u2_A_after   = u2AfterChats.find(c => c.id === chatA.id);

    eq(4, 'AFTER: U2 order still = [B, A]', u2AfterIds, [chatB.id, chatA.id]);
    ok(4, 'AFTER: A.latestMessage null for U2', u2_A_after?.latestMessage === null,
      `got ${JSON.stringify(u2_A_after?.latestMessage)}`);
    eq(4, 'AFTER: U2 A.lastActivityAt unchanged', u2_A_after?.lastActivityAt, u2_A_lastActivityBefore);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // ASSERTION 5 — DISAPPEAR-ON-EXIT: U2 clearedUpToMessageId
    //   Restore a message in A first, then simulate U2 clearing it.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n── ASSERTION 5: DISAPPEAR-ON-EXIT (U2 cleared) ──');
    // Re-seed a message in A to give something to clear
    const msgInA2 = await prisma.message.create({
      data: { chatId: chatA.id, senderId: U2.id, content: 'A msg2', createdAt: T1 },
    });
    createdMsgIds.push(msgInA2.id);

    // Set U2's clearedUpToMessageId = msgInA2.id (simulate disappear-on-exit clear)
    await prisma.userOnChat.updateMany({
      where: { userId: U2.id, chatId: chatA.id },
      data: { clearedUpToMessageId: msgInA2.id },
    });

    const u2ExitChats = await getChatOrder(U2.id, [chatB.id, chatA.id]);
    const u2ExitIds   = u2ExitChats.map(c => c.id);
    const u2_A_exit   = u2ExitChats.find(c => c.id === chatA.id);

    eq(5, 'EXIT: U2 order still = [B, A]', u2ExitIds, [chatB.id, chatA.id]);
    ok(5, 'EXIT: A.latestMessage null (cleared by clearedUpToMessageId)',
      u2_A_exit?.latestMessage === null,
      `got ${JSON.stringify(u2_A_exit?.latestMessage)}`);
    // lastActivityAt must still be chat A's updatedAt (T1), NOT joinedAt
    const exitLastActivity = new Date(u2_A_exit?.lastActivityAt).getTime();
    ok(5, 'EXIT: A.lastActivityAt still = chat.updatedAt (T1), not joinedAt',
      exitLastActivity === T1.getTime(),
      `lastActivityAt=${u2_A_exit?.lastActivityAt}  T1=${T1.toISOString()}`);

    // Cleanup: reset clearedUpToMessageId for U2 (for clean teardown)
    await prisma.userOnChat.updateMany({
      where: { userId: U2.id, chatId: chatA.id },
      data: { clearedUpToMessageId: 0 },
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // ASSERTION 6 — SANITY: send new message in D → D jumps to top for U1
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n── ASSERTION 6: SANITY send in D → D jumps to top ──');
    // Use REAL sendTextMessage (U1 sends in D)
    const sendRes = await callCtrl(chatCtrl.sendTextMessage, U1.id, {
      chatId: String(chatD.id),
      content: 'fresh message in D',
    });
    console.log(`    sendTextMessage status=${sendRes.status} msg_id=${sendRes.body?.id}`);
    // sendTextMessage does not call res.status() explicitly — it always returns
    // 200 (default) on success and 500 on error. Socket errors are caught
    // internally and do not affect the HTTP response.
    ok(6, 'sendTextMessage returned 200 (success)', sendRes.status === 200,
      `got status=${sendRes.status} body=${JSON.stringify(sendRes.body)}`);

    if (sendRes.body?.id) createdMsgIds.push(sendRes.body.id);

    // Allow D.updatedAt to propagate (sendTextMessage does chat.update internally)
    // No sleep needed — it's synchronous DB writes already done.
    const u1SanityChats = await getChatOrder(U1.id, [chatC.id, chatA.id, chatD.id]);
    const u1SanityIds = u1SanityChats.map(c => c.id);

    eq(6, 'SANITY: U1 order after D send = [D, C, A]', u1SanityIds,
      [chatD.id, chatC.id, chatA.id]);
    ok(6, 'SANITY: D.latestMessage is not null', u1SanityChats[0]?.latestMessage !== null);

  } finally {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // RESTORE DB BASELINE EXACTLY
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('\n── DB CLEANUP ──');
    try {
      // messages first (FK → chat, user)
      if (createdMsgIds.length) {
        const delMsgs = await prisma.message.deleteMany({ where: { id: { in: createdMsgIds } } });
        console.log(`  Deleted ${delMsgs.count} message(s)`);
      }
      // userOnChat rows (FK → chat, user); cascades if chat deleted first, but do explicitly
      if (createdChatIds.length) {
        const delUOC = await prisma.userOnChat.deleteMany({ where: { chatId: { in: createdChatIds } } });
        console.log(`  Deleted ${delUOC.count} userOnChat row(s)`);
        const delChats = await prisma.chat.deleteMany({ where: { id: { in: createdChatIds } } });
        console.log(`  Deleted ${delChats.count} chat(s)`);
      }
      if (createdUserIds.length) {
        const delUsers = await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
        console.log(`  Deleted ${delUsers.count} user(s)`);
      }

      // verify restoration
      const after = {
        users:      await prisma.user.count(),
        chats:      await prisma.chat.count(),
        userOnChat: await prisma.userOnChat.count(),
        messages:   await prisma.message.count(),
      };
      const restored = JSON.stringify(after) === JSON.stringify(baseline);
      console.log(`  DB after cleanup: ${JSON.stringify(after)}`);
      console.log(`  Baseline match: ${restored ? 'YES' : 'NO (diff found)'}`);
      if (!restored) {
        console.log('  baseline:', JSON.stringify(baseline));
        console.log('  after:   ', JSON.stringify(after));
      }
    } catch (cleanupErr) {
      console.error('  CLEANUP ERROR:', cleanupErr.message);
    }
    await prisma.$disconnect();
  }

  // ── print summary ──────────────────────────────────────────────────────────
  const passed  = results.filter(r => r.pass).length;
  const failed  = results.filter(r => !r.pass).length;
  const total   = results.length;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  RESULTS: ${passed}/${total} passed   ${failed} failed`);
  console.log('╠══════════════════════════════════════════════════════════════╣');

  // pass/fail table
  const colN    = 4;
  const colPass = 5;
  const colName = 55;
  console.log(`║  ${'#'.padEnd(colN)} ${'PASS?'.padEnd(colPass)} ${'Test name'.padEnd(colName)} ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  for (const r of results) {
    const n    = String(r.n).padEnd(colN);
    const pass = (r.pass ? 'PASS' : 'FAIL').padEnd(colPass);
    const name = r.name.length > colName ? r.name.slice(0, colName - 1) + '…' : r.name.padEnd(colName);
    const detail = r.pass ? '' : `\n║    expected=${JSON.stringify(r.expected)}  received=${JSON.stringify(r.received)}`;
    console.log(`║  ${n} ${pass} ${name} ║${detail}`);
  }
  console.log('╚══════════════════════════════════════════════════════════════╝');

  console.log('\nDisappear changes position for SENDER (U1):  ' + (results.find(r => r.n === 3 && r.name.includes('order still'))?.pass ? 'NO (fixed)' : 'YES (BUG)'));
  console.log('Disappear changes position for RECEIVER (U2): ' + (results.find(r => r.n === 4 && r.name.includes('order still'))?.pass ? 'NO (fixed)' : 'YES (BUG)'));

  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('\nTEST CRASH:', err);
  process.exit(1);
});
