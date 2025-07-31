// const { PrismaClient } = require('@prisma/client');
// const { getIO } = require('../socket');
// const prisma = new PrismaClient();

// function getStartOfWeek() {
//   const now = new Date();
//   const day = now.getDay();
//   const diff = now.getDate() - day + (day === 0 ? -6 : 1);
//   const monday = new Date(now.setDate(diff));
//   monday.setHours(0, 0, 0, 0);
//   return monday;
// }

// function getPrizeForRank(rank) {
//   if (rank === 1) return '🥇 1st Prize';
//   if (rank === 2) return '🥈 2nd Prize';
//   if (rank === 3) return '🥉 3rd Prize';
//   if (rank <= 10) return '🏅 Top 10';
//   if (rank <= 50) return '🎖️ Top 50';
//   return null;
// }

// exports.getWeeklyChallengeLeaderboard = async (req, res) => {
//   const userId = req.authData.id;
//   const startOfWeek = getStartOfWeek();

//   const weeklyChallenges = await prisma.challenge.findMany({
//     where: {
//       type: 'WEEKLY',
//       startDate: { gte: startOfWeek },
//       endDate: { gte: new Date() } // active this week
//     },
//     select: { id: true, points: true }
//   });

//   const challengeIds = weeklyChallenges.map(c => c.id);
//   const pointsMap = Object.fromEntries(weeklyChallenges.map(c => [c.id, c.points]));

//   const submissions = await prisma.submission.findMany({
//     where: { challengeId: { in: challengeIds } },
//     include: { user: { include: { minime: { where: { isSaved: true }, orderBy: { createdAt: 'desc' }, take: 1 } } } }
//   });

//   const leaderboardMap = new Map();

//   for (const s of submissions) {
//     if (!leaderboardMap.has(s.userId)) {
//       leaderboardMap.set(s.userId, {
//         userId: s.userId,
//         username: s.user.username,
//         avatarUrl: s.user.minime[0]?.avatarUrl || null,
//         points: 0
//       });
//     }
//     leaderboardMap.get(s.userId).points += pointsMap[s.challengeId] || 0;
//   }

//   const leaderboard = Array.from(leaderboardMap.values()).sort((a, b) => b.points - a.points);
//   const myRank = leaderboard.findIndex(u => u.userId === userId) + 1;
//   const myInfo = leaderboard.find(u => u.userId === userId) || null;

//   const prize = getPrizeForRank(myRank);

//   res.json({
//     leaderboard: leaderboard.slice(0, 50),
//     myRank,
//     myInfo,
//     prize
//   });
// };

// exports.getCommunityWeeklyLeaderboard = async (req, res) => {
//   const userId = req.authData.id;
//   const communityId = parseInt(req.params.communityId);
//   const startOfWeek = getStartOfWeek();

//   const weeklyChallenges = await prisma.challenge.findMany({
//     where: {
//       type: 'WEEKLY',
//       startDate: { gte: startOfWeek },
//       endDate: { gte: new Date() }
//     },
//     select: { id: true, points: true }
//   });

//   const challengeIds = weeklyChallenges.map(c => c.id);
//   const pointsMap = Object.fromEntries(weeklyChallenges.map(c => [c.id, c.points]));

//   const members = await prisma.communityMember.findMany({
//     where: { communityId },
//     select: { userId: true, user: { include: { minime: { where: { isSaved: true }, orderBy: { createdAt: 'desc' }, take: 1 } } } }
//   });

//   const memberIds = members.map(m => m.userId);

//   const submissions = await prisma.submission.findMany({
//     where: {
//       userId: { in: memberIds },
//       challengeId: { in: challengeIds }
//     }
//   });

//   const leaderboardMap = new Map();
//   for (const member of members) {
//     leaderboardMap.set(member.userId, {
//       userId: member.userId,
//       username: member.user.username,
//       avatarUrl: member.user.minime[0]?.avatarUrl || null,
//       points: 0
//     });
//   }

//   for (const s of submissions) {
//     leaderboardMap.get(s.userId).points += pointsMap[s.challengeId] || 0;
//   }

//   const leaderboard = Array.from(leaderboardMap.values()).sort((a, b) => b.points - a.points);
//   const myRank = leaderboard.findIndex(u => u.userId === userId) + 1;
//   const myInfo = leaderboard.find(u => u.userId === userId) || null;
//   const prize = getPrizeForRank(myRank);

//   res.json({
//     leaderboard: leaderboard.slice(0, 50),
//     myRank,
//     myInfo,
//     prize
//   });
// };

// exports.emitLeaderboardUpdate = async (userId) => {
//   const io = getIO();
//   io.emit('leaderboard:update', { scope: 'weekly-global' });

//   const communityMemberships = await prisma.communityMember.findMany({
//     where: { userId },
//     select: { communityId: true }
//   });

//   for (const { communityId } of communityMemberships) {
//     io.emit('leaderboard:update', { scope: 'weekly-community', communityId });
//   }
// };
