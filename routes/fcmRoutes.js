// routes/fcmRoutes.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const { subscribeToChatTopic, subscribeAllMembersToChatTopic } = require('../utils/chatNotificationService');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Update user's FCM token and subscribe to all their chat topics
 * POST /api/fcm/token
 * Body: { fcmToken: string }
 */
router.post('/token', authMiddleware, async (req, res) => {
  try {
    const userId = req.authData.id;
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ message: 'FCM token is required' });
    }

    // Update FCM token in database
    await prisma.user.update({
      where: { id: userId },
      data: { fcmToken }
    });

    // Subscribe to all user's chat topics
    const userChats = await prisma.userOnChat.findMany({
      where: { userId },
      select: { chatId: true }
    });

    // Subscribe to all chat topics
    const subscriptionPromises = userChats.map(({ chatId }) => 
      subscribeToChatTopic(fcmToken, chatId)
    );

    await Promise.allSettled(subscriptionPromises);

    res.json({ 
      message: 'FCM token updated successfully',
      subscribedToChats: userChats.length
    });
  } catch (error) {
    console.error('Error updating FCM token:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * Subscribe to a specific chat topic
 * POST /api/fcm/subscribe/:chatId
 */
router.post('/subscribe/:chatId', authMiddleware, async (req, res) => {
  try {
    const userId = req.authData.id;
    const chatId = parseInt(req.params.chatId, 10);

    // Verify user is member of the chat
    const membership = await prisma.userOnChat.findFirst({
      where: { userId, chatId }
    });

    if (!membership) {
      return res.status(403).json({ message: 'You are not a member of this chat' });
    }

    // Get user's FCM token
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true }
    });

    if (!user?.fcmToken) {
      return res.status(400).json({ message: 'FCM token not found. Please update your token first.' });
    }

    await subscribeToChatTopic(user.fcmToken, chatId);

    res.json({ message: 'Successfully subscribed to chat notifications' });
  } catch (error) {
    console.error('Error subscribing to chat topic:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
