// controllers/mediaController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const uploadToS3 = require('../utils/s3Upload');

// Socket (optional)
let getIO;
try { ({ getIO } = require('../utils/socket')); } catch (_) { /* no-op */ }

// -------------------- helpers --------------------
const toBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
};

const parseIdArray = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  if (typeof v === 'string') {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.map(Number).filter(Number.isFinite);
    } catch (_) { /* fallthrough to CSV */ }
    return v
      .split(',')
      .map((s) => Number(String(s).trim()))
      .filter(Number.isFinite);
  }
  return [];
};

const firstAvatar = (minimeArr) =>
  Array.isArray(minimeArr) && minimeArr.length > 0
    ? (minimeArr[0]?.avatarUrl || null)
    : null;

const normalizeType = (raw) => (String(raw || 'IMAGE').toUpperCase() === 'VIDEO' ? 'VIDEO' : 'IMAGE');
const normalizeVisibility = (raw) =>
  (String(raw || 'profile').toLowerCase() === 'private' ? 'private' : 'profile');

// ==================================================
// uploadMedia: single upload → optional Story + optional Chats
// ==================================================
exports.uploadMedia = async (req, res) => {
  const userId = req?.authData?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  let { chatIds, chatId, type, postToStory, latitude, longitude, visibility } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Validate type
  type = normalizeType(type);

  // Targets
  const chats = [...new Set(parseIdArray(chatIds || chatId))];
  const sendToChats = chats.length > 0;
  const alsoStory = toBool(postToStory);

  // Optional geo (Story supports; Message does NOT)
  const lat = latitude != null && latitude !== '' ? Number(latitude) : null;
  const lon = longitude != null && longitude !== '' ? Number(longitude) : null;

  try {
    // 1) Upload once → S3 URL
    const publicUrl = await uploadToS3(req.file, `users/${userId}/media`);

    // 2) Membership check only if sending to chats
    if (sendToChats) {
      const membership = await prisma.userOnChat.findMany({
        where: { chatId: { in: chats }, userId },
        select: { chatId: true },
      });
      const allowed = new Set(membership.map((m) => m.chatId));
      const invalid = chats.filter((id) => !allowed.has(id));
      if (invalid.length) {
        return res.status(403).json({
          error: 'You are not a member of some chats',
          invalidChatIds: invalid,
        });
      }
    }

    // 3) Build ops (optional story, N chat messages)
    const ops = [];
    let storyIdx = -1;

    if (alsoStory) {
      const storyVisibility = normalizeVisibility(visibility);
      const storyData = {
        userId,
        mediaUrl: publicUrl,
        type,
        visibility: storyVisibility,
        status: 'ACTIVE',
        latitude: lat ?? null,
        longitude: lon ?? null,
      };
      storyIdx = ops.push(prisma.story.create({ data: storyData })) - 1;
    }

    if (sendToChats) {
      for (const cid of chats) {
        ops.push(
          prisma.message.create({
            data: { chatId: cid, senderId: userId, content: null, imageUrl: publicUrl },
            include: { sender: { select: { id: true, username: true } } },
          })
        );
      }
    }

    // 4) Commit + emit socket events for created messages
    const results = ops.length ? await prisma.$transaction(ops) : [];
    const story = storyIdx > -1 ? results[storyIdx] : null;

    const createdMessages = results
      .filter((r) => r && typeof r.chatId === 'number')
      .map((m) => ({
        id: m.id,
        chatId: m.chatId,
        content: m.content,
        imageUrl: m.imageUrl,
        createdAt: m.createdAt,
        sender: m.sender ? { id: m.sender.id, username: m.sender.username } : { id: userId },
      }));

    try {
      const io = typeof getIO === 'function' ? getIO() : req.app?.get('io');
      if (io && createdMessages.length) {
        for (const m of createdMessages) io.to(`chat_${m.chatId}`).emit('newMessage', m);
      }
    } catch (e) {
      console.error('Socket emit failed', e);
    }

    // 5) Response
    let mode = 'uploaded-only';
    if (alsoStory && sendToChats) mode = 'story+chats';
    else if (alsoStory) mode = 'story';
    else if (sendToChats) mode = 'chats';

    return res.json({
      message: 'Media processed successfully',
      mode,
      fileUrl: publicUrl,
      story: story || null,
      messages: createdMessages,
      sentToChats: sendToChats ? chats : [],
    });
  } catch (err) {
    console.error('uploadMedia error', err);
    return res.status(500).json({ error: 'Upload failed', details: err.message });
  }
};

// ==================================================
// saveToProfile: save existing/URL story to profile (SAVED)
// ==================================================
exports.saveToProfile = async (req, res) => {
  const authenticatedUserId = req.authData.id;
  let { storyId, imageUrl, type = 'IMAGE', visibility = 'profile', latitude, longitude } = req.body;

  try {
    let story = null;

    if (!storyId && !imageUrl) {
      return res.status(400).json({ error: 'Provide either storyId or imageUrl' });
    }

    // Path A: save by imageUrl (create/find my SAVED story)
    if (imageUrl) {
      type = normalizeType(type);
      const vis = normalizeVisibility(visibility);

      story = await prisma.story.findFirst({
        where: { userId: authenticatedUserId, mediaUrl: imageUrl, status: 'SAVED' },
      });

      if (!story) {
        story = await prisma.story.create({
          data: {
            userId: authenticatedUserId,
            mediaUrl: imageUrl,
            type,
            visibility: vis,
            status: 'SAVED', // not shown in feed
            latitude: latitude != null ? Number(latitude) : null,
            longitude: longitude != null ? Number(longitude) : null,
          },
        });
      }
      storyId = story.id;
    }

    // Path B: save by storyId (permission check)
    if (!story) {
      story = await prisma.story.findUnique({
        where: { id: Number(storyId) },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              friendRequestsSent: true,
              friendRequestsReceived: true,
            },
          },
        },
      });
      if (!story) return res.status(404).json({ error: 'Story not found' });

      const isOwner = story.userId === authenticatedUserId;
      const isFriend =
        story.user.friendRequestsSent?.some(
          (r) => r.receiverId === authenticatedUserId && r.status === 'ACCEPTED'
        ) ||
        story.user.friendRequestsReceived?.some(
          (r) => r.requesterId === authenticatedUserId && r.status === 'ACCEPTED'
        );

      if (!isOwner && !(isFriend && story.visibility === 'profile')) {
        return res
          .status(403)
          .json({ error: 'You can only save your own stories or friends’ profile-visible stories' });
      }
    }

    // Prevent duplicate save row
    const existingSaved = await prisma.savedStory.findUnique({
      where: {
        userId_storyId_status: { userId: authenticatedUserId, storyId: story.id, status: 'SAVED' },
      },
    });
    if (existingSaved) return res.status(400).json({ error: 'Already saved to profile' });

    const savedStory = await prisma.savedStory.create({
      data: { userId: authenticatedUserId, storyId: story.id, status: 'SAVED' },
    });

    return res.json({
      message: 'Saved to your profile.',
      story, // status: SAVED
      savedStory,
    });
  } catch (error) {
    console.error('Error saving story to profile:', error);
    return res.status(500).json({ error: 'Failed to save story to profile' });
  }
};

// ==================================================
// getSavedStories: view saved (SAVED) by self or (if public/friend) others
// ==================================================
exports.getSavedStories = async (req, res) => {
  const requesterId = req.authData.id;
  const { targetUserId } = req.query;
  const uid = targetUserId ? parseInt(targetUserId, 10) : requesterId;

  try {
    const targetUser = await prisma.user.findUnique({
      where: { id: uid },
      select: { id: true, isProfilePrivate: true },
    });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const isOwner = uid === requesterId;

    // are they friends?
    let isFriend = false;
    if (!isOwner) {
      const friendship = await prisma.friendship.findFirst({
        where: {
          status: 'ACCEPTED',
          OR: [
            { requesterId: requesterId, receiverId: uid },
            { requesterId: uid, receiverId: requesterId },
          ],
        },
      });
      isFriend = Boolean(friendship);
    }

    // profile privacy gate
    if (!isOwner && targetUser.isProfilePrivate && !isFriend) {
      return res.status(403).json({ error: 'This profile is private' });
    }

    // owner sees all SAVED; others: only visibility=profile and not VAULT
    const savedStories = await prisma.savedStory.findMany({
      where: {
        userId: uid,
        status: 'SAVED',
        ...(isOwner
          ? {}
          : {
              story: {
                visibility: 'profile',
                NOT: { status: 'VAULT' },
              },
            }),
      },
      include: {
        story: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                minime: {
                  where: { isSaved: true },
                  select: { avatarUrl: true },
                  orderBy: { updatedAt: 'desc' },
                  take: 1,
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const stories = savedStories.map((s) => {
      const u = s.story.user;
      const avatarUrl = firstAvatar(u.minime);
      return {
        ...s.story,
        user: {
          id: u.id,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          avatarUrl,
        },
      };
    });

    res.json({ savedStories: stories });
  } catch (error) {
    console.error('getSavedStories error:', error);
    res.status(500).json({ error: 'Failed to fetch saved stories' });
  }
};

// ==================================================
// saveToVault: save existing/URL story to vault (VAULT)
// ==================================================
exports.saveToVault = async (req, res) => {
  const userId = req.authData.id;
  let { storyId, imageUrl, type = 'IMAGE', visibility = 'profile', latitude, longitude } = req.body;

  try {
    let story = null;

    if (!storyId && !imageUrl) {
      return res.status(400).json({ error: 'Provide either storyId or imageUrl' });
    }

    // Path A: vault by imageUrl → create/find my VAULT story
    if (imageUrl) {
      type = normalizeType(type);
      const vis = normalizeVisibility(visibility);

      story = await prisma.story.findFirst({
        where: { userId, mediaUrl: imageUrl, status: 'VAULT' },
      });

      if (!story) {
        story = await prisma.story.create({
          data: {
            userId,
            mediaUrl: imageUrl,
            type,
            visibility: vis,
            status: 'VAULT', // not in feed
            latitude: latitude != null ? Number(latitude) : null,
            longitude: longitude != null ? Number(longitude) : null,
          },
        });
      }
      storyId = story.id;
    }

    // Path B: vault by storyId (permission check)
    if (!story) {
      story = await prisma.story.findUnique({
        where: { id: Number(storyId) },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              friendRequestsSent: true,
              friendRequestsReceived: true,
            },
          },
        },
      });
      if (!story) return res.status(404).json({ error: 'Story not found' });

      const isOwner = story.userId === userId;
      const isFriend =
        story.user.friendRequestsSent?.some(
          (r) => r.receiverId === userId && r.status === 'ACCEPTED'
        ) ||
        story.user.friendRequestsReceived?.some(
          (r) => r.requesterId === userId && r.status === 'ACCEPTED'
        );

      if (!isOwner && !(isFriend && story.visibility === 'profile')) {
        return res
          .status(403)
          .json({ error: 'You do not have permission to save this story to your vault' });
      }
    }

    // Prevent duplicate vault save
    const existingVaultStory = await prisma.savedStory.findUnique({
      where: { userId_storyId_status: { userId, storyId: story.id, status: 'VAULT' } },
    });
    if (existingVaultStory) return res.status(400).json({ error: 'Already saved to vault' });

    const savedStory = await prisma.savedStory.create({
      data: { userId, storyId: story.id, status: 'VAULT' },
    });

    return res.json({
      message: 'Saved to your vault',
      story, // status: VAULT
      savedStory,
    });
  } catch (error) {
    console.error('saveToVault error:', error);
    return res.status(500).json({ error: 'Failed to save story to vault' });
  }
};

// ==================================================
// getVaultStories: list my VAULT stories
// ==================================================
exports.getVaultStories = async (req, res) => {
  const userId = req.authData.id;

  try {
    const vaultStories = await prisma.savedStory.findMany({
      where: { userId, status: 'VAULT' },
      include: {
        story: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                username: true,
                minime: {
                  select: { avatarUrl: true },
                  orderBy: { updatedAt: 'desc' },
                  take: 1,
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      vaultStories: vaultStories.map((s) => {
        const u = s.story.user;
        return {
          ...s.story,
          user: {
            id: u.id,
            username: u.username,
            firstName: u.firstName,
            lastName: u.lastName,
            avatarUrl: firstAvatar(u.minime),
          },
        };
      }),
    });
  } catch (error) {
    console.error('getVaultStories error:', error);
    res.status(500).json({ error: 'Failed to fetch vault stories' });
  }
};

// ==================================================
// removeStory: delete my story (+ cascade saved rows)
// ==================================================
exports.removeStory = async (req, res) => {
  const userId = req.authData.id;
  const { storyId } = req.params;

  try {
    const story = await prisma.story.findUnique({ where: { id: parseInt(storyId, 10) } });
    if (!story || story.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Delete dependent SavedStory rows first to avoid FK issues
    await prisma.savedStory.deleteMany({ where: { storyId: story.id } });
    await prisma.story.delete({ where: { id: story.id } });

    res.json({ message: 'Story removed successfully.' });
  } catch (error) {
    console.error('removeStory error:', error);
    res.status(500).json({ error: 'Failed to remove story' });
  }
};


exports.getStories = async (req, res) => {
  const userId = req.authData.id;

  // TTL minutes for feed window (dev: 5, prod: 24h)
  const STORY_TTL_MINUTES = Number(
    process.env.STORY_TTL_MINUTES ||
      (process.env.NODE_ENV === 'development' ? 5 : 24 * 60)
  );
  const windowAgo = new Date(Date.now() - STORY_TTL_MINUTES * 60 * 1000);

  try {
    // 1) Requester communities
    const myCommunities = await prisma.communityMember.findMany({
      where: { userId },
      select: { communityId: true },
    });
    const communityIds = myCommunities.map((c) => c.communityId);
    const hasCommunities = communityIds.length > 0;

    // 2) Friend condition (either direction, ACCEPTED)
    const friendOR = [
      { friendRequestsSent: { some: { receiverId: userId, status: 'ACCEPTED' } } },
      { friendRequestsReceived: { some: { requesterId: userId, status: 'ACCEPTED' } } },
    ];

    // 3) Same-community condition
    const sameCommunityCond = hasCommunities
      ? { communities: { some: { communityId: { in: communityIds } } } }
      : undefined;

    // 4) Exclude blocked
    const notBlocked = {
      NOT: [
        { user: { blockedBy: { some: { blockerId: userId } } } }, // I blocked them
        { user: { blocks: { some: { blockedId: userId } } } }, // They blocked me
      ],
    };

    // 5) Query
    const stories = await prisma.story.findMany({
      where: {
        status: 'ACTIVE',
        createdAt: { gte: windowAgo },
        ...notBlocked,
        OR: [
          { userId }, // my own
          { visibility: 'profile', user: { OR: friendOR } }, // friends
          ...(hasCommunities
            ? [{ visibility: 'profile', user: sameCommunityCond }]
            : []),
        ],
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            minime: { select: { avatarUrl: true }, take: 1, orderBy: { updatedAt: 'desc' } },
            Location: { select: { latitude: true, longitude: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const payload = stories.map((s) => {
      const u = s.user;
      return {
        ...s,
        user: {
          id: u.id,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          avatarUrl: firstAvatar(u.minime),
          // optional: include current location if consumer needs it
          Location: u.Location,
        },
      };
    });

    res.json({ stories: payload });
  } catch (error) {
    console.error('getStories error:', error);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
};
// GET /api/stories/feed?filter=all|friends|communities&ttlMinutes=1440&includeSelf=true|false
exports.getStoriesFeed = async (req, res) => {
  const userId = req.authData.id;
  const filterRaw = (req.query.filter || 'all').toString().toLowerCase();
  const FILTER = ['all','friends','communities'].includes(filterRaw) ? filterRaw : 'all';

  // TTL (minutes)
  const ttlParam = Number(req.query.ttlMinutes);
  const STORY_TTL_MINUTES = Number.isFinite(ttlParam) && ttlParam > 0
    ? ttlParam
    : Number(process.env.STORY_TTL_MINUTES || (24 * 60));

  // includeSelf override (default false)
  const includeSelf = String(req.query.includeSelf || 'false').toLowerCase() === 'true';

  const windowAgo = new Date(Date.now() - STORY_TTL_MINUTES * 60 * 1000);

  try {
    // আমার কমিউনিটিস
    const myMemberships = await prisma.communityMember.findMany({
      where: { userId },
      include: { community: { select: { id: true, name: true, imageUrl: true } } },
    });
    const myCommunities = myMemberships.map(m => ({
      id: m.communityId,
      name: m.community.name,
      imageUrl: m.community.imageUrl || null,
    }));
    const myCommunityIds = myCommunities.map(c => c.id);
    const hasCommunities = myCommunityIds.length > 0;

    // বন্ধুদের আইডি
    const friendLinks = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: userId }, { receiverId: userId }],
      },
      select: { requesterId: true, receiverId: true },
    });
    const friendIds = new Set(
      friendLinks.map(l => (l.requesterId === userId ? l.receiverId : l.requesterId))
    );

    // Block exclusion
    const notBlocked = {
      NOT: [
        { user: { blockedBy: { some: { blockerId: userId } } } }, // I blocked them
        { user: { blocks: { some: { blockedId: userId } } } },    // They blocked me
      ],
    };

    // OR conditions by filter
    const orConds = [];

    // ✅ নিজেরটা ডিফল্টে বাদ; includeSelf=true হলে দেই
    if (includeSelf) {
      orConds.push({ userId });
    }

    // friends
    if (FILTER === 'all' || FILTER === 'friends') {
      if (friendIds.size) {
        orConds.push({
          visibility: 'profile',
          userId: { in: Array.from(friendIds) },
        });
      }
    }

    // communities (public profiles only, same communities)
    if ((FILTER === 'all' || FILTER === 'communities') && hasCommunities) {
      orConds.push({
        visibility: 'profile',
        userId: includeSelf ? undefined : { not: userId }, // নিজেরটা না চাইলে বাদ
        user: {
          isProfilePrivate: false,
          communities: { some: { communityId: { in: myCommunityIds } } },
        },
      });
    }

    if (orConds.length === 0) {
      return res.json({
        filter: FILTER,
        stories: [],
        communitiesGrouped: [],
        myCommunities,
      });
    }

    // fetch
    const stories = await prisma.story.findMany({
      where: {
        status: 'ACTIVE',
        createdAt: { gte: windowAgo },
        ...notBlocked,
        OR: orConds,
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            isProfilePrivate: true,
            minime: { select: { avatarUrl: true }, take: 1, orderBy: { updatedAt: 'desc' } },
            Location: { select: { latitude: true, longitude: true } },
            // overlapping communities with me (for grouping)
            communities: hasCommunities
              ? {
                  where: { communityId: { in: myCommunityIds } },
                  include: { community: { select: { id: true, name: true, imageUrl: true } } },
                }
              : false,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // payload (flat)
    const flat = stories.map((s) => {
      const u = s.user;
      const avatarUrl =
        Array.isArray(u.minime) && u.minime.length ? (u.minime[0]?.avatarUrl || null) : null;

      const overlapCommunities = Array.isArray(u.communities)
        ? u.communities.map(cm => ({
            id: cm.community.id,
            name: cm.community.name,
            imageUrl: cm.community.imageUrl || null,
          }))
        : [];

      return {
        id: s.id,
        mediaUrl: s.mediaUrl,
        type: s.type,
        visibility: s.visibility,
        status: s.status,
        createdAt: s.createdAt,
        latitude: s.latitude,
        longitude: s.longitude,
        user: {
          id: u.id,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          isProfilePrivate: u.isProfilePrivate,
          avatarUrl,
          Location: u.Location || null,
        },
        communityNames: overlapCommunities.map(c => c.name),
        communities: overlapCommunities,
      };
    });

   
    const groupMap = new Map(); 
    for (const item of flat) {
      for (const cm of item.communities) {
        if (!groupMap.has(cm.id)) {
          groupMap.set(cm.id, { community: cm, stories: [] });
        }
        groupMap.get(cm.id).stories.push(item);
      }
    }
  
    const communitiesGrouped = myCommunities
      .filter(c => groupMap.has(c.id))
      .map(c => ({
        community: groupMap.get(c.id).community,
        stories: groupMap.get(c.id).stories,
      }))
      // যদি এমন কমিউনিটি থাকে যা আমার কমিউনিটি তালিকায় নেই (edge), তাও যোগ করি
      .concat(
        Array.from(groupMap.values()).filter(g => !myCommunityIds.includes(g.community.id))
      );

    console.log('[StoriesFeed]', {
      userId,
      FILTER,
      ttlMinutes: STORY_TTL_MINUTES,
      includeSelf,
      friendCount: friendIds.size,
      myCommunityCount: myCommunityIds.length,
      returnedFlat: flat.length,
      groupedCount: communitiesGrouped.length,
    });

    return res.json({
      filter: FILTER,
      stories: flat,           
      communitiesGrouped,     
      myCommunities,              
    });
  } catch (error) {
    console.error('getStoriesFeed error:', error);
    return res.status(500).json({ error: 'Failed to fetch stories feed' });
  }
};

// ==================================================
// getMyStories: my ACTIVE stories within TTL
// ==================================================
exports.getMyStories = async (req, res) => {
  const userId = req.authData.id;

  const MY_STORY_TTL_MINUTES = Number(process.env.MY_STORY_TTL_MINUTES || 24 * 60);
  const windowAgo = new Date(Date.now() - MY_STORY_TTL_MINUTES * 60 * 1000);

  try {
    const stories = await prisma.story.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        createdAt: { gte: windowAgo },
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            minime: { select: { avatarUrl: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
            Location: { select: { latitude: true, longitude: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const myStories = stories.map((s) => {
      const u = s.user;
      return {
        ...s,
        user: {
          id: u.id,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          avatarUrl: firstAvatar(u.minime),
        },
      };
    });

    return res.json({ stories: myStories });
  } catch (error) {
    console.error('getMyStories error:', error);
    return res.status(500).json({ error: 'Failed to fetch your stories' });
  }
};
