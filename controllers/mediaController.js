// controllers/mediaController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const path = require('path');
const fs = require('fs');

exports.uploadMedia = async (req, res) => {
  const userId = req.authData.id;
  const { receiverId, groupId, challengeId, type, postToStory } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const fileUrl = `/uploads/${req.file.filename}`;
  console.log('Received postToStory:', postToStory);

  const media = await prisma.media.create({
    data: {
      senderId: userId,
      fileUrl,
      type,
      receiverId: receiverId ? parseInt(receiverId) : null,
      groupId: groupId ? parseInt(groupId) : null,
      challengeId: challengeId ? parseInt(challengeId) : null,
    }
  });

  // ✅ Always save to story with visibility = profile (so friends can see)
  if ((postToStory + '').trim().toLowerCase() === 'true') {
    await prisma.story.create({
      data: {
        userId,
        mediaUrl: fileUrl,
        type,
        visibility: 'profile', // ✅ changed from 'private' to 'profile'
        isInVault: false
      }
    });
    console.log('✅ Story saved successfully');
  } else {
    console.log('⚠️ Skipped story save');
  }

  return res.json({ message: 'Media uploaded', media });
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
