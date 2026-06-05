// One-time backfill: set expiresAt on existing global-chat messages so they
// follow the 12h disappearing rule (messages sent before the feature shipped
// have expiresAt = null and would otherwise never be cleaned up).
//
// For each global message with expiresAt = null: expiresAt = createdAt + 12h.
// Messages older than 12h get a past expiresAt and will be removed on the next
// disappearing-messages cron tick. Newer ones get the correct remaining TTL.
//
// Safe: targets ONLY global chats (name startsWith "Global Chat", isCommunity
// false, communityId null) AND only rows where expiresAt is null. Idempotent —
// re-running does nothing because matched rows no longer have null expiresAt.
//
// Usage:
//   node scripts/backfill-global-chat-expiry.js          # apply
//   node scripts/backfill-global-chat-expiry.js --dry     # preview only

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TTL_MS = 12 * 60 * 60 * 1000; // 12h
const DRY = process.argv.includes('--dry');

(async () => {
  try {
    const globalChats = await prisma.chat.findMany({
      where: {
        isCommunity: false,
        communityId: null,
        name: { startsWith: 'Global Chat' },
      },
      select: { id: true, name: true },
    });
    const chatIds = globalChats.map((c) => c.id);

    if (chatIds.length === 0) {
      console.log('No global chats found. Nothing to do.');
      return;
    }
    console.log(`Global chats: ${chatIds.length}`);

    const targets = await prisma.message.findMany({
      where: { chatId: { in: chatIds }, expiresAt: null },
      select: { id: true, createdAt: true },
    });
    console.log(`Messages to backfill (expiresAt is null): ${targets.length}`);

    if (targets.length === 0) return;

    const now = Date.now();
    let pastDue = 0;
    for (const m of targets) {
      const exp = new Date(new Date(m.createdAt).getTime() + TTL_MS);
      if (exp.getTime() <= now) pastDue++;
    }
    console.log(`  -> ${pastDue} already past 12h (cron will delete next tick)`);
    console.log(`  -> ${targets.length - pastDue} still within 12h (will expire later)`);

    if (DRY) {
      console.log('\n[--dry] No changes written.');
      return;
    }

    // Update per-row so each gets its OWN createdAt + 12h (independent TTL).
    let updated = 0;
    for (const m of targets) {
      await prisma.message.update({
        where: { id: m.id },
        data: { expiresAt: new Date(new Date(m.createdAt).getTime() + TTL_MS) },
      });
      updated++;
    }
    console.log(`\nDone. Backfilled expiresAt on ${updated} global messages.`);
  } catch (e) {
    console.error('Backfill error:', e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
