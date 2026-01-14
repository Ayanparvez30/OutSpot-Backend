// utils/socket.js
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const admin = require('../firebaseAdmin');
const prisma = new PrismaClient();

let ioInstance;

function isGlobalChatName(name) {
  return typeof name === "string" && name.startsWith("Global Chat");
}

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

const firstAvatar = (minimeArr) =>
  Array.isArray(minimeArr) && minimeArr.length > 0
    ? (minimeArr[0]?.avatarUrl || null)
    : null;

async function getFriendIds(userId) {
  const rows = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ requesterId: userId }, { receiverId: userId }],
    },
  });
  return rows.map((r) => (r.requesterId === userId ? r.receiverId : r.requesterId));
}

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

      if (isUserOnline(user.id)) continue;

      if (userOnChat.isMuted) continue;

      if (user.fcmToken) {
        const notificationPayload = {
          token: user.fcmToken,
          notification: {
            title: `${senderFirstName || ''} ${senderLastName || ''}`.trim() || 'New message',
            body: messageContent || '',
          },
          data: {
            chatId: String(chatId),
            senderName: `${senderFirstName || ''} ${senderLastName || ''}`.trim(),
          },
        };

        try {
          await admin.messaging().send(notificationPayload);
        } catch (error) {
          console.error(`Failed to send push notification to user ${user.id}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('Error in sendPushNotificationToOfflineUsers:', error);
  }
}

function isUserOnline(userId) {
  if (!ioInstance) return false;

  const userRoom = ioInstance.sockets.adapter.rooms.get(`user:${userId}`);
  if (!userRoom || userRoom.size === 0) return false;

  for (const socketId of userRoom) {
    const socket = ioInstance.sockets.sockets.get(socketId);
    if (socket && socket.data && socket.data.userId === userId) return true;
  }
  return false;
}

function initSocket(server) {
  const io = new Server(server, { cors: { origin: '*' } });

  io.on('connection', async (socket) => {
    console.log('✅ Socket connected:', socket.id);

    const rawUserId = socket.handshake.query?.userId;
    const userId = rawUserId ? parseInt(rawUserId, 10) : null;

    if (userId && Number.isInteger(userId)) {
      socket.data.userId = userId;
      socket.join(`user:${userId}`);

      try {
        const friendIds = await getFriendIds(userId);
        friendIds.forEach((fid) => socket.join(`friendOf:${fid}`));
      } catch (e) {
        console.error('❌ getFriendIds error:', e);
      }

      // 🚀 Auto-join all user's chats
      try {
        const userChats = await prisma.chat.findMany({
          where: { users: { some: { userId } } },
          select: { id: true },
        });

        userChats.forEach(chat => socket.join(`chat_${chat.id}`));
        console.log(`🔵 User ${userId} auto-joined ${userChats.length} chats`);
      } catch (err) {
        console.error('❌ Error auto-joining chats:', err);
      }

      socket.emit('socket:ready', { userId });
    }

    // --------------- CHAT EVENTS ---------------
    socket.on('joinChat', (chatId) => {
      const cid = parseInt(chatId, 10);
      if (!cid || !Number.isInteger(cid)) return;

      socket.join(`chat_${cid}`);
      console.log(`🔵 User joined chat_${cid}`);
    });

    socket.on('sendMessage', async (data) => {
      let { chatId, content, senderId, imageUrl } = data || {};

      chatId = parseInt(chatId, 10);
      senderId = parseInt(senderId, 10);

      if (
        !chatId || !Number.isInteger(chatId) ||
        !senderId || !Number.isInteger(senderId) ||
        (!content && !imageUrl)
      ) {
        console.log('❌ Missing/invalid fields in sendMessage', { chatId, senderId });
        return;
      }

      try {
        const chat = await prisma.chat.findUnique({
          where: { id: chatId },
          include: { users: { include: { user: true } } },
        });

        if (!chat) {
          socket.emit('messageError', { error: 'Chat not found' });
          return;
        }

        const isGlobalVariant =
          chat?.communityId === null &&
          chat?.isCommunity === false &&
          isGlobalChatName(chat?.name);

        // ✅ ensure sender is a member
        let senderInChat = chat.users.find(u => u.userId === senderId);

        // ✅ auto-add membership for global rooms (like REST)
        if (!senderInChat) {
          if (!isGlobalVariant) {
            socket.emit('messageError', { error: 'You are not a member of this chat', chatId });
            return;
          }

          await prisma.userOnChat.upsert({
            where: { userId_chatId: { userId: senderId, chatId } }, // requires @@unique([userId, chatId])
            update: {},
            create: { userId: senderId, chatId, role: 'MEMBER', lastSeenMessageId: 0 },
          });

          // refresh role (for lock checks etc)
          senderInChat = { userId: senderId, role: 'MEMBER' };
        } else {
          // normalize role
          senderInChat = { userId: senderId, role: senderInChat.role };
        }

        // ✅ locked group check
        if (chat.isGroup && chat.isLocked) {
          if (senderInChat.role !== 'ADMIN') {
            socket.emit('messageError', {
              error: 'This group chat is locked. Only admins can send messages.',
              chatId,
              isLocked: true
            });
            return;
          }
        }

        // ✅ block check ONLY for private chat (2 users, not group)
        if (!chat.isGroup && chat.users?.length === 2) {
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
              socket.emit('messageError', { error: 'Message blocked' });
              return;
            }
          }
        }

        const message = await prisma.message.create({
          data: {
            chatId,
            senderId,
            content: content || null,
            imageUrl: imageUrl || null
          },
          include: {
            sender: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                minime: {
                  select: { avatarUrl: true },
                  where: { isSaved: true },
                  orderBy: { updatedAt: 'desc' },
                  take: 1,
                },
              },
            },
          },
        });

        await prisma.chat.update({
          where: { id: chatId },
          data: { updatedAt: new Date() },
        });

        // ✅ mark sender as read up to this message
        await prisma.userOnChat.updateMany({
          where: { userId: senderId, chatId },
          data: { lastSeenMessageId: message.id }
        });

        io.to(`chat_${chatId}`).emit('newMessage', {
          id: message.id,
          content: message.content,
          imageUrl: message.imageUrl,
          sender: {
            id: message.sender.id,
            username: message.sender.username,
            firstName: message.sender.firstName,
            lastName: message.sender.lastName,
            avatarUrl: firstAvatar(message.sender.minime),
          },
          chatId: message.chatId,
          createdAt: message.createdAt,
        });

        // ✅ push notifications
        const sender = await prisma.user.findUnique({ where: { id: senderId } });
        if (sender) {
          sendPushNotificationToOfflineUsers(
            chatId,
            senderId,
            sender.firstName,
            sender.lastName,
            content || ''
          );
        }
      } catch (error) {
        console.error('❌ Error sending message:', error);
        socket.emit('messageError', { error: 'Failed to send message' });
      }
    });

    socket.on('typing', ({ chatId, username }) => {
      const cid = parseInt(chatId, 10);
      if (!cid) return;
      socket.to(`chat_${cid}`).emit('typing', { username });
    });

    socket.on('stopTyping', ({ chatId, username }) => {
      const cid = parseInt(chatId, 10);
      if (!cid) return;
      socket.to(`chat_${cid}`).emit('stopTyping', { username });
    });

    // --------------- LOCATION EVENTS ---------------
    socket.on('location:update', async ({ latitude, longitude }) => {
      const uid = socket.data.userId;
      if (!uid || typeof latitude !== 'number' || typeof longitude !== 'number') return;

      const res = await smartPersistLocation(uid, latitude, longitude, 50);
      if (!res.moved) return;

      io.to(`friendOf:${uid}`).emit('location:friendUpdate', {
        userId: uid,
        latitude,
        longitude,
        updatedAt: Date.now(),
      });
    });

    socket.on('markMessageAsRead', async ({ chatId, userId, lastSeenMessageId }) => {
      const cid = parseInt(chatId, 10);
      const uid = parseInt(userId, 10);
      const lastId = parseInt(lastSeenMessageId, 10);
      if (!cid || !uid || !lastId) return;

      try {
        await prisma.userOnChat.updateMany({
          where: { userId: uid, chatId: cid },
          data: { lastSeenMessageId: lastId },
        });

        socket.to(`chat_${cid}`).emit('messageRead', {
          chatId: cid,
          userId: uid,
          lastSeenMessageId: lastId,
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
