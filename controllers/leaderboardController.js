// controllers/leaderboardController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function getStartOfWeek() {
  const now = new Date();
  const day = now.getDay();
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

exports.getWeeklyGlobalLeaderboard = async (req, res) => {
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

  const submissions = await prisma.submission.findMany({
    where: { createdAt: { gte: weekStart } },
    include: { challenge: true }
  });

  const pointsByUser = {};
  for (const sub of submissions) {
    if (!pointsByUser[sub.userId]) pointsByUser[sub.userId] = 0;
    pointsByUser[sub.userId] += sub.challenge?.points || 0;
  }

  const locationPoints = await prisma.locationPoint.findMany({
    where: { createdAt: { gte: weekStart } }
  });

  for (const loc of locationPoints) {
    if (!pointsByUser[loc.userId]) pointsByUser[loc.userId] = 0;
    pointsByUser[loc.userId] += loc.points || 0;
  }

  const rawLeaderboard = users.map(user => ({
    userId: user.id,
    username: user.username,
    avatarUrl: user.minime[0]?.avatarUrl || null,
    points: pointsByUser[user.id] || 0
  }));

  const sorted = rawLeaderboard.sort((a, b) => b.points - a.points);

  const leaderboard = sorted.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    prize: getPrizeForRank(index + 1)
  }));

  const myInfo = leaderboard.find(u => u.userId === userId) || null;
  const myRank = myInfo?.rank || null;
  const prize = myInfo?.prize || null;

  res.json({ leaderboard: leaderboard.slice(0, 50), myRank, myInfo, prize });
};

exports.getWeeklyCommunityLeaderboard = async (req, res) => {
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
  const submissions = await prisma.submission.findMany({
    where: {
      userId: { in: userIds },
      createdAt: { gte: weekStart }
    },
    include: { challenge: true }
  });

  const pointsByUser = {};
  for (const sub of submissions) {
    if (!pointsByUser[sub.userId]) pointsByUser[sub.userId] = 0;
    pointsByUser[sub.userId] += sub.challenge?.points || 0;
  }

  const locationPoints = await prisma.locationPoint.findMany({
    where: {
      userId: { in: userIds },
      createdAt: { gte: weekStart }
    }
  });

  for (const loc of locationPoints) {
    if (!pointsByUser[loc.userId]) pointsByUser[loc.userId] = 0;
    pointsByUser[loc.userId] += loc.points || 0;
  }

  const rawLeaderboard = members.map(m => ({
    userId: m.userId,
    username: m.user.username,
    avatarUrl: m.user.minime[0]?.avatarUrl || null,
    points: pointsByUser[m.userId] || 0
  }));

  const sorted = rawLeaderboard.sort((a, b) => b.points - a.points);

  const leaderboard = sorted.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    prize: getPrizeForRank(index + 1)
  }));

  const myInfo = leaderboard.find(u => u.userId === userId) || null;
  const myRank = myInfo?.rank || null;
  const prize = myInfo?.prize || null;

  res.json({ leaderboard: leaderboard.slice(0, 50), myRank, myInfo, prize });
};

exports.getWeeklyCommunityRanks = async (req, res) => {
  const weekStart = getStartOfWeek();

  const communities = await prisma.community.findMany({
    include: {
      members: { select: { userId: true } }
    }
  });

  const pointsByCommunity = [];

  for (const community of communities) {
    const memberIds = community.members.map(m => m.userId);

    const submissions = await prisma.submission.findMany({
      where: {
        userId: { in: memberIds },
        createdAt: { gte: weekStart }
      },
      include: { challenge: true }
    });

    const locationPoints = await prisma.locationPoint.findMany({
      where: {
        userId: { in: memberIds },
        createdAt: { gte: weekStart }
      }
    });

    let total = 0;
    for (const sub of submissions) {
      total += sub.challenge?.points || 0;
    }
    for (const loc of locationPoints) {
      total += loc.points || 0;
    }

    pointsByCommunity.push({
      communityId: community.id,
      name: community.name,
      points: total
    });
  }

  const sorted = pointsByCommunity.sort((a, b) => b.points - a.points);

  const ranked = sorted.map((c, index) => ({
    ...c,
    rank: index + 1,
    prize: getPrizeForRank(index + 1)
  }));

  res.json({ leaderboard: ranked });
};