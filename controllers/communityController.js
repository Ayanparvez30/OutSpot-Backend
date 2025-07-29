const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
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
        users: {
          create: []  // We'll add members individually
        }
      }
    });
  }

  return chat;
};
exports.createCommunity = async (req, res) => {
  const { name, description } = req.body;

  const community = await prisma.community.create({
    data: { name, description }
  });

  res.json(community);
};

exports.getAllCommunities = async (req, res) => {
  const communities = await prisma.community.findMany({
    include: { _count: { select: { members: true } } }
  });
  res.json(communities);
};

exports.joinCommunity = async (req, res) => {
  const userId = req.authData.id;
  const { communityId } = req.body;

  const existing = await prisma.communityMember.findFirst({
    where: { userId, communityId }
  });
  if (existing) return res.status(409).json({ error: 'Already a member' });

  await prisma.communityMember.create({ data: { userId, communityId } });

  // 🆕 Auto-add to community chat
  const chat = await ensureCommunityChat(communityId);

  const inChat = await prisma.userOnChat.findFirst({
    where: { chatId: chat.id, userId }
  });
  if (!inChat) {
    await prisma.userOnChat.create({ data: { chatId: chat.id, userId } });
  }

  res.json({ message: 'Joined community & added to chat' });
};

exports.leaveCommunity = async (req, res) => {
  const userId = req.authData.id;
  const { communityId } = req.body;

  await prisma.communityMember.deleteMany({ where: { userId, communityId } });
  res.json({ message: 'Left community' });
};

exports.getCommunityDetails = async (req, res) => {
  const { communityId } = req.params;
  const community = await prisma.community.findUnique({
    where: { id: parseInt(communityId) },
    include: {
      members: {
        include: { user: { select: { id: true, username: true, minime: { select: { avatarUrl: true } } } } }
      }
    }
  });

  if (!community) return res.status(404).json({ error: 'Community not found' });
  res.json(community);
};

exports.getCommunityChatId = async (req, res) => {
  const { communityId } = req.params;

  const chat = await prisma.chat.findFirst({
    where: { communityId: parseInt(communityId), isCommunity: true }
  });

  if (!chat) return res.status(404).json({ error: 'Community chat not found' });

  res.json({ chatId: chat.id });
};
