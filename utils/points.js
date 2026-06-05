// utils/points.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const realtime = require('./realtime');

// Emit the points-changed signal ONLY for direct (already-committed) calls.
// When called inside a caller's $transaction (tx !== prisma) we must NOT emit
// here — the rows aren't committed yet, so a client refetch would read the old
// total. Those callers emit themselves AFTER their transaction commits.
function _signalPointsIfCommitted(userId, tx) {
  if (tx === prisma) {
    realtime.toUser(userId, 'user.points_changed', { userId }, { throttleMs: 1500 });
  }
}

/** tx-aware helper */
async function getUserMultiplier(userId, tx = prisma) {
  const now = new Date();
  const active = await tx.activeMultiplier.findFirst({
    where: { userId, endsAt: { gt: now } },
    orderBy: { endsAt: 'desc' },
  });
  return active ? active.factor : 1;
}

/** tx-aware points adder (no nested $transaction here) */
async function addPointsWithMultiplier(userId, basePoints, reason, refId, tx = prisma) {
  const factor = await getUserMultiplier(userId, tx);
  const base = Math.floor(basePoints);
  const finalPoints = Math.floor(base * factor);

  await tx.user.update({
    where: { id: userId },
    data: { totalPoints: { increment: finalPoints } },
  });

  await tx.pointsLedger.create({
    data: {
      userId,
      basePoints: base,
      appliedMultiplier: factor,
      finalPoints,
      reason,
      refId,
    },
  });

  _signalPointsIfCommitted(userId, tx);
  return { basePoints: base, factor, finalPoints };
}

async function addPointsDirect(userId, points, reason, refId, tx = prisma) {
  const base = Math.floor(points);
  await tx.user.update({
    where: { id: userId },
    data: { totalPoints: { increment: base } },
  });
  await tx.pointsLedger.create({
    data: {
      userId,
      basePoints: base,
      appliedMultiplier: 1,
      finalPoints: base,
      reason,
      refId,
    },
  });
  _signalPointsIfCommitted(userId, tx);
  return { basePoints: base, factor: 1, finalPoints: base };
}


module.exports = { addPointsWithMultiplier, getUserMultiplier, addPointsDirect };
