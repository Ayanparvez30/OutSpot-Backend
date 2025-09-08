// utils/weeklyPoints.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/** Monday 00:00 local (server) time; keep same behavior as your other code */
function getWeekStartMonday() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sun
  const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday-based
  const weekStart = new Date(now.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);
  return weekStart;
}

/** Batch: returns Map<userId, weeklyPoints> using pointsLedger.finalPoints */
async function getWeeklyPointsForUsers(userIds, tx = prisma) {
  if (!Array.isArray(userIds) || userIds.length === 0) return new Map();
  const weekStart = getWeekStartMonday();

  // Prisma groupBy is perfect here
  const grouped = await tx.pointsLedger.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds }, createdAt: { gte: weekStart } },
    _sum: { finalPoints: true }
  });

  const m = new Map();
  for (const row of grouped) m.set(row.userId, row._sum.finalPoints || 0);
  // ensure all requested ids exist in map
  for (const id of userIds) if (!m.has(id)) m.set(id, 0);
  return m;
}

/** Single: convenience wrapper */
async function getWeeklyPointsForUser(userId, tx = prisma) {
  const m = await getWeeklyPointsForUsers([userId], tx);
  return m.get(userId) || 0;
}

module.exports = { getWeekStartMonday, getWeeklyPointsForUsers, getWeeklyPointsForUser };
