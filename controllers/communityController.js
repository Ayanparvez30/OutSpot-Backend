// controllers/communityController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const uploadToS3 = require('../utils/s3Upload');


const { getWeeklyPointsForUsers } = require('../utils/weeklyPoints');

// -------------------- helpers --------------------
const firstAvatar = (minimeArr) =>
  Array.isArray(minimeArr) && minimeArr.length > 0
    ? (minimeArr[0]?.avatarUrl || null)
    : null;

const ensureCommunityChat = async (communityId) => {
  const id = Number(communityId);

  const community = await prisma.community.findUnique({
    where: { id },
    select: { name: true, imageUrl: true },
  });
  if (!community) throw new Error('Community not found');

  let chat = await prisma.chat.findFirst({
    where: { communityId: id, isCommunity: true },
  });

  if (!chat) {
    chat = await prisma.chat.create({
      data: {
        isGroup: false,
        isCommunity: true,
        communityId: id,
        name: community.name,
        imageUrl: community.imageUrl,
        users: { create: [] },
      },
    });
  } else {
    const updateData = {};
    if (chat.name !== community.name) updateData.name = community.name;
    if (chat.imageUrl !== community.imageUrl) updateData.imageUrl = community.imageUrl;

    if (Object.keys(updateData).length) {
      chat = await prisma.chat.update({
        where: { id: chat.id },
        data: updateData,
      });
    }
  }

  return chat;
};

// -------------------- create community (+ chat) --------------------
exports.createCommunity = async (req, res) => {
  try {
    const { name } = req.body;
    const creatorId = req.authData.id;

    // One community per user
    const currentMembership = await prisma.communityMember.findFirst({
      where: { userId: creatorId },
      include: { community: { select: { id: true, name: true } } },
    });
    if (currentMembership) {
      return res.status(409).json({
        error: 'You are already a member of a community. Leave your current community first.',
        currentCommunityId: currentMembership.community.id,
        currentCommunityName: currentMembership.community.name,
      });
    }

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
  } catch (err) {
    console.error('createCommunity error:', err);
    res.status(500).json({ error: 'Failed to create community' });
  }
};

// -------------------- edit community (+ sync chat name/image) --------------------
exports.editCommunity = async (req, res) => {
  try {
    const { communityId } = req.params;
    const { name } = req.body;
    const userId = req.authData.id;

    const id = Number(communityId);
    const community = await prisma.community.findUnique({ where: { id } });
    if (!community) return res.status(404).json({ error: 'Community not found' });
    if (community.creatorId !== userId) return res.status(403).json({ error: 'Only creator can edit' });

    let imageUrl = community.imageUrl;
    if (req.file) {
      imageUrl = await uploadToS3(req.file, 'community-images');
    }

    const updated = await prisma.community.update({
      where: { id },
      data: { name, imageUrl },
    });

    await prisma.chat.updateMany({
      where: { communityId: id, isCommunity: true },
      data: { name: updated.name, imageUrl: updated.imageUrl },
    });

    res.json(updated);
  } catch (err) {
    console.error('editCommunity error:', err);
    res.status(500).json({ error: 'Failed to edit community' });
  }
};

// -------------------- list communities (with membership flags) --------------------
exports.getAllCommunities = async (req, res) => {
  try {
    const userId = req.authData.id;
    const q = (req.query.q || '').trim();
    const scope = String(req.query.scope || 'all').toLowerCase();
    const take = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const skip = Math.max(parseInt(req.query.skip || '0', 10), 0);

    const nameFilter = q ? { name: { contains: q } } : {};

    let where;
    switch (scope) {
      case 'mine':
        where = {
          AND: [
            nameFilter,
            { OR: [{ creatorId: userId }, { members: { some: { userId } } }] },
          ],
        };
        break;
      case 'joined':
        where = {
          AND: [nameFilter, { creatorId: { not: userId } }, { members: { some: { userId } } }],
        };
        break;
      case 'created':
        where = { AND: [nameFilter, { creatorId: userId }] };
        break;
      case 'all':
      default:
        where = nameFilter;
    }

    const communities = await prisma.community.findMany({
      where,
      include: {
        _count: { select: { members: true } },
        members: {
          where: { userId },
          select: { joinedAt: true },
          take: 1,
          orderBy: { joinedAt: 'desc' },
        },
      },
      orderBy: scope === 'all' ? { name: 'asc' } : { id: 'desc' },
      take,
      skip,
    });

    const items = communities.map((c) => ({
      id: c.id,
      name: c.name,
      imageUrl: c.imageUrl,
      membersCount: c._count.members,
      isCreator: c.creatorId === userId,
      isMember: c.members.length > 0,
      joinedAt: c.members[0]?.joinedAt || null,
    }));

    return res.json({ items, scope, skip, take, count: items.length });
  } catch (err) {
    console.error('getAllCommunities error:', err);
    return res.status(500).json({ error: 'Failed to fetch communities' });
  }
};

// -------------------- get community chat id --------------------
exports.getCommunityChatId = async (req, res) => {
  try {
    const { communityId } = req.params;
    const chat = await prisma.chat.findFirst({
      where: { communityId: parseInt(communityId, 10), isCommunity: true },
    });

    if (!chat) return res.status(404).json({ error: 'Community chat not found' });
    res.json({ chatId: chat.id });
  } catch (err) {
    console.error('getCommunityChatId error:', err);
    res.status(500).json({ error: 'Failed to fetch chat id' });
  }
};

// -------------------- get community details (with members + weekly points via ledger) --------------------
exports.getCommunityDetails = async (req, res) => {
  try {
    const { communityId } = req.params;
    const userId = req.authData.id;
    const cid = parseInt(communityId, 10);

    const [community, chat, members] = await Promise.all([
      prisma.community.findUnique({
        where: { id: cid },
        select: { id: true, name: true, imageUrl: true, creatorId: true },
      }),
      prisma.chat.findFirst({
        where: { communityId: cid, isCommunity: true },
        select: { id: true },
      }),
      prisma.communityMember.findMany({
        where: { communityId: cid },
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
                where: { isSaved: true },
                orderBy: { updatedAt: 'desc' },
              },
            },
          },
        },
      }),
    ]);

    if (!community) return res.status(404).json({ error: 'Community not found' });

    const userIds = members.map((m) => m.user.id);
    const weekMap = userIds.length ? await getWeeklyPointsForUsers(userIds) : new Map();

    const enrichedMembers = members.map((m) => ({
      id: m.user.id,
      username: m.user.username,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      avatarUrl: firstAvatar(m.user.minime),
      totalPoints: m.user.totalPoints || 0,
      thisWeekPoints: weekMap.get(m.user.id) || 0,
      profileUrl: `/api/users/${m.user.id}/profile`,
      isAdmin: m.user.id === community.creatorId,
    }));

    // Admin first, then alphabetical by name
    enrichedMembers.sort((a, b) => {
      if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
      const nameA = `${a.firstName || ''} ${a.lastName || ''}`.trim().toLowerCase();
      const nameB = `${b.firstName || ''} ${b.lastName || ''}`.trim().toLowerCase();
      return nameA.localeCompare(nameB);
    });

    return res.json({
      id: community.id,
      name: community.name,
      imageUrl: community.imageUrl,
      creatorId: community.creatorId,
      chatId: chat?.id || null,
      isMember: members.some((m) => m.user.id === userId),
      isCreator: community.creatorId === userId,
      members: enrichedMembers,
    });
  } catch (err) {
    console.error('getCommunityDetails error:', err);
    return res.status(500).json({ error: 'Failed to fetch community details' });
  }
};

// -------------------- join community (+ add to chat) --------------------
exports.joinCommunity = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { communityId } = req.body;
    const id = Number(communityId);

    const existing = await prisma.communityMember.findFirst({ where: { userId, communityId: id } });
    if (existing) return res.status(409).json({ error: 'Already a member' });

    // One community per user
    const currentMembership = await prisma.communityMember.findFirst({
      where: { userId },
      include: { community: { select: { id: true, name: true } } },
    });
    if (currentMembership) {
      return res.status(409).json({
        error: 'You are already a member of a community. Leave your current community first.',
        currentCommunityId: currentMembership.community.id,
        currentCommunityName: currentMembership.community.name,
      });
    }

    await prisma.communityMember.create({ data: { userId, communityId: id } });

    const chat = await ensureCommunityChat(id);
    const inChat = await prisma.userOnChat.findFirst({ where: { chatId: chat.id, userId } });
    if (!inChat) await prisma.userOnChat.create({ data: { chatId: chat.id, userId } });

    res.json({ message: 'Joined community & added to chat' });
  } catch (err) {
    console.error('joinCommunity error:', err);
    res.status(500).json({ error: 'Failed to join community' });
  }
};

// -------------------- leave community (+ remove from chat) --------------------
exports.leaveCommunity = async (req, res) => {
  try {
    const userId = req.authData.id;
    const id = Number(req.body?.communityId);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid communityId' });
    }

    const community = await prisma.community.findUnique({
      where: { id },
      select: { id: true, creatorId: true },
    });
    if (!community) return res.status(404).json({ error: 'Community not found' });

    // Creator cannot leave; they should delete the community instead
    if (community.creatorId === userId) {
      return res.status(403).json({ error: 'Creator cannot leave. Delete the community instead.' });
    }

    const membership = await prisma.communityMember.findFirst({
      where: { userId, communityId: id },
      select: { id: true },
    });
    if (!membership) {
      return res.status(404).json({ error: 'You are not a member of this community' });
    }

    await prisma.$transaction([
      prisma.communityMember.delete({ where: { id: membership.id } }),
      prisma.userOnChat.deleteMany({
        where: { userId, chat: { communityId: id, isCommunity: true } },
      }),
    ]);

    return res.json({ message: 'Left community & chat' });
  } catch (err) {
    console.error('leaveCommunity error:', err);
    return res.status(500).json({ error: 'Failed to leave community' });
  }
};

// -------------------- delete community --------------------
exports.deleteCommunity = async (req, res) => {
  try {
    const userId = req.authData.id;
    const id = Number(req.params?.communityId ?? req.body?.communityId);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid communityId' });
    }

    const community = await prisma.community.findUnique({
      where: { id },
      select: { id: true, creatorId: true },
    });
    if (!community) return res.status(404).json({ error: 'Community not found' });

    if (community.creatorId !== userId) {
      return res.status(403).json({ error: 'Only the creator can delete this community' });
    }

    await prisma.community.delete({ where: { id } });

    return res.json({ message: 'Community deleted' });
  } catch (err) {
    console.error('deleteCommunity error:', err);
    return res.status(500).json({ error: 'Failed to delete community' });
  }
};

// -------------------- my most recent community --------------------
exports.getMyRecentCommunities = async (req, res) => {
  try {
    const userId = req.authData.id;

    const membership = await prisma.communityMember.findFirst({
      where: { userId },
      orderBy: { joinedAt: 'desc' },
      include: {
        community: {
          select: {
            id: true,
            name: true,
            imageUrl: true,
            creatorId: true,
            _count: { select: { members: true } },
          },
        },
      },
    });

    if (!membership) {
      return res.json({ mostRecent: null });
    }

    const c = membership.community;

    const mostRecent = {
      id: c.id,
      name: c.name,
      imageUrl: c.imageUrl || null,
      membersCount: c._count.members,
      type: c.creatorId === userId ? 'created' : 'joined',
      at: membership.joinedAt,
    };

    return res.json({ mostRecent });
  } catch (err) {
    console.error('getMyRecentCommunities error:', err);
    return res.status(500).json({ error: 'Failed to load recent community' });
  }
};
// -------------------- my communities (created only) --------------------
exports.getMyCommunities = async (req, res) => {
  try {
    const userId = req.authData.id;

    const q = (req.query.q || '').trim();
    const take = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const skip = Math.max(parseInt(req.query.skip || '0', 10), 0);

    const nameFilter = q
      ? { name: { contains: q, mode: 'insensitive' } }
      : {};

    const where = { creatorId: userId, ...nameFilter };

   
    const [total, createdItems] = await prisma.$transaction([
      prisma.community.count({ where }),
      prisma.community.findMany({
        where,
        orderBy: { id: 'desc' },
        take,
        skip,
        include: {
          _count: { select: { members: true } },

          members: {
            where: { userId },
            select: { joinedAt: true },
            take: 1,
            orderBy: { joinedAt: 'desc' },
          },
        },
      }),
    ]);

    const items = createdItems.map((c) => ({
      id: c.id,
      name: c.name,
      imageUrl: c.imageUrl,
      membersCount: c._count.members,
      joinedAt: c.members?.[0]?.joinedAt ?? null,
      type: 'created',
      isCreator: true,
      isMember: true, 
    }));

    return res.json({ items, total, skip, take });
  } catch (err) {
    console.error('getMyCommunities (created only) error:', err);
    return res.status(500).json({ error: 'Failed to load your communities' });
  }
};
