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
  // Push is only a wake-up signal — NOT delivery confirmation.
  // Delivery is tracked solely by client emitting 'messageDelivered' via socket
  // when message actually reaches the device (like WhatsApp).
  try {
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { users: { include: { user: true } } },
    });

    if (!chat) return;

    for (const userOnChat of chat.users) {
      const user = userOnChat.user;
      if (user.id === senderId) continue;
      if (isUserOnline(user.id)) continue;
      if (!user.fcmToken) continue;
      if (user.notificationEnabled === false) continue; // master switch off => no push
      if (userOnChat.isMuted) continue;

      const notificationPayload = {
        token: user.fcmToken,
        notification: {
          title: `${senderFirstName || ''} ${senderLastName || ''}`.trim() || 'New message',
          body: messageContent || '',
        },
        data: {
          type: 'CHAT_MESSAGE',
          chatId: String(chatId),
          senderId: String(senderId),
          senderName: `${senderFirstName || ''} ${senderLastName || ''}`.trim(),
        },
      };

      try {
        await admin.messaging().send(notificationPayload);
      } catch (error) {
        // Token invalid = app uninstalled or token expired → clear it
        if (error.code === 'messaging/registration-token-not-registered' ||
            error.code === 'messaging/invalid-registration-token') {
          await prisma.user.update({
            where: { id: user.id },
            data: { fcmToken: null },
          });
          console.log(`🧹 Cleared stale FCM token for user ${user.id}`);
        } else {
          console.error(`Failed to send push to user ${user.id}:`, error.code || error.message);
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

      // 🚀 Auto-join community rooms (for non-chat community.* realtime signals)
      try {
        const memberships = await prisma.communityMember.findMany({
          where: { userId },
          select: { communityId: true },
        });
        memberships.forEach(m => socket.join(`community:${m.communityId}`));
      } catch (err) {
        console.error('❌ Error auto-joining community rooms:', err);
      }

      socket.emit('socket:ready', { userId });
    }

    // Fallback room-join — for clients that connect WITHOUT query.userId and
    // emit `joinUser` after auth instead. No-op if already joined via query.
    socket.on('joinUser', (uid) => {
      const parsed = parseInt(uid, 10);
      if (!parsed || !Number.isInteger(parsed)) return;
      socket.data.userId = socket.data.userId || parsed;
      socket.join(`user:${parsed}`);
    });

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

    // Mark the conversation the user is ACTIVELY viewing. Switching to another
    // chat counts as exiting the previous one (disappear-on-exit).
    socket.on('enterChat', async (chatId) => {
      const cid = parseInt(chatId, 10);
      if (!cid || !Number.isInteger(cid)) return;
      const prev = socket.data.activeChatId;
      if (prev && prev !== cid) {
        await clearChatOnExit(socket.data.userId, prev);
      }
      socket.data.activeChatId = cid;
      socket.join(`chat_${cid}`);
    });

    // User left the conversation screen → hide its messages for THIS user only
    // (no-op unless the chat is in disappear-immediately mode).
    socket.on('exitChat', async (chatId) => {
      const cid = parseInt(chatId, 10) || socket.data.activeChatId;
      if (!cid) return;
      if (socket.data.activeChatId === cid) socket.data.activeChatId = null;
      await clearChatOnExit(socket.data.userId, cid);
    });

    socket.on('sendMessage', async (data) => {
      // Items 6 + 8: NEW optional fields (additive — old clients work unchanged):
      //   • replyToMessageId — int id of the message being replied to
      //   • forwarded        — boolean flag (default false)
      let { chatId, content, senderId, imageUrl, replyToMessageId, forwarded } = data || {};

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

      // Validate replyToMessageId: must be an int referencing a message in the
      // SAME chat. Anything else → drop the field (defensive, never blocks send).
      let replyToParsed = null;
      if (replyToMessageId !== undefined && replyToMessageId !== null) {
        const rid = parseInt(replyToMessageId, 10);
        if (Number.isInteger(rid) && rid > 0) {
          const target = await prisma.message.findUnique({
            where: { id: rid },
            select: { id: true, chatId: true },
          });
          if (target && target.chatId === chatId) replyToParsed = rid;
        }
      }
      const forwardedFlag = forwarded === true; // strict-true only

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

        // Calculate expiresAt if chat has disappearing messages enabled.
        // Timed modes (5m/15m/30m/1h/3h/6h) are receiver-view-triggered now —
        // expiresAt stays null at send, stamped in markChatAsRead when the
        // recipient actually reads. View-once and global keep their old
        // send-time stamps.
        const VIEW_ONCE_SENTINEL = new Date('2099-01-01T00:00:00.000Z');
        const GLOBAL_CHAT_TTL_MS = 12 * 60 * 60 * 1000; // global messages disappear 12h after being sent
        const GROUP_CHAT_TTL_MS = 24 * 60 * 60 * 1000;  // group + community messages disappear 24h after being sent
        let expiresAt = null;
        if (chat.disappearingSeconds === 1) {
          expiresAt = VIEW_ONCE_SENTINEL;
        } else if (isGlobalVariant) {
          expiresAt = new Date(Date.now() + GLOBAL_CHAT_TTL_MS);
        } else if (chat.isGroup || chat.isCommunity) {
          // Each group/community message expires independently, 24h from its send time
          expiresAt = new Date(Date.now() + GROUP_CHAT_TTL_MS);
        }

        // Item 9: if imageUrl is a shared story / explore media URL we own,
        // copy to a chat-owned key so the chat message survives the source's
        // lifecycle (24h story expiry, etc). Foreign / already-chat-owned URLs
        // pass through. Copy failure falls back to source URL.
        let persistedImageUrl = imageUrl || null;
        if (persistedImageUrl) {
          try {
            const { materializeChatMedia } = require('./s3Upload');
            persistedImageUrl = await materializeChatMedia(persistedImageUrl);
          } catch (matErr) {
            console.error('sendMessage materializeChatMedia error', matErr);
          }
        }

        const message = await prisma.message.create({
          data: {
            chatId,
            senderId,
            content: content || null,
            imageUrl: persistedImageUrl,
            expiresAt,
            // Items 6 + 8: persist optional new fields. forwarded defaults to
            // false in the schema, replyToMessageId stays null when absent.
            ...(replyToParsed !== null ? { replyToMessageId: replyToParsed } : {}),
            ...(forwardedFlag           ? { forwarded: true }                : {}),
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
            // Item 8: quoted message for client to render the "reply-to" bubble.
            replyTo: {
              select: {
                id: true,
                content: true,
                imageUrl: true,
                senderId: true,
                sender: { select: { username: true, firstName: true, lastName: true } },
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
          // Items 6 + 8: emit new optional fields. Old clients that ignore
          // unknown keys see no change.
          forwarded: message.forwarded || false,
          replyTo: message.replyTo
            ? {
                id: message.replyTo.id,
                content: message.replyTo.content,
                imageUrl: message.replyTo.imageUrl,
                senderId: message.replyTo.senderId,
                senderName: [message.replyTo.sender?.firstName, message.replyTo.sender?.lastName]
                  .filter(Boolean)
                  .join(' ') || message.replyTo.sender?.username || null,
              }
            : null,
          chatId: message.chatId,
          createdAt: message.createdAt,
        };

        // Block-aware fan-out (item 4): for group/community, load blocks once
        // and share the set with the existing per-recipient personal-room emit
        // below. DM is unaffected — the send-side block at lines 295-313 already
        // prevents the message from existing for DM.
        //
        // blockedSet is consulted at TWO points:
        //   1) The chat_${chatId} broadcast — if any block exists, we skip the
        //      room broadcast and fan out per-user so blocked members don't
        //      receive via the broadcast.
        //   2) The personal-room emit loop below — we always skip blocked
        //      recipients there too. (Existing loop reused for delivery state;
        //      we just narrow whom we emit `newMessage` to.)
        let blockedSet = new Set();
        let useRoomBroadcast = true;
        if (chat.isGroup || chat.isCommunity) {
          const memberIds = chat.users.map((u) => u.userId);
          const blocks = await prisma.block.findMany({
            where: {
              OR: [
                { blockerId: senderId, blockedId: { in: memberIds } },
                { blockedId: senderId, blockerId: { in: memberIds } },
              ],
            },
            select: { blockerId: true, blockedId: true },
          });
          for (const b of blocks) {
            blockedSet.add(b.blockerId === senderId ? b.blockedId : b.blockerId);
          }
          if (blockedSet.size > 0) {
            useRoomBroadcast = false;
            // Sender always gets their own echo.
            io.to(`user:${senderId}`).emit('newMessage', msgPayload);
            // Per-recipient fan-out, skipping anyone on either side of a block.
            for (const userOnChat of chat.users) {
              if (userOnChat.userId === senderId) continue;
              if (blockedSet.has(userOnChat.userId)) continue;
              io.to(`user:${userOnChat.userId}`).emit('newMessage', msgPayload);
            }
          }
        }
        if (useRoomBroadcast) {
          io.to(`chat_${chatId}`).emit('newMessage', msgPayload);
        }

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
        // created chats where the recipient hasn't joined the chat room).
        // Item 4: in group/community, skip recipients on either side of a block
        // (blockedSet computed above is empty for DM and for unblocked groups).
        for (const userOnChat of chat.users) {
          if (userOnChat.userId !== senderId) {
            if (!blockedSet.has(userOnChat.userId)) {
              io.to(`user:${userOnChat.userId}`).emit('newMessage', msgPayload);
            }

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

        // Send push notification to offline users (wake-up only, no delivery marking)
        // Delivery is confirmed solely by client emitting 'messageDelivered' via socket
        // Global chat sends NO notifications — only personal & group chats notify.
        if (!isGlobalVariant) {
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
        }
      } catch (error) {
        console.error('❌ Error sending message:', error);
        socket.emit('messageError', { error: 'Failed to send message' });
      }
    });

    // -------------------------------------------------------------------
    // deleteMessage — owner deletes their own messages (item 1).
    //
    // Payload: { chatId, messageIds: [int, ...] }
    //   • messageIds array supports both single and multi-delete from one path
    //   • Hard delete; no time window; broadcast via the EXISTING messagesDeleted
    //     event so the client's existing handler removes them locally
    //   • Caller can delete ONLY their own messages — any non-owned id is
    //     silently dropped. (Admin-delete-any-message is a separate REST route.)
    // Body extracted to deleteOwnMessages(...) for unit-testability.
    // -------------------------------------------------------------------
    socket.on('deleteMessage', async (data) => {
      await deleteOwnMessages({
        prisma,
        io,
        callerId: socket.data?.userId,
        chatId: data?.chatId,
        messageIds: data?.messageIds,
      });
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

        // NOTE: disappear-immediately (disappearingSeconds === 1) is now handled
        // on chat EXIT per-user (clearChatOnExit), not 5s-after-read. See exitChat.
      } catch (error) {
        console.error('❌ Error in markMessageAsRead:', error);
        socket.emit('markMessageAsReadError', { error: 'Failed to mark messages as read' });
      }
    });

    socket.on('disconnect', async () => {
      console.log('❌ Socket disconnected:', socket.id);
      // App killed / network lost while viewing a chat → treat as exit so
      // disappear-immediately messages get hidden for this user too.
      if (socket.data.activeChatId && socket.data.userId) {
        await clearChatOnExit(socket.data.userId, socket.data.activeChatId);
      }
    });
  });

  ioInstance = io;
}

function getIO() {
  if (!ioInstance) throw new Error('Socket.IO not initialized!');
  return ioInstance;
}

// Disappear-on-exit: when a user leaves a chat (navigate away / switch / app
// kill / disconnect), hide that chat's messages from THIS user only by advancing
// their per-user clearedUpToMessageId. No-op unless the chat is in
// disappear-immediately mode (disappearingSeconds === 1). When ALL members have
// passed a message (min clearedUpToMessageId), it's hard-deleted + S3 cleaned.
// Other features are untouched: non-immediate chats keep clearedUpToMessageId = 0.
async function clearChatOnExit(userId, chatId) {
  try {
    const cid = parseInt(chatId, 10);
    const uid = parseInt(userId, 10);
    if (!cid || !uid) return;

    const chat = await prisma.chat.findUnique({
      where: { id: cid },
      select: {
        disappearingSeconds: true,
        users: { select: { userId: true, clearedUpToMessageId: true } },
      },
    });
    if (!chat || chat.disappearingSeconds !== 1) return; // only immediate mode

    const me = chat.users.find(u => u.userId === uid);
    if (!me) return; // not a member
    const myCleared = me.clearedUpToMessageId || 0;

    // Receiver-driven: advance cleared past the latest message NOT sent by me.
    // Messages I sent stay visible to me; only my exit-as-receiver clears.
    const latestNotMine = await prisma.message.findFirst({
      where: { chatId: cid, senderId: { not: uid } },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const latestId = latestNotMine?.id || 0;
    const newCleared = Math.max(myCleared, latestId);
    if (newCleared !== myCleared) {
      await prisma.userOnChat.updateMany({
        where: { userId: uid, chatId: cid },
        data: { clearedUpToMessageId: newCleared },
      });
      try {
        ioInstance && ioInstance.to(`user:${uid}`).emit('messagesDeleted', { chatId: cid, messageIds: [] });
      } catch (_) { /* socket not ready */ }
    }

    // Hard-delete per-sender: a message M from sender S is doomed when every
    // other member has cleared past M. Sender's own clearedUpToMessageId is
    // ignored for their own messages.
    const clearedByUser = new Map(
      chat.users.map(m => [m.userId, m.userId === uid ? newCleared : (m.clearedUpToMessageId || 0)])
    );
    const candidates = await prisma.message.findMany({
      where: { chatId: cid },
      select: { id: true, senderId: true, imageUrl: true },
    });
    const doomed = candidates.filter(m => {
      for (const [otherId, otherCleared] of clearedByUser) {
        if (otherId === m.senderId) continue;
        if ((otherCleared || 0) < m.id) return false;
      }
      return true;
    });
    if (doomed.length) {
      const ids = doomed.map(m => m.id);
      await prisma.message.deleteMany({ where: { id: { in: ids } } });
      const { deleteS3IfOrphanBulk } = require('../utils/s3Cleanup');
      const urls = [...new Set(doomed.map(m => m.imageUrl).filter(Boolean))];
      if (urls.length) deleteS3IfOrphanBulk(urls).catch(err => console.error('socket clear-up S3 cleanup error', err));
      try {
        ioInstance && ioInstance.to(`chat_${cid}`).emit('messagesDeleted', { chatId: cid, messageIds: ids });
      } catch (_) { /* socket not ready */ }
    }
  } catch (e) {
    console.error('clearChatOnExit error:', e);
  }
}

// Hard-delete caller-owned messages, emit messagesDeleted, fire-and-forget
// orphan-only S3 cleanup. Pure function — no closure on socket/io/prisma — so it
// can be unit-tested with stubs. Returns the array of ids actually deleted.
async function deleteOwnMessages({ prisma, io, callerId, chatId, messageIds }) {
  try {
    if (!callerId) return [];
    const cid = parseInt(chatId, 10);
    let ids = Array.isArray(messageIds) ? messageIds : [];
    ids = ids.map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0);
    if (!cid || !Number.isInteger(cid) || ids.length === 0) return [];
    if (ids.length > 100) ids = ids.slice(0, 100);

    const owned = await prisma.message.findMany({
      where: { id: { in: ids }, chatId: cid, senderId: callerId },
      select: { id: true, imageUrl: true },
    });
    if (owned.length === 0) return [];

    const ownedIds = owned.map((m) => m.id);
    await prisma.message.deleteMany({ where: { id: { in: ownedIds } } });

    try {
      const urls = owned.map((m) => m.imageUrl).filter(Boolean);
      if (urls.length) {
        const { deleteS3IfOrphanBulk } = require('../utils/s3Cleanup');
        deleteS3IfOrphanBulk(urls).catch((err) =>
          console.error('deleteMessage S3 cleanup error', err)
        );
      }
    } catch (s3Err) {
      console.error('deleteMessage S3 cleanup setup error', s3Err);
    }

    try {
      io && io.to(`chat_${cid}`).emit('messagesDeleted', { chatId: cid, messageIds: ownedIds });
    } catch (_) { /* socket not ready */ }

    return ownedIds;
  } catch (err) {
    console.error('❌ deleteOwnMessages error:', err);
    return [];
  }
}

module.exports = { initSocket, getIO, clearChatOnExit, sendPushToOfflineUsers: sendPushNotificationToOfflineUsers, deleteOwnMessages };
