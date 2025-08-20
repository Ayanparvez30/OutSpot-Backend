const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const uploadToS3 = require('../utils/s3Upload');  
const ensureCommunityChat = async (communityId) => {
  let chat = await prisma.chat.findFirst({
    where: { communityId, isCommunity: true },
  });

  if (!chat) {
    chat = await prisma.chat.create({
      data: {
        isGroup: true,
        isCommunity: true,
        communityId,
        name: `Community-${communityId}`,
        users: { create: [] },
      },
    });
  }

  return chat;
};


exports.createCommunity = async (req, res) => {
  const { name} = req.body;
  const creatorId = req.authData.id;

  let imageUrl = null;
  if (req.file) {

    imageUrl = await uploadToS3(req.file, 'community-images');
  }

  const community = await prisma.community.create({
    data: { name, creatorId, imageUrl },
  });

  await prisma.communityMember.create({
    data: { userId: creatorId, communityId: community.id },
  });

  const chat = await ensureCommunityChat(community.id);
  await prisma.userOnChat.create({
    data: { chatId: chat.id, userId: creatorId },
  });

  res.json(community);
};

exports.editCommunity = async (req, res) => {
  const { communityId } = req.params;
  const { name } = req.body;
  const userId = req.authData.id;

  const community = await prisma.community.findUnique({ where: { id: parseInt(communityId) } });

  if (!community) return res.status(404).json({ error: 'Community not found' });
  if (community.creatorId !== userId) return res.status(403).json({ error: 'Only creator can edit' });

  let imageUrl = community.imageUrl;
  if (req.file) {
    imageUrl = await uploadToS3(req.file, 'community-images');
  }

  const updated = await prisma.community.update({
    where: { id: community.id },
    data: { name,imageUrl },
  });

  res.json(updated);
};
// exports.createCommunity = async (req, res) => {
//   const { name, description } = req.body;
//   const creatorId = req.authData.id;
//   const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

//   const community = await prisma.community.create({
//     data: { name, description, creatorId, imageUrl },
//   });

//   await prisma.communityMember.create({
//     data: { userId: creatorId, communityId: community.id },
//   });

//   const chat = await ensureCommunityChat(community.id);
//   await prisma.userOnChat.create({
//     data: { chatId: chat.id, userId: creatorId },
//   });

//   res.json(community);
// };

// exports.editCommunity = async (req, res) => {
//   const { communityId } = req.params;
//   const { name, description } = req.body;
//   const userId = req.authData.id;

//   const community = await prisma.community.findUnique({ where: { id: parseInt(communityId) } });

//   if (!community) return res.status(404).json({ error: 'Community not found' });
//   if (community.creatorId !== userId) return res.status(403).json({ error: 'Only creator can edit' });

//   const imageUrl = req.file ? `/uploads/${req.file.filename}` : community.imageUrl;

//   const updated = await prisma.community.update({
//     where: { id: community.id },
//     data: { name, description, imageUrl },
//   });

//   res.json(updated);
// };

exports.getAllCommunities = async (req, res) => {
  const q = req.query.q?.trim();

  const communities = await prisma.community.findMany({
    where: q ? { name: { contains: q } } : {},
    include: {
      _count: { select: { members: true } },
    },
    orderBy: { name: 'asc' },
  });

  res.json(communities);
};

exports.getCommunityDetails = async (req, res) => {
  const { communityId } = req.params;
  const community = await prisma.community.findUnique({
    where: { id: parseInt(communityId) },
    select: {
      id: true,
      name: true,
    
      imageUrl: true,
    }
  });

  if (!community) return res.status(404).json({ error: 'Community not found' });

  const members = await prisma.communityMember.findMany({
    where: { communityId: parseInt(communityId) },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          bio: true,
          totalPoints: true,
          minime: {
  select: { avatarUrl: true },
  where: { isSaved: true } 
}

        },
      },
    },
    orderBy: { joinedAt: 'asc' },
  });

  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const weekStart = new Date(now.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);

  const enrichedMembers = await Promise.all(members.map(async (m) => {
    const user = m.user;
    const submissions = await prisma.submission.findMany({
      where: {
        userId: user.id,
        createdAt: { gte: weekStart },
      },
      include: { challenge: true },
    });
    const challengePoints = submissions.reduce((sum, s) => sum + (s.challenge?.points || 0), 0);

    const locationPoints = await prisma.locationPoint.findMany({
      where: {
        userId: user.id,
        createdAt: { gte: weekStart },
      },
    });
    const mapPoints = locationPoints.reduce((sum, p) => sum + (p.points || 0), 0);

    return {
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.minime?.[0]?.avatarUrl || null,
      totalPoints: user.totalPoints,
      thisWeekPoints: challengePoints + mapPoints,
      profileUrl: `/api/users/${user.id}/profile`
    };
  }));

  res.json({ ...community, members: enrichedMembers });
};

exports.joinCommunity = async (req, res) => {
  const userId = req.authData.id;
  const { communityId } = req.body;

  const existing = await prisma.communityMember.findFirst({ where: { userId, communityId } });
  if (existing) return res.status(409).json({ error: 'Already a member' });

  await prisma.communityMember.create({ data: { userId, communityId } });

  const chat = await ensureCommunityChat(communityId);
  const inChat = await prisma.userOnChat.findFirst({ where: { chatId: chat.id, userId } });
  if (!inChat) await prisma.userOnChat.create({ data: { chatId: chat.id, userId } });

  res.json({ message: 'Joined community & added to chat' });
};

exports.leaveCommunity = async (req, res) => {
  const userId = req.authData.id;
  const { communityId } = req.body;

  await prisma.communityMember.deleteMany({ where: { userId, communityId } });
  await prisma.userOnChat.deleteMany({
    where: {
      userId,
      chat: { communityId, isCommunity: true },
    },
  });

  res.json({ message: 'Left community & chat' });
};

exports.getCommunityChatId = async (req, res) => {
  const { communityId } = req.params;
  const chat = await prisma.chat.findFirst({
    where: { communityId: parseInt(communityId), isCommunity: true },
  });

  if (!chat) return res.status(404).json({ error: 'Community chat not found' });
  res.json({ chatId: chat.id });
};
exports.getMyRecentCommunities = async (req, res) => {
  const userId = req.authData.id;

  const [created, joined] = await Promise.all([
    prisma.community.findMany({
      where: { creatorId: userId },
      orderBy: { id: 'desc' },  // createdAt থাকলে createdAt ব্যবহার করুন
      include: { _count: { select: { members: true } } }
    }),
    prisma.communityMember.findMany({
      where: { userId },
      orderBy: { joinedAt: 'desc' },
      include: {
        community: { include: { _count: { select: { members: true } } } }
      }
    })
  ]);

  const merged = [
    ...created.map(c => ({
      id: c.id,
      name: c.name,
      imageUrl: c.imageUrl,
      membersCount: c._count.members,
      type: 'created',
      at: c.createdAt ?? null
    })),
    ...joined.map(m => ({
      id: m.community.id,
      name: m.community.name,
      imageUrl: m.community.imageUrl,
      membersCount: m.community._count.members,
      type: 'joined',
      at: m.joinedAt
    }))
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  res.json(merged);
};
