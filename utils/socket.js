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

    // OPTIONAL: client theke query diye userId pathao: io(URL, {query:{userId}})
    // auth token থাকলে এখানে verify করে userId বের করতে পারো।
    const userId = parseInt(socket.handshake.query?.userId || 0, 10) || null;
    if (userId) {
      socket.data.userId = userId;

      // join own room (for targeted emits in future)
      socket.join(`user:${userId}`);

      // join “friendOf:${userId}” rooms of your friends — so your updates go to them
      const friendIds = await getFriendIds(userId);
      friendIds.forEach((fid) => {
        // তোমাকে যাদের friend দেখাবে তাদের রুমে তারা বসে থাকবে: friendOf:<theirId>
        // তুমি নিজের আপডেট দিলে আমরা io.to(`friendOf:${userId}`) তে emit করব
        // এখানে তেমন কিছু join দরকার নেই; তবু চাইলে debugging রুমে join রাখতে পারো
        socket.join(`friendOf:${fid}`); // optional
      });

      socket.emit('socket:ready', { userId });
    }

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
          return;
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
