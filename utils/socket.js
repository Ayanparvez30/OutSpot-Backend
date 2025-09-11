// utils/socket.js
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const { 
  subscribeToChatTopic, 
  unsubscribeFromChatTopic, 
  notifyNewMessage 
} = require('./chatNotificationService');
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

function initSocket(server) {
  const io = new Server(server, { cors: { origin: '*' } });

  io.on('connection', async (socket) => {
    console.log('✅ Socket connected:', socket.id);


    const userId = parseInt(socket.handshake.query?.userId || 0, 10) || null;
    const fcmToken = socket.handshake.query?.fcmToken || null;
    
    if (userId) {
      socket.data.userId = userId;
      socket.data.fcmToken = fcmToken;

      socket.join(`user:${userId}`);

      // Subscribe user to their chat topics when they connect
      if (fcmToken) {
        try {
          const userChats = await prisma.userOnChat.findMany({
            where: { userId },
            select: { chatId: true }
          });
          
          // Subscribe to all user's chat topics
          for (const { chatId } of userChats) {
            await subscribeToChatTopic(fcmToken, chatId);
          }
          console.log(`✅ User ${userId} subscribed to ${userChats.length} chat topics`);
        } catch (error) {
          console.error('❌ Error subscribing to chat topics:', error);
        }
      }

      const friendIds = await getFriendIds(userId);
      friendIds.forEach((fid) => {
        socket.join(`friendOf:${fid}`); // optional
      });

      socket.emit('socket:ready', { userId });
    }

    // ✅ mark messages as read
socket.on('markAsRead', async ({ chatId, lastSeenMessageId }) => {
  const userId = socket.data.userId;
  if (!userId || !chatId || !lastSeenMessageId) return;

  try {
    // Update lastSeenMessageId in UserOnChat
    await prisma.userOnChat.updateMany({
      where: { userId, chatId },
      data: { lastSeenMessageId }
    });

    // Notify other users in the chat
    io.to(`chat_${chatId}`).emit('messageRead', {
      chatId,
      userId,
      lastSeenMessageId
    });

    console.log(`✅ User ${userId} read messages up to ${lastSeenMessageId} in chat ${chatId}`);
  } catch (err) {
    console.error('❌ markAsRead error:', err);
  }
});


    // --------------- CHAT EVENTS ---------------
    socket.on('joinChat', async (chatId) => {
      socket.join(`chat_${chatId}`);
      console.log(`🔵 User ${userId} joined chat_${chatId}`);
      
      // Subscribe to FCM topic when joining chat
      const fcmToken = socket.data.fcmToken;
      if (fcmToken) {
        try {
          await subscribeToChatTopic(fcmToken, chatId);
        } catch (error) {
          console.error('❌ Error subscribing to chat topic on join:', error);
        }
      }
    });

    socket.on('leaveChat', async (chatId) => {
      socket.leave(`chat_${chatId}`);
      console.log(`🔴 User ${userId} left chat_${chatId}`);
      
      // Unsubscribe from FCM topic when leaving chat
      const fcmToken = socket.data.fcmToken;
      if (fcmToken) {
        try {
          await unsubscribeFromChatTopic(fcmToken, chatId);
        } catch (error) {
          console.error('❌ Error unsubscribing from chat topic on leave:', error);
        }
      }
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

        // Emit to socket.io room
        io.to(`chat_${chatId}`).emit('newMessage', {
          id: message.id,
          content: message.content,
          imageUrl: message.imageUrl,
          sender: { id: message.sender.id, username: message.sender.username },
          chatId: message.chatId,
          createdAt: message.createdAt,
        });

        // Send Firebase notification to chat topic (for offline users)
        try {
          await notifyNewMessage(chatId, message, message.sender, chat);
        } catch (notifError) {
          console.error('❌ Error sending Firebase notification:', notifError);
          // Don't fail the message sending if notification fails
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
