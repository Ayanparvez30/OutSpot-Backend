// controllers/leaderboardController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Get Monday of the current week (00:00:00)
 */
function getStartOfWeek() {
  const now = new Date();
  const day = now.getDay(); // Sunday = 0, Monday = 1
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/**
 * Prize mapping
 */
function getPrizeForRank(rank) {
  if (rank === 1) return '🥇 1st Prize';
  if (rank === 2) return '🥈 2nd Prize';
  if (rank === 3) return '🥉 3rd Prize';
  if (rank <= 10) return '🏅 Top 10';
  if (rank <= 50) return '🎖️ Top 50';
  return null;
}

/**
 * Utility: Calculate points for given user IDs in the current week
 */
async function calculateWeeklyPoints(userIds, weekStart) {
  const pointsByUser = {};

  // Challenge submissions
  const submissions = await prisma.submission.findMany({
    where: {
      userId: { in: userIds },
      createdAt: { gte: weekStart }
    },
    include: { challenge: true }
  });

  for (const sub of submissions) {
    pointsByUser[sub.userId] = (pointsByUser[sub.userId] || 0) + (sub.challenge?.points || 0);
  }

  // Location points
  const locationPoints = await prisma.locationPoint.findMany({
    where: {
      userId: { in: userIds },
      createdAt: { gte: weekStart }
    }
  });

  for (const loc of locationPoints) {
    pointsByUser[loc.userId] = (pointsByUser[loc.userId] || 0) + (loc.points || 0);
  }

  return pointsByUser;
}


exports.getWeeklyGlobalLeaderboard = async (req, res) => {
  try {
    const userId = req.authData.id;
    const weekStart = getStartOfWeek();

    const users = await prisma.user.findMany({
      include: {
        minime: {
          where: { isSaved: true },
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    const userIds = users.map(u => u.id);
    const pointsByUser = await calculateWeeklyPoints(userIds, weekStart);

    const rawLeaderboard = users.map(user => ({
      userId: user.id,
      username: user.username,
      avatarUrl: user.minime[0]?.avatarUrl || null,
      points: pointsByUser[user.id] || 0
    }));

    // Sort & rank
    const sorted = rawLeaderboard
      .filter(u => u.points > 0) // Optional: only active users
      .sort((a, b) => b.points - a.points);

    const leaderboard = sorted.map((entry, index) => ({
      ...entry,
      rank: index + 1,
      prize: getPrizeForRank(index + 1)
    }));

    const myInfo = leaderboard.find(u => u.userId === userId) || null;

    res.json({
      leaderboard: leaderboard.slice(0, 50),
      myRank: myInfo?.rank || null,
      myInfo,
      prize: myInfo?.prize || null
    });
  } catch (error) {
    console.error('Error in getWeeklyGlobalLeaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Leaderboard for members of a specific community
 */
exports.getWeeklyCommunityLeaderboard = async (req, res) => {
  try {
    const userId = req.authData.id;
    const communityId = parseInt(req.params.communityId);
    const weekStart = getStartOfWeek();

    const members = await prisma.communityMember.findMany({
      where: { communityId },
      include: {
        user: {
          include: {
            minime: {
              where: { isSaved: true },
              orderBy: { createdAt: 'desc' },
              take: 1
            }
          }
        }
      }
    });

    const userIds = members.map(m => m.userId);
    const pointsByUser = await calculateWeeklyPoints(userIds, weekStart);

    const rawLeaderboard = members.map(m => ({
      userId: m.userId,
      username: m.user.username,
      avatarUrl: m.user.minime[0]?.avatarUrl || null,
      points: pointsByUser[m.userId] || 0
    }));

    const sorted = rawLeaderboard
      .filter(u => u.points > 0)
      .sort((a, b) => b.points - a.points);

    const leaderboard = sorted.map((entry, index) => ({
      ...entry,
      rank: index + 1,
      prize: getPrizeForRank(index + 1)
    }));

    const myInfo = leaderboard.find(u => u.userId === userId) || null;

    res.json({
      leaderboard: leaderboard.slice(0, 50),
      myRank: myInfo?.rank || null,
      myInfo,
      prize: myInfo?.prize || null
    });
  } catch (error) {
    console.error('Error in getWeeklyCommunityLeaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Community ranking based on total member points
 */
exports.getWeeklyCommunityRanks = async (req, res) => {
  try {
    const weekStart = getStartOfWeek();

    const communities = await prisma.community.findMany({
      include: { members: { select: { userId: true } } }
    });

    const pointsByCommunity = [];

    for (const community of communities) {
      const memberIds = community.members.map(m => m.userId);
      const pointsByUser = await calculateWeeklyPoints(memberIds, weekStart);
      const total = Object.values(pointsByUser).reduce((sum, p) => sum + p, 0);

      pointsByCommunity.push({
        communityId: community.id,
        name: community.name,
        points: total
      });
    }

    const sorted = pointsByCommunity
      .filter(c => c.points > 0)
      .sort((a, b) => b.points - a.points);

    const ranked = sorted.map((c, index) => ({
      ...c,
      rank: index + 1,
      prize: getPrizeForRank(index + 1)
    }));

    res.json({ leaderboard: ranked });
  } catch (error) {
    console.error('Error in getWeeklyCommunityRanks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
