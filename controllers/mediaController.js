
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const fs = require('fs');
const uploadToS3 = require('../utils/s3Upload'); 
const path = require('path');

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

    // 2) booleans / numbers
    const postToStoryBool = ((postToStory ?? '').toString().trim().toLowerCase() === 'true');
    const lat = Number.isFinite(parseFloat(latitude)) ? parseFloat(latitude) : null;
    const lng = Number.isFinite(parseFloat(longitude)) ? parseFloat(longitude) : null;

    // 3) upload
    const s3Url = await uploadToS3(req.file, 'media');

    // 4) save media
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

    // 5) (optional) story create with location
    if (postToStoryBool) {
      await prisma.story.create({
        data: {
          userId,
          mediaUrl: s3Url,
          type,              // must match Story.type enum
          visibility: 'profile',
          isInVault: false,
          latitude: lat,
          longitude: lng
        }
      });
      console.log('✅ Story saved successfully');
    } else {
      console.log('⚠️ Skipped story save');
    }

    return res.json({ message: 'Media uploaded', media });
  } catch (error) {
    console.error('Upload media error:', error);
    return res.status(500).json({ error: 'Failed to upload media' });
  }
};

exports.getStories = async (req, res) => {
  const userId = req.authData.id;
  console.log('Fetching stories for userId:', userId);

  const stories = await prisma.story.findMany({
    where: {
      OR: [
        { userId },
        {
          AND: [
            { visibility: 'profile' },
            { isInVault: false },
            {
              user: {
                OR: [
                  { friendRequestsSent: { some: { receiverId: userId, status: 'ACCEPTED' } } },
                  { friendRequestsReceived: { some: { requesterId: userId, status: 'ACCEPTED' } } }
                ]
              }
            }
          ]
        }
      ]
    },
    include: {
      user: {
        select: {
          id: true,
          username: true,
        minime: {
              select: { avatarUrl: true }, 
              where: { isSaved: true }
            }
        }
      }
    },
    orderBy: {
      createdAt: 'desc'
    }
  });

  console.log('Stories found:', stories.length);
  res.json({ stories });
};

exports.debugAllStories = async (req, res) => {
  const stories = await prisma.story.findMany({
    include: {
      user: true
    }
  });
  res.json(stories);
};

exports.saveToProfile = async (req, res) => {
  const userId = req.authData.id;
  const { storyId } = req.body;

  await prisma.story.update({
    where: { id: storyId, userId },
    data: { visibility: 'profile' }
  });

  res.json({ message: 'Story saved to profile.' });
};

exports.saveToVault = async (req, res) => {
  const userId = req.authData.id;
  const { storyId } = req.body;

  await prisma.story.update({
    where: { id: storyId, userId },
    data: { isInVault: true }
  });

  res.json({ message: 'Story saved to vault.' });
};

exports.getVaultStories = async (req, res) => {
  const userId = req.authData.id;

  const vaultStories = await prisma.story.findMany({
    where: {
      userId,
      isInVault: true
    },
    include: {
      user: {
        select: {
          id: true,
          username: true
        }
      }
    },
    orderBy: {
      createdAt: 'desc'
    }
  });

  res.json({ vault: vaultStories });
};

exports.removeStory = async (req, res) => {
  const userId = req.authData.id;
  const { storyId } = req.params;

  const story = await prisma.story.findUnique({ where: { id: parseInt(storyId) } });
  if (!story || story.userId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  await prisma.story.delete({ where: { id: story.id } });
  res.json({ message: 'Story removed successfully.' });
};

