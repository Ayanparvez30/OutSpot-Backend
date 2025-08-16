
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const fs = require('fs');
const uploadToS3 = require('../utils/s3Upload'); 
const path = require('path');

exports.uploadMedia = async (req, res) => {
  const userId = req.authData.id;
  const { receiverId, groupId, challengeId, type, postToStory, communityId, latitude, longitude } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    
    const s3Url = await uploadToS3(req.file, 'media');

    const media = await prisma.media.create({
      data: {
        senderId: userId,
        fileUrl: s3Url,
        type,
        receiverId: receiverId ? parseInt(receiverId) : null,
        groupId: groupId ? parseInt(groupId) : null,
        challengeId: challengeId ? parseInt(challengeId) : null,
        communityId: communityId ? parseInt(communityId) : null,
      }
    });

    if ((postToStory + '').trim().toLowerCase() === 'true') {
      await prisma.story.create({
        data: {
          userId,
          mediaUrl: s3Url,
          type,
          visibility: 'profile',
          isInVault: false,
          latitude: parseFloat(latitude) || null,
          longitude: parseFloat(longitude) || null
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
          username: true
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

