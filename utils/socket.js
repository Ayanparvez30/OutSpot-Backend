// utils/socket.js
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const admin = require('../firebaseAdmin'); // Import Firebase Admin
const prisma = new PrismaClient();

let ioInstance;

// ---- helpers ----
const toRad = d => (d * Math.PI) / 180;
function haversine(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const A =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(A));
}

async function getFriendIds(userId) {
  const rows = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ requesterId: userId }, { receiverId: userId }],
    },
  });
  return rows.map((r) => (r.requesterId === userId ? r.receiverId : r.requesterId));
}

// 50m threshold + history append
async function smartPersistLocation(userId, latitude, longitude, threshold = 50) {
  const last = await prisma.location.findUnique({ where: { userId } });
  if (!last) {
    await prisma.location.create({ data: { userId, latitude, longitude } });
    await prisma.locationHistory.create({ data: { userId, latitude, longitude } });
    return { moved: true, dist: null };
  }
  const dist = haversine(
    { lat: last.latitude, lng: last.longitude },
    { lat: latitude, lng: longitude }
  );
  if (dist < threshold) return { moved: false, dist };

  await prisma.location.update({
    where: { userId },
    data: { latitude, longitude },
  });
  await prisma.locationHistory.create({ data: { userId, latitude, longitude } });
  return { moved: true, dist };
}

// Helper function to get latest message ID in a chat
async function getLatestMessageId(chatId) {
  const latestMessage = await prisma.message.findFirst({
    where: { chatId },
    orderBy: { createdAt: 'desc' },
    select: { id: true }
  });
  return latestMessage?.id || 0;
}

// Updated function to remove 'sent you a message' from the notification title
async function sendPushNotificationToOfflineUsers(chatId, senderId, senderFirstName, senderLastName, messageContent) {
  try {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { users: { include: { user: true } } },
    });

    if (!chat) {
      console.error('Chat not found for push notification');
      return;
    }

    for (const userOnChat of chat.users) {
      const user = userOnChat.user;

      if (user.id === senderId) continue;

      // Check if user is online
      if (isUserOnline(user.id)) {
        console.log(`Skipping notification for online user ${user.id} in chat ${chatId}`);
        continue;
      }

      // Check if the chat is muted for the user
      const isMuted = userOnChat.isMuted;
      if (isMuted) {
        console.log(`Skipping notification for muted chat ${chatId} for user ${user.id}`);
        continue;
      }

      if (user.fcmToken) {
        let notificationTitle;
        let notificationBody;

        if (chat.isGroup) {
          // Group notification
          notificationTitle = chat.name; // Group name
          notificationBody = `${senderFirstName} ${senderLastName}: ${messageContent}`; // Sender's name and message
        } else {
          // Private notification
          notificationTitle = `${senderFirstName} ${senderLastName}`; // Sender's name
          notificationBody = messageContent; // Message content only
        }

        const notificationPayload = {
          token: user.fcmToken,
          notification: {
            title: notificationTitle,
            body: notificationBody,
          },
          data: {
            chatId: String(chatId),
            senderName: `${senderFirstName} ${senderLastName}`,
          },
        };

        try {
          await admin.messaging().send(notificationPayload);
          console.log(`Push notification sent to offline user ${user.id}`);
        } catch (error) {
          console.error(`Failed to send push notification to user ${user.id}:`, error);
        }
      } else {
        console.log(`User ${user.id} is offline but has no FCM token`);
      }
    }
  } catch (error) {
    console.error('Error in sendPushNotificationToOfflineUsers:', error);
  }
}

// Ensure isUserOnline is defined before sendPushNotificationToOfflineUsers
function isUserOnline(userId) {
  if (!ioInstance) {
    console.error('Socket.IO instance not initialized');
    return false;
  }

  const userRoom = ioInstance.sockets.adapter.rooms.get(`user:${userId}`);
  if (!userRoom || userRoom.size === 0) {
    console.log(`User ${userId} is not connected to any socket`);
    return false;
  }

  for (const socketId of userRoom) {
    const socket = ioInstance.sockets.sockets.get(socketId);
    if (socket && socket.data && socket.data.userId === userId) {
      console.log(`User ${userId} is online with socket ID ${socketId}`);
      return true;
    }
  }

  console.log(`User ${userId} has no valid socket connections`);
  return false;
}

function initSocket(server) {
  const io = new Server(server, { cors: { origin: '*' } });

  io.on('connection', async (socket) => {
    console.log('✅ Socket connected:', socket.id);

    const userId = parseInt(socket.handshake.query?.userId || 0, 10) || null;
    if (userId) {
      socket.data.userId = userId;

      socket.join(`user:${userId}`);

      const friendIds = await getFriendIds(userId);
      friendIds.forEach((fid) => {
        socket.join(`friendOf:${fid}`); // optional
      });

      // 🚀 Auto-join all user's chats for better UX
      try {
        const userChats = await prisma.chat.findMany({
          where: { users: { some: { userId } } },
          select: { id: true },
        });
        
        userChats.forEach(chat => {
          socket.join(`chat_${chat.id}`);
        });
        
        console.log(`🔵 User ${userId} auto-joined ${userChats.length} chats`);
      } catch (err) {
        console.error('❌ Error auto-joining chats:', err);
      }

      socket.emit('socket:ready', { userId });
    }

    // ✅ mark entire chat as read (chat-based approach) - DISABLED: Using REST API only
    // socket.on('markChatAsRead', async ({ chatId }) => {
    //   const userId = socket.data.userId;
    //   if (!userId || !chatId) {
    //     console.log('❌ markChatAsRead: No userId found in socket data. User might not be authenticated.', { 
    //       socketId: socket.id, 
    //       chatId, 
    //       handshakeUserId: socket.handshake.query?.userId 
    //     });
    //     return;
    //   }

    //   console.log(`🔍 markChatAsRead called by User ${userId} for chat ${chatId}`);

    //   try {
    //     // Verify user is part of the chat
    //     const userInChat = await prisma.userOnChat.findFirst({
    //       where: { userId, chatId: parseInt(chatId, 10) }
    //     });

    //     if (!userInChat) {
    //       console.log(`❌ User ${userId} not found in chat ${chatId}`);
    //       return;
    //     }

    //     // Update lastReadAt to current timestamp for chat-based read receipt
    //     const updated = await prisma.userOnChat.update({
    //       where: { id: userInChat.id },
    //       data: { 
    //         lastSeenMessageId: await getLatestMessageId(parseInt(chatId, 10)),
    //         // Add lastReadAt if you add it to schema later
    //       }
    //     });

    //     console.log(`✅ User ${userId} marked chat ${chatId} as read`);

    //     // Notify other users in the chat that this user has read the chat
    //     socket.to(`chat_${chatId}`).emit('chatRead', {
    //       chatId: parseInt(chatId, 10),
    //       userId,
    //       readAt: new Date().toISOString()
    //     });

    //   } catch (err) {
    //     console.error('❌ markChatAsRead error:', err);
    //     socket.emit('markChatAsReadError', { 
    //       error: 'Failed to mark chat as read',
    //       chatId
    //     });
    //   }
    // });

    // --------------- CHAT EVENTS (as you had) ---------------
    socket.on('joinChat', (chatId) => {
      socket.join(`chat_${chatId}`);
      console.log(`🔵 User joined chat_${chatId}`);
    });

    socket.on('sendMessage', async (data) => {
      const { chatId, content, senderId, imageUrl } = data;

      if (!chatId || (!content && !imageUrl) || !senderId) {
        console.log('❌ Missing fields in sendMessage');
        return;
      }

      try {
        const chat = await prisma.chat.findUnique({
          where: { id: chatId },
          include: { users: { include: { user: true } } },
        });

        if (!chat) {
          console.log('❌ Chat not found');
          socket.emit('messageError', { error: 'Chat not found' });
          return;
        }

        // Check if chat is locked and if user is admin
        if (chat.isGroup && chat.isLocked) {
          const senderInChat = chat.users.find(u => u.userId === senderId);
          if (!senderInChat || senderInChat.role !== 'ADMIN') {
            console.log('🔒 Chat is locked, only admins can send messages');
            socket.emit('messageError', { 
              error: 'This group chat is locked. Only admins can send messages.',
              chatId,
              isLocked: true
            });
            return;
          }
        }

        const recipient = chat.users.find((u) => u.userId !== senderId)?.user;

        if (recipient) {
          const isBlocked = await prisma.block.findFirst({
            where: {
              OR: [
                { blockerId: senderId, blockedId: recipient.id },
                { blockerId: recipient.id, blockedId: senderId },
              ],
            },
          });
          if (isBlocked) {
            console.log('🚫 Message blocked');
            socket.emit('messageError', { error: 'Message blocked' });
            return;
          }
        }

        const message = await prisma.message.create({
          data: { chatId, senderId, content, imageUrl },
          include: { sender: true },
        });

        // ✅ Update chat's updatedAt timestamp
        await prisma.chat.update({
          where: { id: chatId },
          data: { updatedAt: new Date() },
        });

        // ✅ Auto-mark chat as read for the sender (they just sent a message)
        await prisma.userOnChat.updateMany({
          where: { 
            userId: senderId, 
            chatId: chatId 
          },
          data: { lastSeenMessageId: message.id }
        });

        io.to(`chat_${chatId}`).emit('newMessage', {
          id: message.id,
          content: message.content,
          imageUrl: message.imageUrl,
          sender: { id: message.sender.id, username: message.sender.username },
          chatId: message.chatId,
          createdAt: message.createdAt,
        });

        // Send push notifications to offline users, including sender's first and last name
        const sender = await prisma.user.findUnique({ where: { id: senderId } });
        if (sender) {
          sendPushNotificationToOfflineUsers(chatId, senderId, sender.firstName, sender.lastName, content);
        }
      } catch (error) {
        console.error('❌ Error sending message:', error);
        socket.emit('messageError', { error: 'Failed to send message' });
      }
    });

    socket.on('typing', ({ chatId, username }) => {
      socket.to(`chat_${chatId}`).emit('typing', { username });
    });

    socket.on('stopTyping', ({ chatId, username }) => {
      socket.to(`chat_${chatId}`).emit('stopTyping', { username });
    });

    // --------------- MAP / LOCATION EVENTS (new) ---------------
    // client emits: 'location:update' { latitude, longitude }
    socket.on('location:update', async ({ latitude, longitude }) => {
      const uid = socket.data.userId;
      if (!uid || typeof latitude !== 'number' || typeof longitude !== 'number') return;

      const res = await smartPersistLocation(uid, latitude, longitude, 50);
      if (!res.moved) return;

      // broadcast to your friends (who are listening in room friendOf:<you>)
      io.to(`friendOf:${uid}`).emit('location:friendUpdate', {
        userId: uid,
        latitude,
        longitude,
        updatedAt: Date.now(),
      });
    });
    //added last, maybe not needed or must be needed

    socket.on('markMessageAsRead', async ({ chatId, userId, lastSeenMessageId }) => {
      if (!chatId || !userId || !lastSeenMessageId) {
        console.log('❌ Missing fields in markMessageAsRead');
        return;
      }

      try {
        // Update the lastSeenMessageId for the user in the chat
        await prisma.userOnChat.updateMany({
          where: { userId, chatId },
          data: { lastSeenMessageId },
        });

        console.log(`✅ User ${userId} marked messages up to ${lastSeenMessageId} as read in chat ${chatId}`);

        // Notify other users in the chat
        socket.to(`chat_${chatId}`).emit('messageRead', {
          chatId,
          userId,
          lastSeenMessageId,
        });
      } catch (error) {
        console.error('❌ Error in markMessageAsRead:', error);
        socket.emit('markMessageAsReadError', { error: 'Failed to mark messages as read' });
      }
    });

    socket.on('disconnect', () => {
      console.log('❌ Socket disconnected:', socket.id);
    });
  });

  ioInstance = io;
}

function getIO() {
  if (!ioInstance) throw new Error('Socket.IO not initialized!');
  return ioInstance;
}

module.exports = { initSocket, getIO };
