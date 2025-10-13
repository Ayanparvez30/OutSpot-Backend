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
    const userId = req.authData.id;
    const weekStart = getStartOfWeek();
    const { weekEnd, label } = getWeekEndAndLabel(weekStart);

    // 1) Top 50 (এই উইন্ডোর ভেতর)
    const grouped = await prisma.pointsLedger.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: weekStart, lt: weekEnd } },
      _sum: { finalPoints: true },
      orderBy: { _sum: { finalPoints: 'desc' } },
      take: 50,
    });

    const topUserIds = grouped.map(g => g.userId);

    // 2) টপ ইউজার প্রোফাইল
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

    // 3) টপ-৫০ লিস্ট
    const leaderboard = grouped
      .map((g, idx) => {
        const u = userMap.get(g.userId);
        const points = Number(g._sum.finalPoints || 0);
        const rank = idx + 1;
        return {
          userId: g.userId,
          username: u?.username || `user_${g.userId}`,
          avatarUrl: firstAvatar(u?.minime) || null,
          points,
          rank,
          prize: getPrizeForRank(rank),
        };
      })
      .filter(e => e.points > 0);

    // 4) পুরো ডাটাবেজে আমার র‍্যাঙ্ক (উইন্ডো ফাংশন)
    const rows = await prisma.$queryRaw`
      SELECT userId,
             SUM(finalPoints) AS points,
             RANK() OVER (ORDER BY SUM(finalPoints) DESC) AS rnk
      FROM pointsLedger
      WHERE createdAt >= ${weekStart} AND createdAt < ${weekEnd}
      GROUP BY userId
    `;

    const meRow = Array.isArray(rows)
      ? rows.find(r => String(r.userId) === String(userId))
      : undefined;

    let myInfo = leaderboard.find(e => e.userId === userId) || null;

    if (!myInfo) {
      // টপ-৫০ এ না থাকলে—তবু myInfo পূরণ করে দিচ্ছি
      const u = await prisma.user.findUnique({
        where: { id: userId },
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

      myInfo = {
        userId,
        username: u?.username || `user_${userId}`,
        avatarUrl: firstAvatar(u?.minime) || null,
        points: meRow ? Number(meRow.points || 0) : 0,
        rank: meRow ? Number(meRow.rnk) : null,           // 🔥 গ্লোবাল র‍্যাঙ্ক
        prize: meRow ? getPrizeForRank(Number(meRow.rnk)) : null,
        outsideTop: true,                                  // UI হিন্ট (ঐচ্ছিক)
      };
    } else {
      // টপ-৫০ এ আছি—গ্লোবাল র‍্যাঙ্ক sync করি
      if (meRow) {
        myInfo.rank = Number(meRow.rnk);
        myInfo.prize = getPrizeForRank(myInfo.rank);
      }
    }

    const myRank = meRow ? Number(meRow.rnk) : null;

    return res.json({
      window: {
        weekStart: weekStart.toISOString(),
        weekEnd: weekEnd.toISOString(),
        label,
        remaining: getTimeRemainingString(weekEnd),
      },
      leaderboard,          // টপ-৫০
      myRank,               // 🔥 পুরো ডাটাবেজে আমার র‍্যাঙ্ক
      myInfo,               // 🔥 টপ-৫০ এ না থাকলেও পূর্ণ অবজেক্ট
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
      .map(g => ({
        userId: g.userId,
        username: userMap.get(g.userId)?.username || `user_${g.userId}`,
        avatarUrl: firstAvatar(userMap.get(g.userId)?.minime) || null,
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
    const weekStart = getStartOfWeek();
    const { weekEnd, label } = getWeekEndAndLabel(weekStart);
    const requesterId = req.authData.id;

    // সব কমিউনিটি + মেম্বার + ক্রিয়েটর
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
        window: {
          weekStart: weekStart.toISOString(),
          weekEnd: weekEnd.toISOString(),
          label,
          remaining: getTimeRemainingString(weekEnd),
        },
        leaderboard: [],
        myTopCreatedCommunity: null,
        myCreatedCommunities: [],
      });
    }

    // সবার ইউজার আইডি
    const allUserIds = Array.from(
      new Set(communities.flatMap(c => c.members.map(m => m.userId)))
    );

    // সাপ্তাহিক টোটাল (এই উইন্ডোতে)
    const totalsMap = await getWeeklyTotalsForUsers(allUserIds, weekStart, weekEnd);

    // কমিউনিটি স্কোর
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

    // র‍্যাঙ্কিং
    const rankedAll = [...rows]
      .sort((a, b) => b.points - a.points)
      .map((r, idx) => ({
        ...r,
        rank: idx + 1,
        prize: getPrizeForRank(idx + 1),
      }));

    // পাবলিক লিডারবোর্ড: >0 পয়েন্ট
    const leaderboard = rankedAll.filter(r => r.points > 0);

    // আমার তৈরি কমিউনিটিস
    const myCreatedCommunities = rankedAll.filter(r => r.creatorId === requesterId);

    // সেরা (লোয়ার র‍্যাঙ্ক নাম্বার)
    const myTopCreatedCommunity = myCreatedCommunities.length
      ? myCreatedCommunities.reduce((best, cur) => (cur.rank < best.rank ? cur : best))
      : null;

    return res.json({
      window: {
        weekStart: weekStart.toISOString(),
        weekEnd: weekEnd.toISOString(),
        label,
        remaining: getTimeRemainingString(weekEnd),
      },
      leaderboard,
      myTopCreatedCommunity,
      myCreatedCommunities,
    });
  } catch (error) {
    console.error('Error in getWeeklyCommunityRanks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
