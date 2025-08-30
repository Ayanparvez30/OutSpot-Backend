const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const uploadToS3 = require('../utils/s3Upload');  


const ensureCommunityChat = async (communityId) => {
  const id = Number(communityId);

  const community = await prisma.community.findUnique({
    where: { id },
    select: { name: true, imageUrl: true }, // ✅ include imageUrl
  });
  if (!community) throw new Error('Community not found');

  let chat = await prisma.chat.findFirst({
    where: { communityId: id, isCommunity: true },
  });

  if (!chat) {
    chat = await prisma.chat.create({
      data: {
        isGroup: true,
        isCommunity: true,
        communityId: id,
        name: community.name,
        imageUrl: community.imageUrl,   // ✅ set from community
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

  // ✅ Sync BOTH name and imageUrl into community chat
  await prisma.chat.updateMany({
    where: { communityId: id, isCommunity: true },
    data: { name: updated.name, imageUrl: updated.imageUrl },
  });

  res.json(updated);
};


exports.getAllCommunities = async (req, res) => {
  try {
    const userId = req.authData.id; // kept if you need membership flags
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
            { OR: [{ creatorId: userId }, { members: { some: { userId } } }] }
          ]
        };
        break;
      case 'joined':
        where = {
          AND: [nameFilter, { creatorId: { not: userId } }, { members: { some: { userId } } }]
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
          orderBy: { joinedAt: 'desc' }
        }
      },
      orderBy: scope === 'all' ? { name: 'asc' } : { id: 'desc' },
      take,
      skip
    });

    const items = communities.map(c => ({
      id: c.id,
      name: c.name,
      imageUrl: c.imageUrl,
      membersCount: c._count.members,
      isCreator: c.creatorId === userId,
      isMember: c.members.length > 0,
      joinedAt: c.members[0]?.joinedAt || null
    }));

    return res.json({ items, scope, skip, take, count: items.length });
  } catch (err) {
    console.error('getAllCommunities error:', err);
    return res.status(500).json({ error: 'Failed to fetch communities' });
  }
};

exports.getCommunityChatId = async (req, res) => {
  const { communityId } = req.params;
  const chat = await prisma.chat.findFirst({
    where: { communityId: parseInt(communityId), isCommunity: true },
  });

  if (!chat) return res.status(404).json({ error: 'Community chat not found' });
  res.json({ chatId: chat.id });
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
try {
const userId = req.authData.id;
const id = Number(req.body?.communityId);
if (!Number.isInteger(id)) {
return res.status(400).json({ error: 'Invalid communityId' });
}


const community = await prisma.community.findUnique({
where: { id },
select: { id: true, creatorId: true }
});
if (!community) return res.status(404).json({ error: 'Community not found' });


// Creator cannot leave; they should delete the community instead
if (community.creatorId === userId) {
return res.status(403).json({ error: 'Creator cannot leave. Delete the community instead.' });
}


const membership = await prisma.communityMember.findFirst({
where: { userId, communityId: id },
select: { id: true }
});
if (!membership) {
return res.status(404).json({ error: 'You are not a member of this community' });
}


await prisma.$transaction([
prisma.communityMember.delete({ where: { id: membership.id } }),
prisma.userOnChat.deleteMany({
where: { userId, chat: { communityId: id, isCommunity: true } }
})
]);


return res.json({ message: 'Left community & chat' });
} catch (err) {
console.error('leaveCommunity error:', err);
return res.status(500).json({ error: 'Failed to leave community' });
}
};



exports.deleteCommunity = async (req, res) => {
try {
const userId = req.authData.id;
const id = Number(req.params?.communityId ?? req.body?.communityId);
if (!Number.isInteger(id)) {
return res.status(400).json({ error: 'Invalid communityId' });
}


const community = await prisma.community.findUnique({
where: { id },
select: { id: true, creatorId: true }
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


exports.getMyRecentCommunities = async (req, res) => {
try {
const userId = req.authData.id;


const take = Math.min(parseInt(req.query.limit || '50', 10), 100);
const skip = Math.max(parseInt(req.query.skip || '0', 10), 0);
const onlyRecent = String(req.query.onlyRecent || '').toLowerCase() === 'true';


// Communities I created — include my membership to fetch joinedAt (acts as created time)
const created = await prisma.community.findMany({
where: { creatorId: userId },
orderBy: { id: 'desc' },
include: {
_count: { select: { members: true } },
members: {
where: { userId },
select: { joinedAt: true },
take: 1,
orderBy: { joinedAt: 'desc' }
}
}
});


// Communities I joined (but not created by me)
const joined = await prisma.communityMember.findMany({
where: { userId, community: { creatorId: { not: userId } } },
orderBy: { joinedAt: 'desc' },
include: {
community: { include: { _count: { select: { members: true } } } }
}
});


// Normalize shape
const items = [];


for (const c of created) {
const at = c.members?.[0]?.joinedAt ?? null; // creator's membership join time
items.push({
id: c.id,
name: c.name,
imageUrl: c.imageUrl,
membersCount: c._count.members,
type: 'created',
at
});
}


for (const m of joined) {
items.push({
id: m.community.id,
name: m.community.name,
imageUrl: m.community.imageUrl,
membersCount: m.community._count.members,
type: 'joined',
at: m.joinedAt
});
}


// Sort by recency (desc)
items.sort((a, b) => new Date(b.at) - new Date(a.at));


if (onlyRecent) {
const mostRecent = items[0] || null;
return res.json({ mostRecent });
}


// Paginate the full list
const total = items.length;
const paged = items.slice(skip, skip + take);


return res.json({ items: paged, total, skip, take });
} catch (err) {
console.error('getMyRecentCommunities error:', err);
return res.status(500).json({ error: 'Failed to load recent communities' });
}
};
// Get only the communities the user created and the ones they joined (separated)
exports.getMyCommunities = async (req, res) => {
  try {
    const userId = req.authData.id;

    const q = (req.query.q || '').trim();
    const take = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const skip = Math.max(parseInt(req.query.skip || '0', 10), 0);
    const scope = String(req.query.scope || '').toLowerCase(); // created / joined / all

    const nameFilter = q ? { name: { contains: q, mode: 'insensitive' } } : {};

    // --- Created ---
    const createdAll = await prisma.community.findMany({
      where: { creatorId: userId, ...nameFilter },
      orderBy: { id: 'desc' },
      include: {
        _count: { select: { members: true } },
        members: {
          where: { userId },
          select: { joinedAt: true },
          take: 1,
          orderBy: { joinedAt: 'desc' }
        }
      }
    });

    const created = createdAll.slice(skip, skip + take).map(c => ({
      id: c.id,
      name: c.name,
      imageUrl: c.imageUrl,
      membersCount: c._count.members,
      joinedAt: c.members?.[0]?.joinedAt ?? null,
      type: 'created',
      isCreator: true,
      isMember: true
    }));

    // --- Joined ---
    const joinedAll = await prisma.communityMember.findMany({
      where: {
        userId,
        community: {
          creatorId: { not: userId },
          ...nameFilter
        }
      },
      orderBy: { joinedAt: 'desc' },
      include: {
        community: { include: { _count: { select: { members: true } } } }
      }
    });

    const joined = joinedAll.slice(skip, skip + take).map(m => ({
      id: m.community.id,
      name: m.community.name,
      imageUrl: m.community.imageUrl,
      membersCount: m.community._count.members,
      joinedAt: m.joinedAt,
      type: 'joined',
      isCreator: false,
      isMember: true
    }));

    // --- Scope logic ---
    if (scope === 'created') {
      return res.json({
        items: created,
        total: createdAll.length,
        skip,
        take
      });
    } else if (scope === 'joined') {
      return res.json({
        items: joined,
        total: joinedAll.length,
        skip,
        take
      });
    } else {
      // default: both
      return res.json({
        created: { items: created, total: createdAll.length, skip, take },
        joined: { items: joined, total: joinedAll.length, skip, take }
      });
    }
  } catch (err) {
    console.error('getMyCommunities error:', err);
    return res.status(500).json({ error: 'Failed to load your communities' });
  }
};
