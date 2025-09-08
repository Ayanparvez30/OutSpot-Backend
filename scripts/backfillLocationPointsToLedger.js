// scripts/backfillLocationPointsToLedger.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // সপ্তাহ শুরুর টাইম (Mon 00:00)
  const now = new Date();
  const day = now.getDay(); // Sun=0
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const weekStart = new Date(now.setDate(diff));
  weekStart.setHours(0,0,0,0);

  // এই সপ্তাহের সব LocationPoint
  const lps = await prisma.locationPoint.findMany({
    where: { createdAt: { gte: weekStart } },
    orderBy: { createdAt: 'asc' }
  });

  let created = 0;
  for (const lp of lps) {
    const exists = await prisma.pointsLedger.findFirst({
      where: { userId: lp.userId, reason: 'LOCATION_UPLOAD', refId: lp.id }
    });
    if (!exists) {
      await prisma.pointsLedger.create({
        data: {
          userId: lp.userId,
          basePoints: lp.points || 5,
          appliedMultiplier: 1,
          finalPoints: lp.points || 5,
          reason: 'LOCATION_UPLOAD',
          refId: lp.id
        }
      });
      created++;
    }
  }
  console.log(`✅ Backfill done. New ledger rows: ${created}`);
}

main().finally(() => prisma.$disconnect());
