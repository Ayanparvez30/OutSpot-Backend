// controllers/communityController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const uploadToS3 = require('../utils/s3Upload');
const realtime = require('../utils/realtime');
const { notifyUser } = require('../utils/notificationService');


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
    const { name, bio } = req.body;
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
      data: { name, creatorId, imageUrl, bio: bio ?? null },
    });

    await prisma.communityMember.create({
      data: { userId: creatorId, communityId: community.id },
    });

    // Track history
    await prisma.communityHistory.create({
      data: { userId: creatorId, communityId: community.id, action: 'created' },
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
    const { name, bio } = req.body;
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
      // bio updates only when sent (undefined skips it); name/imageUrl as before
      data: { name, imageUrl, ...(bio !== undefined ? { bio } : {}) },
    });

    await prisma.chat.updateMany({
      where: { communityId: id, isCommunity: true },
      data: { name: updated.name, imageUrl: updated.imageUrl },
    });

    // Realtime: members refresh community name/image wherever shown
    realtime.toCommunity(id, 'community.details_updated', { communityId: id });

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
        select: { id: true, name: true, imageUrl: true, bio: true, creatorId: true },
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
      bio: community.bio || null,
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

    // Item 5a: reject join if this user is banned from the community.
    const banned = await prisma.communityBan.findFirst({
      where: { communityId: id, userId },
      select: { id: true, reason: true },
    });
    if (banned) {
      return res.status(403).json({ error: 'You are banned from this community', reason: banned.reason || null });
    }

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

    // Track history
    await prisma.communityHistory.create({
      data: { userId, communityId: id, action: 'joined' },
    });

    const chat = await ensureCommunityChat(id);
    const inChat = await prisma.userOnChat.findFirst({ where: { chatId: chat.id, userId } });
    if (!inChat) await prisma.userOnChat.create({ data: { chatId: chat.id, userId } });

    // Realtime: existing members' detail/member-list refresh + joiner's own
    // NoCommunity/joined-status refresh.
    realtime.toCommunity(id, 'community.member_added', { communityId: id, userId });
    realtime.toUser(userId, 'community.member_added', { communityId: id, userId });

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
      prisma.communityHistory.create({
        data: { userId, communityId: id, action: 'left' },
      }),
    ]);

    // Realtime: remaining members refresh + leaver's own list refresh
    realtime.toCommunity(id, 'community.member_removed', { communityId: id, userId });
    realtime.toUser(userId, 'community.member_removed', { communityId: id, userId });

    return res.json({ message: 'Left community & chat' });
  } catch (err) {
    console.error('leaveCommunity error:', err);
    return res.status(500).json({ error: 'Failed to leave community' });
  }
};

// -------------------- admin removes a member (exact clone of leave) --------------------
exports.removeMember = async (req, res) => {
  try {
    const adminId = req.authData.id;
    const id = Number(req.body?.communityId);
    const targetUserId = Number(req.body?.userId);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid communityId' });
    }
    if (!Number.isInteger(targetUserId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const community = await prisma.community.findUnique({
      where: { id },
      select: { id: true, creatorId: true },
    });
    if (!community) return res.status(404).json({ error: 'Community not found' });

    // Only the admin (creator) can remove members
    if (community.creatorId !== adminId) {
      return res.status(403).json({ error: 'Only the community admin can remove members' });
    }

    // Creator cannot be removed; they should delete the community instead
    if (community.creatorId === targetUserId) {
      return res.status(403).json({ error: 'Creator cannot be removed. Delete the community instead.' });
    }

    const membership = await prisma.communityMember.findFirst({
      where: { userId: targetUserId, communityId: id },
      select: { id: true },
    });
    if (!membership) {
      return res.status(404).json({ error: 'User is not a member of this community' });
    }

    await prisma.$transaction([
      prisma.communityMember.delete({ where: { id: membership.id } }),
      prisma.userOnChat.deleteMany({
        where: { userId: targetUserId, chat: { communityId: id, isCommunity: true } },
      }),
      prisma.communityHistory.create({
        data: { userId: targetUserId, communityId: id, action: 'left' },
      }),
    ]);

    // Realtime: remaining members refresh + removed user's own list refresh
    realtime.toCommunity(id, 'community.member_removed', { communityId: id, userId: targetUserId });
    realtime.toUser(targetUserId, 'community.member_removed', { communityId: id, userId: targetUserId });

    return res.json({ message: 'Member removed from community & chat' });
  } catch (err) {
    console.error('removeMember error:', err);
    return res.status(500).json({ error: 'Failed to remove member' });
  }
};

// -------------------- ban a member from this community (item 5a) --------------------
// Only the creator can ban. Inserts CommunityBan + reuses the removeMember
// cleanup (CommunityMember delete + UserOnChat delete + history + realtime).
// Idempotent — if already banned, re-uses the existing row.
exports.banMember = async (req, res) => {
  try {
    const adminId = req.authData.id;
    const id = Number(req.params?.communityId);
    const targetUserId = Number(req.params?.userId);
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 191) : null;

    if (!Number.isInteger(id))          return res.status(400).json({ error: 'Invalid communityId' });
    if (!Number.isInteger(targetUserId)) return res.status(400).json({ error: 'Invalid userId' });

    const community = await prisma.community.findUnique({
      where: { id },
      select: { id: true, creatorId: true, name: true },
    });
    if (!community) return res.status(404).json({ error: 'Community not found' });
    if (community.creatorId !== adminId) {
      return res.status(403).json({ error: 'Only the community admin can ban members' });
    }
    if (community.creatorId === targetUserId) {
      return res.status(403).json({ error: 'Creator cannot be banned. Delete the community instead.' });
    }

    // Insert ban (idempotent via unique [communityId, userId])
    await prisma.communityBan.upsert({
      where: { communityId_userId: { communityId: id, userId: targetUserId } },
      update: { reason, bannedById: adminId, bannedAt: new Date() },
      create: { communityId: id, userId: targetUserId, bannedById: adminId, reason },
    });

    // Remove from membership + community chat if currently in.
    const membership = await prisma.communityMember.findFirst({
      where: { userId: targetUserId, communityId: id },
      select: { id: true },
    });
    if (membership) {
      await prisma.$transaction([
        prisma.communityMember.delete({ where: { id: membership.id } }),
        prisma.userOnChat.deleteMany({
          where: { userId: targetUserId, chat: { communityId: id, isCommunity: true } },
        }),
        prisma.communityHistory.create({
          data: { userId: targetUserId, communityId: id, action: 'banned' },
        }),
      ]);
    }

    // Realtime
    realtime.toCommunity(id, 'community.member_banned',  { communityId: id, userId: targetUserId });
    realtime.toCommunity(id, 'community.member_removed', { communityId: id, userId: targetUserId });
    realtime.toUser(targetUserId, 'community.member_banned',  { communityId: id, userId: targetUserId, reason });
    realtime.toUser(targetUserId, 'community.member_removed', { communityId: id, userId: targetUserId });

    // Item 10: persistent in-app notification + FCM push (respects per-user
    // notification toggle inside notifyUser). Survives app-closed state.
    try {
      const cname = community.name || 'community';
      const desc  = `You were removed by an admin.${reason ? ` Reason: ${reason}` : ''}`;
      await notifyUser(
        targetUserId,
        'COMMUNITY_BANNED',
        `Removed from ${cname}`,
        desc,
        { actorId: adminId, communityId: id, ...(reason ? { reason } : {}) },
      );
    } catch (e) {
      console.error('banMember notifyUser error:', e);
    }

    return res.json({ message: 'Member banned from community' });
  } catch (err) {
    console.error('banMember error:', err);
    return res.status(500).json({ error: 'Failed to ban member' });
  }
};

// -------------------- unban (item 5a) --------------------
exports.unbanMember = async (req, res) => {
  try {
    const adminId = req.authData.id;
    const id = Number(req.params?.communityId);
    const targetUserId = Number(req.params?.userId);

    if (!Number.isInteger(id))           return res.status(400).json({ error: 'Invalid communityId' });
    if (!Number.isInteger(targetUserId)) return res.status(400).json({ error: 'Invalid userId' });

    const community = await prisma.community.findUnique({
      where: { id },
      select: { id: true, creatorId: true, name: true },
    });
    if (!community) return res.status(404).json({ error: 'Community not found' });
    if (community.creatorId !== adminId) {
      return res.status(403).json({ error: 'Only the community admin can unban members' });
    }

    await prisma.communityBan.deleteMany({ where: { communityId: id, userId: targetUserId } });
    realtime.toUser(targetUserId, 'community.member_unbanned', { communityId: id, userId: targetUserId });

    // Item 10: reinstatement notification + FCM push.
    try {
      const cname = community.name || 'community';
      await notifyUser(
        targetUserId,
        'COMMUNITY_UNBANNED',
        `Reinstated to ${cname}`,
        'An admin has unbanned you. You can rejoin now.',
        { actorId: adminId, communityId: id },
      );
    } catch (e) {
      console.error('unbanMember notifyUser error:', e);
    }

    return res.json({ message: 'Member unbanned' });
  } catch (err) {
    console.error('unbanMember error:', err);
    return res.status(500).json({ error: 'Failed to unban member' });
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

    // Realtime: members refresh (community gone from their lists)
    realtime.toCommunity(id, 'community.deleted', { communityId: id });

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

    const nameFilter = q ? { name: { contains: q } } : {};

    // Both created AND joined communities
    const where = {
      ...nameFilter,
      OR: [
        { creatorId: userId },
        { members: { some: { userId } } },
      ],
    };

    const [total, communities] = await prisma.$transaction([
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

    const items = communities.map((c) => ({
      id: c.id,
      name: c.name,
      imageUrl: c.imageUrl,
      membersCount: c._count.members,
      joinedAt: c.members?.[0]?.joinedAt ?? null,
      type: c.creatorId === userId ? 'created' : 'joined',
      isCreator: c.creatorId === userId,
      isMember: true,
    }));

    return res.json({ items, total, skip, take });
  } catch (err) {
    console.error('getMyCommunities error:', err);
    return res.status(500).json({ error: 'Failed to load your communities' });
  }
};

// -------------------- community history (join/leave log) --------------------
exports.getCommunityHistory = async (req, res) => {
  try {
    const userId = req.authData.id;
    const take = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const skip = Math.max(parseInt(req.query.skip || '0', 10), 0);

    const [total, history] = await prisma.$transaction([
      prisma.communityHistory.count({ where: { userId } }),
      prisma.communityHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          community: {
            select: { id: true, name: true, imageUrl: true },
          },
        },
      }),
    ]);

    const items = history.map((h) => ({
      id: h.id,
      action: h.action,
      communityId: h.community.id,
      communityName: h.community.name,
      communityImage: h.community.imageUrl,
      date: h.createdAt,
    }));

    return res.json({ items, total, skip, take });
  } catch (err) {
    console.error('getCommunityHistory error:', err);
    return res.status(500).json({ error: 'Failed to load community history' });
  }
};
