// utils/socket.js
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
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

    // ✅ mark messages as read
socket.on('markAsRead', async ({ chatId, lastSeenMessageId }) => {
  const userId = socket.data.userId;
  if (!userId || !chatId || !lastSeenMessageId) {
    console.log('❌ markAsRead: Missing required fields', { userId, chatId, lastSeenMessageId });
    return;
  }

  try {
    // Verify user is part of the chat and message exists
    const userInChat = await prisma.userOnChat.findFirst({
      where: { userId, chatId: parseInt(chatId, 10) }
    });

    if (!userInChat) {
      console.log(`❌ User ${userId} not found in chat ${chatId}`);
      return;
    }

    // Verify the message exists in this chat
    const messageExists = await prisma.message.findFirst({
      where: { 
        id: parseInt(lastSeenMessageId, 10), 
        chatId: parseInt(chatId, 10) 
      }
    });

    if (!messageExists) {
      console.log(`❌ Message ${lastSeenMessageId} not found in chat ${chatId}`);
      return;
    }

    // Update lastSeenMessageId in UserOnChat
    const updated = await prisma.userOnChat.update({
      where: { id: userInChat.id },
      data: { lastSeenMessageId: parseInt(lastSeenMessageId, 10) }
    });

    // Notify other users in the chat
    io.to(`chat_${chatId}`).emit('messageRead', {
      chatId: parseInt(chatId, 10),
      userId,
      lastSeenMessageId: parseInt(lastSeenMessageId, 10)
    });

    console.log(`✅ User ${userId} read messages up to ${lastSeenMessageId} in chat ${chatId}`);
  } catch (err) {
    console.error('❌ markAsRead error:', err);
    socket.emit('markAsReadError', { 
      error: 'Failed to mark messages as read',
      chatId,
      lastSeenMessageId 
    });
  }
});


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

        io.to(`chat_${chatId}`).emit('newMessage', {
          id: message.id,
          content: message.content,
          imageUrl: message.imageUrl,
          sender: { id: message.sender.id, username: message.sender.username },
          chatId: message.chatId,
          createdAt: message.createdAt,
        });
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
