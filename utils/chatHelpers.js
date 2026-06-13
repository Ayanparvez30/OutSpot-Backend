// utils/chatHelpers.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Calculate accurate unread count for a user in a chat
 * @param {number} userId 
 * @param {number} chatId 
 * @returns {Promise<number>}
 */
async function getUnreadCount(userId, chatId) {
  try {
    // Get user's last seen message ID
    const userInChat = await prisma.userOnChat.findFirst({
      where: { userId, chatId },
      select: { lastSeenMessageId: true },
    });

    if (!userInChat) return 0;

    const lastSeenMessageId = userInChat.lastSeenMessageId || 0;

    // Count messages newer than last seen
    const unreadCount = await prisma.message.count({
      where: {
        chatId,
        id: { gt: lastSeenMessageId },
      },
    });

    return unreadCount;
  } catch (error) {
    console.error('Error calculating unread count:', error);
    return 0;
  }
}

/**
 * Get unread counts for multiple chats for a user
 * @param {number} userId 
 * @param {number[]} chatIds 
 * @returns {Promise<Map<number, number>>}
 */
async function getBulkUnreadCounts(userId, chatIds) {
  try {
    if (!chatIds.length) return new Map();

    // Get all user's lastSeenMessageId for these chats
    const userChats = await prisma.userOnChat.findMany({
      where: { 
        userId, 
        chatId: { in: chatIds } 
      },
      select: { chatId: true, lastSeenMessageId: true },
    });

    const lastSeenMap = new Map(
      userChats.map(uc => [uc.chatId, uc.lastSeenMessageId || 0])
    );

    // For each chat, count unread messages
    const unreadCounts = new Map();
    
    for (const chatId of chatIds) {
      const lastSeenMessageId = lastSeenMap.get(chatId) || 0;
      
      const count = await prisma.message.count({
        where: {
          chatId,
          id: { gt: lastSeenMessageId },
        },
      });
      
      unreadCounts.set(chatId, count);
      
      // Debug logging for specific chat if it has unread messages
      if (count > 0) {
        console.log(`🔍 Chat ${chatId} unread count for user ${userId}:`, {
          lastSeenMessageId,
          unreadCount: count,
          query: { chatId, 'id > ': lastSeenMessageId }
        });
      }
    }

    return unreadCounts;
  } catch (error) {
    console.error('Error calculating bulk unread counts:', error);
    return new Map();
  }
}

/**
 * Chat-based read receipt: Mark entire chat as read
 * @param {number} userId 
 * @param {number} chatId 
 * @returns {Promise<boolean>}
 */
async function markChatAsRead(userId, chatId) {
  try {
    // Get the latest message in this chat
    const latestMessage = await prisma.message.findFirst({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    });

    if (!latestMessage) {
      console.log(`No messages found in chat ${chatId}, nothing to mark as read`);
      return true; // No messages to mark as read
    }

    // Snapshot prev lastSeen BEFORE bump so we can scope the timer stamp.
    const prevRow = await prisma.userOnChat.findFirst({
      where: { userId, chatId },
      select: { lastSeenMessageId: true },
    });
    const prevLastSeen = prevRow?.lastSeenMessageId || 0;

    // Update user's lastSeenMessageId to the latest message
    await prisma.userOnChat.updateMany({
      where: { userId, chatId },
      data: { lastSeenMessageId: latestMessage.id }
    });

    // Receiver-view-triggered countdown for timed disappearing modes.
    // Idempotent: `expiresAt: null` guard means re-reads don't reset the timer.
    try {
      const chatRow = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { disappearingSeconds: true },
      });
      const sec = chatRow?.disappearingSeconds || 0;
      if (sec > 1 && latestMessage.id > prevLastSeen) {
        await prisma.message.updateMany({
          where: {
            chatId,
            senderId: { not: userId },
            id: { gt: prevLastSeen, lte: latestMessage.id },
            expiresAt: null,
          },
          data: { expiresAt: new Date(Date.now() + sec * 1000) },
        });
      }
    } catch (timerErr) {
      console.error('chatHelpers.markChatAsRead timer-stamp error:', timerErr);
    }

    return true;
  } catch (error) {
    console.error('Error marking chat as read:', error);
    return false;
  }
}

/**
 * Get chat read status for all users in a chat
 * @param {number} chatId 
 * @returns {Promise<Object>}
 */
async function getChatReadStatus(chatId) {
  try {
    const latestMessage = await prisma.message.findFirst({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true }
    });

    if (!latestMessage) {
      return { latestMessageId: null, readByUsers: [] };
    }

    // Get users who have read up to the latest message
    const readByUsers = await prisma.userOnChat.findMany({
      where: { 
        chatId,
        lastSeenMessageId: { gte: latestMessage.id }
      },
      select: { 
        userId: true,
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true
          }
        }
      }
    });

    return {
      latestMessageId: latestMessage.id,
      latestMessageAt: latestMessage.createdAt,
      readByUsers: readByUsers.map(u => u.user)
    };
  } catch (error) {
    console.error('Error getting chat read status:', error);
    return { latestMessageId: null, readByUsers: [] };
  }
}

module.exports = {
  getUnreadCount,
  getBulkUnreadCounts,
  markChatAsRead,
  getChatReadStatus,
};
