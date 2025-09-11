// utils/chatNotificationService.js
const admin = require('../firebaseAdmin');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Subscribe user to chat topic for real-time notifications
 * @param {string} fcmToken - User's FCM token
 * @param {number} chatId - Chat ID to subscribe to
 */
async function subscribeToChatTopic(fcmToken, chatId) {
  try {
    const topic = `chat_${chatId}`;
    await admin.messaging().subscribeToTopic([fcmToken], topic);
    console.log(`✅ User subscribed to topic: ${topic}`);
  } catch (error) {
    console.error('❌ Error subscribing to chat topic:', error);
    throw error;
  }
}

/**
 * Unsubscribe user from chat topic
 * @param {string} fcmToken - User's FCM token
 * @param {number} chatId - Chat ID to unsubscribe from
 */
async function unsubscribeFromChatTopic(fcmToken, chatId) {
  try {
    const topic = `chat_${chatId}`;
    await admin.messaging().unsubscribeFromTopic([fcmToken], topic);
    console.log(`✅ User unsubscribed from topic: ${topic}`);
  } catch (error) {
    console.error('❌ Error unsubscribing from chat topic:', error);
    throw error;
  }
}

/**
 * Send new message notification to chat topic
 * @param {number} chatId - Chat ID
 * @param {object} message - Message data
 * @param {object} sender - Sender data
 * @param {object} chat - Chat data
 */
async function notifyNewMessage(chatId, message, sender, chat) {
  try {
    const topic = `chat_${chatId}`;
    
    // Prepare notification data
    const notificationTitle = chat.isGroup 
      ? `${sender.username} in ${chat.name || 'Group Chat'}`
      : sender.username;
    
    const notificationBody = message.imageUrl 
      ? '📷 Photo' 
      : message.content || 'New message';

    const fcmMessage = {
      topic: topic,
      notification: {
        title: notificationTitle,
        body: notificationBody,
      },
      data: {
        type: 'new_message',
        chatId: String(chatId),
        messageId: String(message.id),
        senderId: String(sender.id),
        senderUsername: sender.username,
        isGroup: String(chat.isGroup),
        chatName: chat.name || '',
        imageUrl: message.imageUrl || '',
        timestamp: String(message.createdAt.getTime()),
      },
      android: {
        notification: {
          channelId: 'chat_messages',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: notificationTitle,
              body: notificationBody,
            },
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    await admin.messaging().send(fcmMessage);
    console.log(`✅ New message notification sent to topic: ${topic}`);
  } catch (error) {
    console.error('❌ Error sending new message notification:', error);
    throw error;
  }
}

/**
 * Send new chat created notification to user
 * @param {number} userId - User ID to notify
 * @param {object} chat - Chat data
 * @param {object} creator - Creator data
 */
async function notifyNewChat(userId, chat, creator) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true }
    });

    if (!user?.fcmToken) {
      console.log(`ℹ️ User ${userId} has no FCM token, skipping new chat notification`);
      return;
    }

    const notificationTitle = chat.isGroup 
      ? `New group: ${chat.name}`
      : `New chat with ${creator.username}`;
    
    const notificationBody = chat.isGroup
      ? `${creator.username} added you to a group chat`
      : 'You have a new chat';

    const fcmMessage = {
      token: user.fcmToken,
      notification: {
        title: notificationTitle,
        body: notificationBody,
      },
      data: {
        type: 'new_chat',
        chatId: String(chat.id),
        creatorId: String(creator.id),
        creatorUsername: creator.username,
        isGroup: String(chat.isGroup),
        chatName: chat.name || '',
        chatImageUrl: chat.imageUrl || '',
        timestamp: String(chat.createdAt.getTime()),
      },
      android: {
        notification: {
          channelId: 'new_chats',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: notificationTitle,
              body: notificationBody,
            },
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    await admin.messaging().send(fcmMessage);
    console.log(`✅ New chat notification sent to user: ${userId}`);

    // Also subscribe the user to the chat topic for future message notifications
    await subscribeToChatTopic(user.fcmToken, chat.id);
  } catch (error) {
    console.error('❌ Error sending new chat notification:', error);
    throw error;
  }
}

/**
 * Subscribe all chat members to chat topic when they join
 * @param {number} chatId - Chat ID
 */
async function subscribeAllMembersToChatTopic(chatId) {
  try {
    const chatMembers = await prisma.userOnChat.findMany({
      where: { chatId },
      include: {
        user: {
          select: { id: true, fcmToken: true }
        }
      }
    });

    const subscriptionPromises = chatMembers
      .filter(member => member.user.fcmToken)
      .map(member => subscribeToChatTopic(member.user.fcmToken, chatId));

    await Promise.allSettled(subscriptionPromises);
    console.log(`✅ All members subscribed to chat topic: chat_${chatId}`);
  } catch (error) {
    console.error('❌ Error subscribing all members to chat topic:', error);
    throw error;
  }
}

/**
 * Handle user leaving chat - unsubscribe from topic
 * @param {string} fcmToken - User's FCM token
 * @param {number} chatId - Chat ID
 */
async function handleUserLeaveChat(fcmToken, chatId) {
  try {
    if (fcmToken) {
      await unsubscribeFromChatTopic(fcmToken, chatId);
    }
  } catch (error) {
    console.error('❌ Error handling user leave chat:', error);
    throw error;
  }
}

module.exports = {
  subscribeToChatTopic,
  unsubscribeFromChatTopic,
  notifyNewMessage,
  notifyNewChat,
  subscribeAllMembersToChatTopic,
  handleUserLeaveChat,
};
