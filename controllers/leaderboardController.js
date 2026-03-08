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
// from a given weekStart (Mon 00:00 local), compute weekEnd and a nice label
function getWeekEndAndLabel(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7); // next Monday 00:00
  const fmt = (d) => d.toISOString().slice(0, 10);
  const label = `${fmt(weekStart)} → ${fmt(weekEnd)}`;
  return { weekEnd, label };
}

// helper: format remaining time like "4d 11h"
function getTimeRemainingString(weekEnd) {
  const now = new Date();
  const diffMs = weekEnd.getTime() - now.getTime();
  if (diffMs <= 0) return '0d 0h';
  const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(diffHrs / 24);
  const hours = diffHrs % 24;
  return `${days}d ${hours}h`;
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
/** Sum(finalPoints) for a set of users within [weekStart, weekEnd) -> Map<userId, points> */
async function getWeeklyTotalsForUsers(userIds, weekStart, weekEnd) {
  if (!userIds.length) return new Map();

  const where = weekEnd
    ? { userId: { in: userIds }, createdAt: { gte: weekStart, lt: weekEnd } }
    : { userId: { in: userIds }, createdAt: { gte: weekStart } };

  const rows = await prisma.pointsLedger.groupBy({
    by: ['userId'],
    where,
    _sum: { finalPoints: true },
  });

  const map = new Map();
  for (const r of rows) map.set(r.userId, r._sum.finalPoints || 0);
  return map;
}
exports.getWeeklyGlobalLeaderboard = async (req, res) => {
  try {
    const requesterId = req.authData.id;
    const weekStart = getStartOfWeek();
    const { weekEnd, label } = getWeekEndAndLabel(weekStart);

    // 1) This week points grouped (only users who earned >0 appear here after filtering)
    const grouped = await prisma.pointsLedger.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: weekStart, lt: weekEnd } },
      _sum: { finalPoints: true },
      orderBy: { _sum: { finalPoints: 'desc' } },
    });

    // 2) Collect userIds we need profiles for (everyone on the board + requester)
    const onBoardUserIds = grouped.map(g => g.userId);
    const needUserIds = Array.from(new Set([...onBoardUserIds, requesterId]));

    // 3) Pull minimal profile (username + latest saved avatar)
    const users = needUserIds.length
      ? await prisma.user.findMany({
          where: { id: { in: needUserIds } },
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
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

    const firstAvatar = (minimeArr) =>
      Array.isArray(minimeArr) && minimeArr.length > 0
        ? (minimeArr[0]?.avatarUrl || null)
        : null;

    const buildFullName = (u) =>
      [u?.firstName, u?.lastName].filter(Boolean).join(' ') || null;

    // 4) Build full leaderboard for users with >0 points
    const positiveRows = grouped
      .map(g => {
        const u = userMap.get(g.userId);
        return {
          userId: g.userId,
          username: u?.username || `user_${g.userId}`,
          fullName: buildFullName(u),
          firstName: u?.firstName || null,
          lastName: u?.lastName || null,
          avatarUrl: firstAvatar(u?.minime) || null,
          points: Number(g._sum.finalPoints || 0),
        };
      })
      .filter(r => r.points > 0)
      .sort((a, b) => b.points - a.points);

    const leaderboard = positiveRows.map((entry, idx) => ({
      ...entry,
      rank: idx + 1,
      prize: getPrizeForRank(idx + 1),
    }));

    // 5) Ensure requester shows up even with 0 points
    const requesterOnBoard = leaderboard.find(e => e.userId === requesterId);
    let myInfo = requesterOnBoard || null;
    let myRank = requesterOnBoard?.rank || null;

    if (!myInfo) {
      // compute requester weekly total (may be 0)
      const mySum = await prisma.pointsLedger.aggregate({
        _sum: { finalPoints: true },
        where: { userId: requesterId, createdAt: { gte: weekStart, lt: weekEnd } },
      });
      const myPoints = Number(mySum._sum.finalPoints || 0);

      const me = userMap.get(requesterId);
      const meUsername = me?.username || `user_${requesterId}`;
      const meAvatar = firstAvatar(me?.minime) || null;
      const meFullName = buildFullName(me);

      // Place requester after all positive scorers (as "next rank") when points == 0
      // If everyone has 0 (i.e., leaderboard empty), requester gets rank 1 with 0 points.
      const tailRank = leaderboard.length + 1;
      myInfo = {
        userId: requesterId,
        username: meUsername,
        fullName: meFullName,
        firstName: me?.firstName || null,
        lastName: me?.lastName || null,
        avatarUrl: meAvatar,
        points: myPoints, // likely 0
        rank: myPoints > 0 ? null : (leaderboard.length === 0 ? 1 : tailRank),
        prize: null,
      };
      myRank = myInfo.rank;
      // Note: we are not inserting requester into `leaderboard` to keep it “positive-only”.
      // Client still gets `myInfo`/`myRank` for the sticky “My Position” UI.
    }

    return res.json({
      window: {
        weekStart: weekStart.toISOString(),
        weekEnd: weekEnd.toISOString(),
        label,
        remaining: getTimeRemainingString(weekEnd),
      },
      leaderboard,   // only >0 points to keep board clean
      myRank,        // requester rank; 1 if no one scored and requester has 0
      myInfo,        // requester card always present
      prize: myInfo?.prize || null,
    });
  } catch (error) {
    console.error('Error in getWeeklyGlobalLeaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};



exports.getWeeklyCommunityLeaderboard = async (req, res) => {
  try {
    const requesterId = req.authData.id;
    const communityId = parseInt(req.params.communityId, 10);
    if (!Number.isFinite(communityId)) {
      return res.status(400).json({ error: 'Invalid communityId' });
    }
    const weekStart = getStartOfWeek();
    const { weekEnd, label } = getWeekEndAndLabel(weekStart); // ✅

    const members = await prisma.communityMember.findMany({
      where: { communityId },
      select: { userId: true },
    });
    const memberIds = members.map(m => m.userId);
    if (memberIds.length === 0) {
      return res.json({
        window: {
          weekStart: weekStart.toISOString(),
          weekEnd: weekEnd.toISOString(),
          label,
          remaining: getTimeRemainingString(weekEnd),
        },
        leaderboard: [],
        myRank: null,
        myInfo: null,
        prize: null,
      });
    }

    const grouped = await prisma.pointsLedger.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: weekStart, lt: weekEnd }, userId: { in: memberIds } }, // ✅
      _sum: { finalPoints: true },
      orderBy: { _sum: { finalPoints: 'desc' } },
    });

    const users = await prisma.user.findMany({
      where: { id: { in: grouped.map(g => g.userId) } },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        minime: {
          where: { isSaved: true },
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { avatarUrl: true },
        },
      },
    });
    const userMap = new Map(users.map(u => [u.id, u]));

    const raw = grouped
      .map(g => {
        const u = userMap.get(g.userId);
        return {
          userId: g.userId,
          username: u?.username || `user_${g.userId}`,
          fullName: [u?.firstName, u?.lastName].filter(Boolean).join(' ') || null,
          firstName: u?.firstName || null,
          lastName: u?.lastName || null,
          avatarUrl: firstAvatar(u?.minime) || null,
          points: g._sum.finalPoints || 0,
        };
      })
      .filter(u => u.points > 0)
      .sort((a, b) => b.points - a.points);

    const leaderboard = raw.slice(0, 50).map((entry, idx) => ({
      ...entry,
      rank: idx + 1,
      prize: getPrizeForRank(idx + 1),
    }));

    const myInfo = leaderboard.find(e => e.userId === requesterId) || null;

    return res.json({
      window: {
        weekStart: weekStart.toISOString(),
        weekEnd: weekEnd.toISOString(),
        label,
        remaining: getTimeRemainingString(weekEnd),
      },
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
exports.getWeeklyCommunityRanks = async (req, res) => {
  try {
    const weekStart   = getStartOfWeek();
    const requesterId = req.authData.id;

    // all communities with members and creator
    const communities = await prisma.community.findMany({
      select: {
        id: true,
        name: true,
        imageUrl: true,
        creatorId: true,
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

    // gather unique userIds across all communities
    const allUserIds = Array.from(
      new Set(communities.flatMap(c => c.members.map(m => m.userId)))
    );

    // build a totals map for this week WITHOUT changing your helper signature
    const totalsArr = allUserIds.length
      ? await prisma.pointsLedger.groupBy({
          by: ['userId'],
          where: { userId: { in: allUserIds }, createdAt: { gte: weekStart } },
          _sum: { finalPoints: true },
        })
      : [];

    const totalsMap = new Map(
      totalsArr.map(r => [r.userId, Number(r._sum.finalPoints || 0)])
    );

    // sum per community
    const rows = communities.map(c => {
      const points = c.members.reduce(
        (sum, m) => sum + (totalsMap.get(m.userId) || 0),
        0
      );
      return {
        communityId: c.id,
        name: c.name,
        imageUrl: c.imageUrl || null,
        creatorId: c.creatorId || null,
        points,
        membersCount: c.members.length,
      };
    });

    // rank across all communities
    const rankedAll = [...rows]
      .sort((a, b) => b.points - a.points)
      .map((r, idx) => ({
        ...r,
        rank: idx + 1,
        prize: getPrizeForRank(idx + 1),
      }));

    // public leaderboard (>0 points)
    const leaderboard = rankedAll.filter(r => r.points > 0);

    // my created communities + pick best rank
    const myCreatedCommunities = rankedAll.filter(r => r.creatorId === requesterId);
    const myTopCreatedCommunity = myCreatedCommunities.length
      ? myCreatedCommunities.reduce((best, cur) => (cur.rank < best.rank ? cur : best))
      : null;

    return res.json({
      leaderboard,
      myTopCreatedCommunity,
      myCreatedCommunities,
    });
  } catch (error) {
    console.error('Error in getWeeklyCommunityRanks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
