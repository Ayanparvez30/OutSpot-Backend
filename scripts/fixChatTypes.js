// scripts/fixChatTypes.js
// One-time script to fix inconsistent chat type flags.
//
// Problem: Some community chats have isGroup=true, isCommunity=false
// Fix: Any chat with a communityId should have isCommunity=true, isGroup=false
//
// Run: node scripts/fixChatTypes.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fix() {
  console.log('Scanning for inconsistent chat types...\n');

  // 1) Community chats that are wrongly marked
  const badCommunityChats = await prisma.chat.findMany({
    where: {
      communityId: { not: null },
      OR: [
        { isCommunity: false },
        { isGroup: true },
      ],
    },
    select: { id: true, name: true, communityId: true, isGroup: true, isCommunity: true },
  });

  console.log(`Found ${badCommunityChats.length} community chats with wrong flags:`);
  for (const c of badCommunityChats) {
    console.log(`  Chat ${c.id} "${c.name}" (communityId=${c.communityId}): isGroup=${c.isGroup}, isCommunity=${c.isCommunity}`);
  }

  if (badCommunityChats.length > 0) {
    const result = await prisma.chat.updateMany({
      where: {
        communityId: { not: null },
        OR: [
          { isCommunity: false },
          { isGroup: true },
        ],
      },
      data: {
        isCommunity: true,
        isGroup: false,
      },
    });
    console.log(`  -> Fixed ${result.count} community chats\n`);
  }

  // 2) Check for duplicate community chats (same communityId, multiple chats)
  const communities = await prisma.community.findMany({
    select: { id: true, name: true },
  });

  for (const community of communities) {
    const chats = await prisma.chat.findMany({
      where: { communityId: community.id },
      select: { id: true, isCommunity: true, isGroup: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (chats.length > 1) {
      console.log(`WARNING: Community "${community.name}" (id=${community.id}) has ${chats.length} chats:`);
      for (const c of chats) {
        console.log(`  Chat ${c.id}: isCommunity=${c.isCommunity}, isGroup=${c.isGroup}, created=${c.createdAt.toISOString()}`);
      }
      console.log(`  -> Keep the oldest (Chat ${chats[0].id}), delete the rest`);

      const duplicateIds = chats.slice(1).map(c => c.id);
      await prisma.chat.deleteMany({ where: { id: { in: duplicateIds } } });
      console.log(`  -> Deleted ${duplicateIds.length} duplicate chats\n`);
    }
  }

  // 3) Summary
  const summary = await prisma.chat.groupBy({
    by: ['isGroup', 'isCommunity'],
    _count: true,
  });
  console.log('Final chat type distribution:');
  for (const row of summary) {
    const type = row.isCommunity ? 'community' : row.isGroup ? 'group' : 'personal';
    console.log(`  ${type} (isGroup=${row.isGroup}, isCommunity=${row.isCommunity}): ${row._count} chats`);
  }

  await prisma.$disconnect();
}

fix().catch(e => {
  console.error('Fix script error:', e);
  process.exit(1);
});
