// controllers/leaderboardController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/* ------------------------ utils ------------------------ */
function getStartOfWeek() {
  const now = new Date();
  const day = now.getDay(); // Sun=0, Mon=1
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function getPrizeForRank(rank) {
  if (rank === 1) return '🥇 1st Prize';
  if (rank === 2) return '🥈 2nd Prize';
  if (rank === 3) return '🥉 3rd Prize';
  if (rank <= 10) return '🏅 Top 10';
  if (rank <= 50) return '🎖️ Top 50';
  return null;
}

const firstAvatar = (minimeArr) =>
  Array.isArray(minimeArr) && minimeArr.length > 0
    ? (minimeArr[0]?.avatarUrl || null)
    : null;

/** Sum(finalPoints) for a set of users this week -> Map<userId, points> */
async function getWeeklyTotalsForUsers(userIds, weekStart) {
  if (!userIds.length) return new Map();

  const rows = await prisma.pointsLedger.groupBy({
    by: ['userId'],
    where: {
      userId: { in: userIds },
      createdAt: { gte: weekStart },
    },
    _sum: { finalPoints: true },
  });

  const map = new Map();
  for (const r of rows) map.set(r.userId, r._sum.finalPoints || 0);
  return map;
}
exports.getWeeklyGlobalLeaderboard = async (req, res) => {
  try {
    const userId = req.authData.id;
    const weekStart = getStartOfWeek();

    // 1) Get top 50 userIds by weekly sum(finalPoints)
    const grouped = await prisma.pointsLedger.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: weekStart } },
      _sum: { finalPoints: true },
      orderBy: { _sum: { finalPoints: 'desc' } },
      take: 50,
    });

    const topUserIds = grouped.map(g => g.userId);

    // 2) Pull user profiles (for avatars/usernames)
    const users = topUserIds.length
      ? await prisma.user.findMany({
          where: { id: { in: topUserIds } },
          select: {
            id: true,
            username: true,
            minime: {
              where: { isSaved: true },
              orderBy: { updatedAt: 'desc' },
              take: 1,
              select: { avatarUrl: true },
            },
          },
        })
      : [];

    const userMap = new Map(users.map(u => [u.id, u]));

    // 3) Shape leaderboard in correct rank order
    const leaderboard = grouped
      .map((g, idx) => {
        const u = userMap.get(g.userId);
        const points = g._sum.finalPoints || 0;
        const rank = idx + 1;
        return {
          userId: g.userId,
          username: u?.username || `user_${g.userId}`,
          avatarUrl: firstAvatar(u?.minime) || null,   // ✅ ensure avatar always returned
          points,
          rank,
          prize: getPrizeForRank(rank),
        };
      })
      .filter(e => e.points > 0);

    // 4) My info if I’m in the top 50
    const myInfo = leaderboard.find(e => e.userId === userId) || null;

    return res.json({
      leaderboard,
      myRank: myInfo?.rank || null,
      myInfo,
      prize: myInfo?.prize || null,
    });
  } catch (error) {
    console.error('Error in getWeeklyGlobalLeaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};


/* ------------------------ Community Leaderboard ------------------------ */
/**
 * Weekly leaderboard for members of a specific community.
 * Uses pointsLedger.finalPoints; includes only users with > 0 this week.
 */
exports.getWeeklyCommunityLeaderboard = async (req, res) => {
  try {
    const requesterId = req.authData.id;
    const communityId = parseInt(req.params.communityId, 10);
    if (!Number.isFinite(communityId)) {
      return res.status(400).json({ error: 'Invalid communityId' });
    }
    const weekStart = getStartOfWeek();

    // 1) Community members (userIds)
    const members = await prisma.communityMember.findMany({
      where: { communityId },
      select: { userId: true },
    });
    const memberIds = members.map(m => m.userId);
    if (memberIds.length === 0) {
      return res.json({ leaderboard: [], myRank: null, myInfo: null, prize: null });
    }

    // 2) Sum(finalPoints) per member (only within this community)
    const grouped = await prisma.pointsLedger.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: weekStart }, userId: { in: memberIds } },
      _sum: { finalPoints: true },
      orderBy: { _sum: { finalPoints: 'desc' } },
    });

    const users = await prisma.user.findMany({
      where: { id: { in: grouped.map(g => g.userId) } },
      select: {
        id: true,
        username: true,
        minime: {
          where: { isSaved: true },
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { avatarUrl: true },
        },
      },
    });
    const userMap = new Map(users.map(u => [u.id, u]));

    // 3) Build, rank, slice (top 50)
    const raw = grouped
      .map((g) => ({
        userId: g.userId,
        username: userMap.get(g.userId)?.username || `user_${g.userId}`,
        avatarUrl: firstAvatar(userMap.get(g.userId)?.minime),
        points: g._sum.finalPoints || 0,
      }))
      .filter(u => u.points > 0)
      .sort((a, b) => b.points - a.points);

    const leaderboard = raw.slice(0, 50).map((entry, idx) => ({
      ...entry,
      rank: idx + 1,
      prize: getPrizeForRank(idx + 1),
    }));

    const myInfo = leaderboard.find(e => e.userId === requesterId) || null;

    return res.json({
      leaderboard,
      myRank: myInfo?.rank || null,
      myInfo,
      prize: myInfo?.prize || null,
    });
  } catch (error) {
    console.error('Error in getWeeklyCommunityLeaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
// controllers/leaderboardController.js

exports.getWeeklyCommunityRanks = async (req, res) => {
  try {
    const weekStart   = getStartOfWeek();
    const requesterId = req.authData.id; // ✅ whose communities are “mine”

    // 1) All communities + members (+ creator/owner)
    const communities = await prisma.community.findMany({
      select: {
        id: true,
        name: true,
        imageUrl: true,
        creatorId: true,               // ⬅️ make sure your schema has this (or rename to ownerId/createdById)
        members: { select: { userId: true } },
      },
    });

    if (communities.length === 0) {
      return res.json({
        leaderboard: [],
        myTopCreatedCommunity: null,
        myCreatedCommunities: [],
      });
    }

    // 2) Unique userIds across all communities
    const allUserIds = Array.from(
      new Set(communities.flatMap(c => c.members.map(m => m.userId)))
    );

    // 3) Weekly totals for all users
    const totalsMap = await getWeeklyTotalsForUsers(allUserIds, weekStart);

    // 4) Sum per community + member count (+ carry creatorId)
    const rows = communities.map(c => {
      const points = c.members.reduce(
        (sum, m) => sum + (totalsMap.get(m.userId) || 0),
        0
      );
      return {
        communityId: c.id,
        name: c.name,
        imageUrl: c.imageUrl || null,
        creatorId: c.creatorId || null,   // ✅ keep who created it
        points,
        membersCount: c.members.length,
      };
    });

    // 5) Rank across ALL communities (even 0 points)
    const rankedAll = [...rows]
      .sort((a, b) => b.points - a.points)
      .map((r, idx) => ({
        ...r,
        rank: idx + 1,
        prize: getPrizeForRank(idx + 1),
      }));

    // 6) Public leaderboard = only > 0 points (backward compatible)
    const leaderboard = rankedAll.filter(r => r.points > 0);

    // 7) Among MY created communities, pick the best (lowest rank number)
    const myCreatedCommunities = rankedAll
      .filter(r => r.creatorId === requesterId);

    // best = item with smallest rank (rankedAll already desc-sorted,
    // but we explicitly reduce to be clear)
    const myTopCreatedCommunity = myCreatedCommunities.length
      ? myCreatedCommunities.reduce((best, cur) => (cur.rank < best.rank ? cur : best))
      : null;

    return res.json({
      leaderboard,                // unchanged (top scorers only)
      myTopCreatedCommunity,      // ✅ best among user's created communities (can be 0 points)
      myCreatedCommunities,       // ✅ all user's created communities with rank/points
    });
  } catch (error) {
    console.error('Error in getWeeklyCommunityRanks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
