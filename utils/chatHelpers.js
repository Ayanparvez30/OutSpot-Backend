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
    }

    return unreadCounts;
  } catch (error) {
    console.error('Error calculating bulk unread counts:', error);
    return new Map();
  }
}

module.exports = {
  getUnreadCount,
  getBulkUnreadCounts,
};
