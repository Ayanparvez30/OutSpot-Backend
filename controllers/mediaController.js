const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const uploadToS3 = require('../utils/s3Upload'); 
const path = require('path');


const STORY_TTL_MINUTES = Number(
  process.env.STORY_TTL_MINUTES || (process.env.NODE_ENV === 'development' ? 5 : 24 * 60)
);

exports.uploadMedia = async (req, res) => {
  const userId = req.authData.id;
  let { receiverId, groupId, challengeId, type, postToStory, communityId, latitude, longitude } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    type = (type || '').toString().trim().toUpperCase();
    const ALLOWED = new Set(['IMAGE', 'VIDEO']);
    if (!ALLOWED.has(type)) {
      return res.status(400).json({ error: "Invalid 'type'. Use IMAGE or VIDEO" });
    }

    const postToStoryBool = ((postToStory ?? '').toString().trim().toLowerCase() === 'true');
    const lat = Number.isFinite(parseFloat(latitude)) ? parseFloat(latitude) : null;
    const lng = Number.isFinite(parseFloat(longitude)) ? parseFloat(longitude) : null;

    const s3Url = await uploadToS3(req.file, 'media');

    const media = await prisma.media.create({
      data: {
        senderId: userId,
        fileUrl: s3Url,
        type, 
        receiverId: receiverId ? parseInt(receiverId, 10) : null,
        groupId: groupId ? parseInt(groupId, 10) : null,
        challengeId: challengeId ? parseInt(challengeId, 10) : null,
        communityId: communityId ? parseInt(communityId, 10) : null,
      }
    });

    if (postToStoryBool) {
      await prisma.story.create({
        data: {
          userId,
          mediaUrl: s3Url,
          type,
          visibility: 'profile',
          status: 'ACTIVE',
          latitude: lat,
          longitude: lng
        }
      });
    }

    return res.json({ message: 'Media uploaded', media });
  } catch (error) {
    console.error('Upload media error:', error);
    return res.status(500).json({ error: 'Failed to upload media' });
  }
};

exports.saveToProfile = async (req, res) => {
  const authenticatedUserId = req.authData.id;
  const { storyId } = req.body;

  try {
    const story = await prisma.story.findUnique({
      where: { id: storyId },
      include: {
        user: {
          select: {
            id: true,
            friendRequestsSent: true,
            friendRequestsReceived: true,
            username: true
          }
        }
      }
    });
    if (!story) return res.status(404).json({ error: 'Story not found' });

    const isOwner = story.userId === authenticatedUserId;
    const isFriend =
      story.user.friendRequestsSent?.some(r => r.receiverId === authenticatedUserId && r.status === 'ACCEPTED') ||
      story.user.friendRequestsReceived?.some(r => r.requesterId === authenticatedUserId && r.status === 'ACCEPTED');

    if (!isOwner && !(isFriend && story.visibility === 'profile')) {
      return res.status(403).json({ error: 'You can only save your own stories or friends’ profile-visible stories' });
    }

    const existingSaved = await prisma.savedStory.findUnique({
      where: {
        userId_storyId_status: {
          userId: authenticatedUserId,
          storyId,
          status: 'SAVED'
        }
      }
    });
    if (existingSaved) return res.status(400).json({ error: 'Already saved to profile' });

    const savedStory = await prisma.savedStory.create({
      data: { userId: authenticatedUserId, storyId, status: 'SAVED' }
    });

    res.json({
      message: `Saved to your profile.`,
      savedStory
    });
  } catch (error) {
    console.error('Error saving story to profile:', error);
    res.status(500).json({ error: 'Failed to save story to profile' });
  }
};

exports.getSavedStories = async (req, res) => {
  const requesterId = req.authData.id;
  const { targetUserId } = req.query;
  const uid = targetUserId ? parseInt(targetUserId, 10) : requesterId;

  try {
    // target user info + privacy
    const targetUser = await prisma.user.findUnique({
      where: { id: uid },
      select: { id: true, isProfilePrivate: true }
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
            { requesterId: uid, receiverId: requesterId }
          ]
        }
      });
      isFriend = Boolean(friendship);
    }

    // profile privacy gate
    if (!isOwner && targetUser.isProfilePrivate && !isFriend) {
      return res.status(403).json({ error: 'This profile is private' });
    }

    // owner sees all SAVED; others only those whose story.visibility = 'profile' and not VAULT
    const savedStories = await prisma.savedStory.findMany({
      where: {
        userId: uid,
        status: 'SAVED',
        ...(isOwner
          ? {}
          : {
              story: {
                visibility: 'profile',
                NOT: { status: 'VAULT' }
              }
            })
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
                
                  orderBy: { updatedAt: 'desc' }
                }
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const stories = savedStories.map(s => {
      const u = s.story.user;
      const avatarUrl =
        Array.isArray(u.minime) && u.minime.length > 0 ? u.minime[0]?.avatarUrl || null : null;

      return {
        ...s.story,
        user: {
          id: u.id,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          avatarUrl
        }
      };
    });

    res.json({ savedStories: stories });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch saved stories' });
  }
};

exports.saveToVault = async (req, res) => {
  const userId = req.authData.id;
  const { storyId } = req.body;

  try {
    const story = await prisma.story.findUnique({
      where: { id: storyId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            friendRequestsSent: true,
            friendRequestsReceived: true
          }
        }
      }
    });
    if (!story) return res.status(404).json({ error: 'Story not found' });

    const isOwner = story.userId === userId;
    const isFriend =
      story.user.friendRequestsSent?.some(r => r.receiverId === userId && r.status === 'ACCEPTED') ||
      story.user.friendRequestsReceived?.some(r => r.requesterId === userId && r.status === 'ACCEPTED');

    if (!isOwner && !(isFriend && story.visibility === 'profile')) {
      return res.status(403).json({ error: 'You do not have permission to save this story to your vault' });
    }

    const existingVaultStory = await prisma.savedStory.findUnique({
      where: {
        userId_storyId_status: {
          userId,
          storyId,
          status: 'VAULT'
        }
      }
    });
    if (existingVaultStory) return res.status(400).json({ error: 'Already saved to vault' });

    const savedStory = await prisma.savedStory.create({
      data: { userId, storyId, status: 'VAULT' }
    });

    res.json({
      message: `Saved to your vault`,
      savedStory
    });
  } catch (error) {
    console.error('Error saving story to vault:', error);
    res.status(500).json({ error: 'Failed to save story to vault' });
  }
};

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
                minime: { select: { avatarUrl: true }, orderBy: { updatedAt: 'desc' } } 
              } 
            } 
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ vaultStories: vaultStories.map(s => s.story) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch vault stories' });
  }
};

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
    console.error('Error removing story:', error);
    res.status(500).json({ error: 'Failed to remove story' });
  }
};
// controllers/mediaController.js → replace only this handler
exports.getStories = async (req, res) => {
  const userId = req.authData.id;

  // TTL minutes for feed window (dev: 5, prod: 24h)
  const STORY_TTL_MINUTES = Number(
    process.env.STORY_TTL_MINUTES || (process.env.NODE_ENV === 'development' ? 5 : 24 * 60)
  );
  const windowAgo = new Date(Date.now() - STORY_TTL_MINUTES * 60 * 1000);

  try {
    // 1) Find all communities the requester belongs to
    const myCommunities = await prisma.communityMember.findMany({
      where: { userId },
      select: { communityId: true }
    });
    const communityIds = myCommunities.map(c => c.communityId);
    const hasCommunities = communityIds.length > 0;

    // 2) Build friend condition (either direction, ACCEPTED)
    const friendOR = [
      { friendRequestsSent:     { some: { receiverId: userId,  status: 'ACCEPTED' } } },
      { friendRequestsReceived: { some: { requesterId: userId, status: 'ACCEPTED' } } }
    ];

    // 3) Build same-community condition (optional if you’re in any)
    const sameCommunityCond = hasCommunities
      ? { communities: { some: { communityId: { in: communityIds } } } }
      : undefined;

    // 4) Exclude blocked users (either direction)
    const notBlocked = {
      NOT: [
        { user: { blockedBy: { some: { blockerId: userId } } } }, // I blocked them
        { user: { blocks:    { some: { blockedId: userId } } } }  // They blocked me
      ]
    };

    // 5) Query stories
    const stories = await prisma.story.findMany({
      where: {
        status: 'ACTIVE',
        createdAt: { gte: windowAgo },
        ...notBlocked,
        OR: [
          // a) my own stories (always show)
          { userId },

          // b) friends' profile-visible stories
          {
            visibility: 'profile',
            user: { OR: friendOR }
          },

          // c) same-community users' profile-visible stories
          ...(hasCommunities ? [{
            visibility: 'profile',
            user: sameCommunityCond
          }] : [])
        ]
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            // latest saved avatar only
            minime: { select: { avatarUrl: true }, take: 1, orderBy: { updatedAt: 'desc' } },
            Location: { select: { latitude: true, longitude: true } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ stories });
  } catch (error) {
    console.error('Error fetching stories:', error);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
};
