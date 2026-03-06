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
  const pushDeliveredUserIds = [];
  try {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { users: { include: { user: true } } },
    });

    if (!chat) {
      console.error('Chat not found for push notification');
      return pushDeliveredUserIds;
    }

    for (const userOnChat of chat.users) {
      const user = userOnChat.user;
      if (user.id === senderId) continue;

      if (isUserOnline(user.id)) continue;

      // Always track delivery for offline users (message is in DB)
      pushDeliveredUserIds.push(user.id);

      // Skip FCM push if chat is muted for this user
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
  return pushDeliveredUserIds;
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

    // Auto-join new chat rooms when notified by the server
    socket.on('joinNewChat', (chatId) => {
      const cid = parseInt(chatId, 10);
      if (!cid || !Number.isInteger(cid)) return;
      socket.join(`chat_${cid}`);
      console.log(`🔵 User auto-joined new chat_${cid}`);
    });

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

        // Calculate expiresAt if chat has disappearing messages enabled
        // View-once (disappearingSeconds === 1): sentinel date, deleted 5s after recipient reads
        const VIEW_ONCE_SENTINEL = new Date('2099-01-01T00:00:00.000Z');
        let expiresAt = null;
        if (chat.disappearingSeconds === 1) {
          expiresAt = VIEW_ONCE_SENTINEL;
        } else if (chat.disappearingSeconds) {
          expiresAt = new Date(Date.now() + chat.disappearingSeconds * 1000);
        }

        const message = await prisma.message.create({
          data: {
            chatId,
            senderId,
            content: content || null,
            imageUrl: imageUrl || null,
            expiresAt,
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

        const msgPayload = {
          id: message.id,
          content: message.content,
          imageUrl: message.imageUrl,
          isSystem: message.isSystem || false,
          expiresAt: message.expiresAt || null,
          sender: {
            id: message.sender.id,
            username: message.sender.username,
            firstName: message.sender.firstName,
            lastName: message.sender.lastName,
            avatarUrl: firstAvatar(message.sender.minime),
          },
          chatId: message.chatId,
          createdAt: message.createdAt,
        };

        io.to(`chat_${chatId}`).emit('newMessage', msgPayload);

        // Collect who is online in the chat room
        const chatRoom = io.sockets.adapter.rooms.get(`chat_${chatId}`);
        const onlineInChatRoom = new Set();
        if (chatRoom) {
          for (const socketId of chatRoom) {
            const s = io.sockets.sockets.get(socketId);
            if (s?.data?.userId) onlineInChatRoom.add(s.data.userId);
          }
        }

        // Auto-mark delivery for online recipients in the chat room
        for (const uid of onlineInChatRoom) {
          if (uid !== senderId) {
            await prisma.userOnChat.updateMany({
              where: { userId: uid, chatId },
              data: { lastDeliveredMessageId: message.id },
            });
            io.to(`chat_${chatId}`).emit('messageDelivered', {
              chatId,
              userId: uid,
              lastDeliveredMessageId: message.id,
            });
          }
        }

        // Also emit to each recipient's personal room (handles newly
        // created chats where the recipient hasn't joined the chat room)
        for (const userOnChat of chat.users) {
          if (userOnChat.userId !== senderId) {
            io.to(`user:${userOnChat.userId}`).emit('newMessage', msgPayload);

            // Mark delivery for online recipients not already handled above
            if (!onlineInChatRoom.has(userOnChat.userId)) {
              const personalRoom = io.sockets.adapter.rooms.get(`user:${userOnChat.userId}`);
              if (personalRoom && personalRoom.size > 0) {
                await prisma.userOnChat.updateMany({
                  where: { userId: userOnChat.userId, chatId },
                  data: { lastDeliveredMessageId: message.id },
                });
                io.to(`chat_${chatId}`).emit('messageDelivered', {
                  chatId,
                  userId: userOnChat.userId,
                  lastDeliveredMessageId: message.id,
                });
              }
            }
          }
        }

        // push notifications + mark delivery for users who receive the push
        const sender = await prisma.user.findUnique({ where: { id: senderId } });
        if (sender) {
          const pushDeliveredUserIds = await sendPushNotificationToOfflineUsers(
            chatId,
            senderId,
            sender.firstName,
            sender.lastName,
            content || ''
          );
          // Mark delivery for offline users who got the push notification
          for (const uid of pushDeliveredUserIds) {
            await prisma.userOnChat.updateMany({
              where: { userId: uid, chatId },
              data: { lastDeliveredMessageId: message.id },
            });
            io.to(`chat_${chatId}`).emit('messageDelivered', {
              chatId,
              userId: uid,
              lastDeliveredMessageId: message.id,
            });
          }
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

    // Delivery confirmation: client emits this when it receives a message
    socket.on('messageDelivered', async ({ chatId, messageId }) => {
      const uid = socket.data.userId;
      const cid = parseInt(chatId, 10);
      const mid = parseInt(messageId, 10);
      if (!uid || !cid || !mid) return;

      try {
        // Only advance lastDeliveredMessageId forward (never backward)
        const row = await prisma.userOnChat.findFirst({
          where: { userId: uid, chatId: cid },
          select: { lastDeliveredMessageId: true },
        });
        if (!row) return;
        if (row.lastDeliveredMessageId && row.lastDeliveredMessageId >= mid) return;

        await prisma.userOnChat.updateMany({
          where: { userId: uid, chatId: cid },
          data: { lastDeliveredMessageId: mid },
        });

        // Notify the chat so sender can update tick UI
        io.to(`chat_${cid}`).emit('messageDelivered', {
          chatId: cid,
          userId: uid,
          lastDeliveredMessageId: mid,
        });
      } catch (error) {
        console.error('messageDelivered error:', error);
      }
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

        // View-once: delete read messages 5s after recipient views them
        const chat = await prisma.chat.findUnique({
          where: { id: cid },
          select: { disappearingSeconds: true },
        });

        if (chat && chat.disappearingSeconds === 1) {
          const VIEW_ONCE_SENTINEL = new Date('2099-01-01T00:00:00.000Z');
          // Only target messages marked with the view-once sentinel
          const viewOnceMessages = await prisma.message.findMany({
            where: {
              chatId: cid,
              id: { lte: lastId },
              isSystem: false,
              expiresAt: VIEW_ONCE_SENTINEL,
              senderId: { not: uid },
            },
            select: { id: true },
          });

          if (viewOnceMessages.length > 0) {
            const msgIds = viewOnceMessages.map(m => m.id);

            // Schedule deletion after 5 seconds
            setTimeout(async () => {
              try {
                await prisma.message.deleteMany({
                  where: { id: { in: msgIds } },
                });

                io.to(`chat_${cid}`).emit('messagesDeleted', {
                  chatId: cid,
                  messageIds: msgIds,
                });
              } catch (e) {
                console.error('View-once delete error:', e);
              }
            }, 5000);
          }
        }
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

module.exports = { initSocket, getIO, sendPushToOfflineUsers: sendPushNotificationToOfflineUsers };
