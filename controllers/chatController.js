// controllers/chatController.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const multer = require('multer');
const uploadToS3 = require('../utils/s3Upload');
const realtime = require('../utils/realtime');
const { notifyUser } = require('../utils/notificationService');

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();

// ✅ weekly points (single source of truth: pointsLedger.finalPoints since Monday)
const {
  getWeeklyPointsForUsers,
  getWeeklyPointsForUser,
} = require('../utils/weeklyPoints');

// ✅ Chat helpers for unread counts
const { getBulkUnreadCounts, markChatAsRead, getChatReadStatus } = require('../utils/chatHelpers');

// -------------------- AWS + Multer setup --------------------
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
function isGlobalChatName(name) {
  return typeof name === "string" && name.startsWith("Global Chat");
}


// NOTE: Plain `NOT: { name: { startsWith: "Global Chat" } }` silently
// excludes rows where name IS NULL (SQL NULL semantics: NOT NULL → NULL → false).
// Private chats have name=null, so we must explicitly include them.
const NOT_GLOBAL_CHAT_WHERE = {
  OR: [
    { name: null },
    { NOT: { name: { startsWith: "Global Chat" } } },
  ],
};

const upload = multer({ dest: 'uploads/' });


// Bi-directional block-set for a viewer. Returns the set of user-ids the viewer
// has blocked AND user-ids that have blocked the viewer. Empty set when nothing
// applies → fast-path skip for the common case (no blocks).
async function getBlockedUserIdSet(viewerId) {
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
    select: { blockerId: true, blockedId: true },
  });
  const set = new Set();
  for (const b of blocks) {
    set.add(b.blockerId === viewerId ? b.blockedId : b.blockerId);
  }
  return set;
}

const firstAvatar = (minimeArr) =>
  Array.isArray(minimeArr) && minimeArr.length > 0
    ? (minimeArr[0]?.avatarUrl || null)
    : null;

function normCityLabel(city) {
  let s = String(city || "").trim();
  if (!s) return null;


  while (/^Global Chat\s*-\s*/i.test(s)) {
    s = s.replace(/^Global Chat\s*-\s*/i, "").trim();
  }

 
  s = s.replace(/\s+/g, " ");

  return s || null;
}

async function getOrCreateGlobalChatByCity(cityLabel) {
  const label = normCityLabel(cityLabel) || "Global Chat";
  const name = `Global Chat - ${label}`;

  let chat = await prisma.chat.findFirst({
    where: {
      name,
      communityId: null,
      isCommunity: false,
    },
  });

  if (!chat) {
    chat = await prisma.chat.create({
      data: {
        name,
        isGroup: false,
        isCommunity: false,
        communityId: null,
      },
    });
  } else {
    chat = await prisma.chat.update({
      where: { id: chat.id },
      data: {
        isGroup: false,
        isCommunity: false,
        communityId: null,
      },
    });
  }

  return chat;
}
exports.getGlobalChatId = async (req, res) => {
  const userId = req.authData.id;
  const city = req.query.city;

  try {
    const chat = await getOrCreateGlobalChatByCity(city);

    let membership = await prisma.userOnChat.findFirst({
      where: { userId, chatId: chat.id },
    });

    if (!membership) {
      await prisma.userOnChat.create({
        data: { userId, chatId: chat.id, role: "MEMBER", lastSeenMessageId: 0 },
      });
    }

    const memberCount = await prisma.userOnChat.count({ where: { chatId: chat.id } });

    const last = await prisma.message.findFirst({
      where: { chatId: chat.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, content: true, imageUrl: true, createdAt: true, senderId: true,
        sender: { select: { id: true, username: true, firstName: true, lastName: true } },
      },
    });

    return res.json({
      success: true,
      chatId: chat.id,
      name: normCityLabel(chat.name) || city || "Global Chat",
      city: city || "Global Chat",
      isLocked: chat.isLocked,
      memberCount,
      latestMessage: last ? {
        id: last.id, content: last.content, imageUrl: last.imageUrl,
        createdAt: last.createdAt, senderId: last.senderId, sender: last.sender,
      } : null,
    });
  } catch (error) {
    console.error("getGlobalChatId error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.sendTextMessage = async (req, res) => {
  const userId = req.authData.id;
  // Item 9: accept optional `imageUrl` so share-to-chat (story / explore media)
  // becomes a real image message, not a URL in text.
  let { chatId, content, imageUrl } = req.body;

  try {
    chatId = parseInt(chatId, 10);
    if (!chatId || !Number.isInteger(chatId)) {
      return res.status(400).json({ message: "Valid chatId is required" });
    }

    // Either text or image is required. Caption can be empty when only sharing media.
    const trimmedContent = content ? String(content).trim() : "";
    const hasImage = imageUrl && typeof imageUrl === "string" && imageUrl.trim().length > 0;
    if (!trimmedContent && !hasImage) {
      return res.status(400).json({ message: "Message content or image is required" });
    }
    content = trimmedContent || null;

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { users: { select: { userId: true, role: true, lastSeenMessageId: true } } },
    });

    if (!chat) return res.status(404).json({ message: "Chat not found" });

    const isGlobalVariant =
      chat?.communityId === null &&
      chat?.isCommunity === false &&
      isGlobalChatName(chat?.name);

    // ✅ membership check
    const memberRow = chat.users.find((u) => u.userId === userId);

    if (!memberRow) {
      if (!isGlobalVariant) {
        return res.status(403).json({ message: "You are not a member of this chat" });
      }

      // ✅ Global room: ensure membership (RACE-SAFE)
      await prisma.userOnChat.upsert({
        where: { userId_chatId: { userId, chatId } }, // requires @@unique([userId, chatId])
        update: {},
        create: { userId, chatId, role: "MEMBER", lastSeenMessageId: 0 },
      });
    }

    // ✅ LOCK CHECK (REST)  — previously missing
    if (chat.isGroup && chat.isLocked) {
      // refresh my role
      const myRow = await prisma.userOnChat.findFirst({ where: { userId, chatId } });
      if (!myRow || myRow.role !== "ADMIN") {
        return res.status(403).json({
          message: "This group chat is locked. Only admins can send messages.",
        });
      }
    }

    // Calculate expiresAt for disappearing messages
    const VIEW_ONCE_SENTINEL = new Date('2099-01-01T00:00:00.000Z');
    const GLOBAL_CHAT_TTL_MS = 12 * 60 * 60 * 1000; // global messages disappear 12h after being sent
    let expiresAt = null;
    if (chat.disappearingSeconds === 1) {
      expiresAt = VIEW_ONCE_SENTINEL;
    } else if (chat.disappearingSeconds) {
      expiresAt = new Date(Date.now() + chat.disappearingSeconds * 1000);
    } else if (isGlobalVariant) {
      // Each global message expires independently, 12h from its own send time
      expiresAt = new Date(Date.now() + GLOBAL_CHAT_TTL_MS);
    }

    // Item 9: copy a shared media URL to a chat-owned key so the chat message
    // survives story expiry. Foreign URLs and already-chat-owned URLs pass
    // through. On copy failure, falls back to the source URL (orphan-guard
    // still keeps it alive via Message.imageUrl reference).
    let persistedImageUrl = null;
    if (hasImage) {
      const { materializeChatMedia } = require("../utils/s3Upload");
      persistedImageUrl = await materializeChatMedia(String(imageUrl).trim());
    }

    const message = await prisma.message.create({
      data: {
        chatId,
        senderId: userId,
        content,
        imageUrl: persistedImageUrl,
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
              orderBy: { updatedAt: "desc" },
              take: 1,
            },
          },
        },
      },
    });

    // ✅ keep chat fresh in list ordering
    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    });

    // ✅ Mark sender read position (like socket does)
    await prisma.userOnChat.updateMany({
      where: { userId, chatId },
      data: { lastSeenMessageId: message.id },
    });

    const formatted = {
      id: message.id,
      content: message.content,
      imageUrl: message.imageUrl,
      expiresAt: message.expiresAt,
      isSystem: message.isSystem,
      createdAt: message.createdAt,
      chatId: message.chatId,
      sender: {
        id: message.sender.id,
        username: message.sender.username,
        firstName: message.sender.firstName,
        lastName: message.sender.lastName,
        avatarUrl:
          Array.isArray(message.sender.minime) && message.sender.minime.length
            ? message.sender.minime[0].avatarUrl
            : null,
      },
    };

    try {
      const io = require("../utils/socket").getIO();
      io.to(`chat_${chatId}`).emit("newMessage", formatted);

      // Also emit to each user's personal room (ensures delivery even if
      // they haven't joined the chat room yet, e.g. newly created chats)
      const chatWithUsers = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { users: { select: { userId: true } } },
      });
      if (chatWithUsers) {
        for (const u of chatWithUsers.users) {
          if (u.userId !== userId) {
            io.to(`user:${u.userId}`).emit("newMessage", formatted);
          }
        }
      }
    } catch (socketErr) {
      console.error("sendTextMessage socket error:", socketErr);
    }

    // Push notifications for offline users.
    // Global chat sends NO notifications — only personal & group chats notify.
    if (!isGlobalVariant) {
      try {
        const { sendPushToOfflineUsers } = require("../utils/socket");
        const sender = await prisma.user.findUnique({ where: { id: userId } });
        if (sender) {
          sendPushToOfflineUsers(
            chatId,
            userId,
            sender.firstName,
            sender.lastName,
            content || ""
          );
        }
      } catch (pushErr) {
        console.error("sendTextMessage push notification error:", pushErr);
      }
    }

    return res.json({ success: true, message: formatted });
  } catch (error) {
    console.error("sendTextMessage error:", error);
    return res.status(500).json({ message: "Failed to send message" });
  }
};
exports.getGlobalChatRooms = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    // Ensure all launch cities exist in the DB (runs once per missing city)
    const LAUNCH_CITIES = [
      "Boston", "Chicago", "Dallas", "Florida", "Los Angeles",
      "Miami", "New York", "Philadelphia", "Phoenix", "San Diego",
    ];
    for (const city of LAUNCH_CITIES) {
      const name = `Global Chat - ${city}`;
      const exists = await prisma.chat.findFirst({
        where: { name, communityId: null, isCommunity: false },
        select: { id: true },
      });
      if (!exists) {
        await prisma.chat.create({
          data: { name, isGroup: false, isCommunity: false, communityId: null },
        });
      }
    }

    const where = {
      communityId: null,
      isCommunity: false,
      name: { startsWith: "Global Chat -" },
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    };

    // ✅ get chats + memberCount + latest message
    const roomsRaw = await prisma.chat.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        isLocked: true,
        updatedAt: true,
        _count: { select: { users: true } },
        users: {
          select: { userId: true, lastSeenMessageId: true, lastDeliveredMessageId: true },
        },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            content: true,
            imageUrl: true,
            createdAt: true,
            sender: {
              select: { id: true, username: true, firstName: true, lastName: true },
            },
          },
        },
      },
    });

    // ✅ normalize city & dedupe duplicates by city label
    const map = new Map(); // city => bestRoom
    for (const r of roomsRaw) {
      const city = normCityLabel(r.name.replace(/^Global Chat\s*-\s*/i, "")) || null;

      const latestMsg = r.messages?.[0] || null;
      const item = {
        chatId: r.id,
        name: city || "Global Chat",
        city,
        isLocked: r.isLocked,
        updatedAt: r.updatedAt,
        memberCount: r._count.users,
        latestMessage: latestMsg ? {
          ...latestMsg,
          readBy: r.users
            .filter(u => u.userId !== latestMsg.sender?.id && u.lastSeenMessageId && u.lastSeenMessageId >= latestMsg.id)
            .map(u => u.userId),
          deliveredTo: r.users
            .filter(u => u.userId !== latestMsg.sender?.id && u.lastDeliveredMessageId && u.lastDeliveredMessageId >= latestMsg.id)
            .map(u => u.userId),
        } : null,
      };

      // keep latest updated room for same city (dedupes dynamic + preloaded)
      const prev = map.get(city || "");
      if (!prev || new Date(item.updatedAt) > new Date(prev.updatedAt)) {
        map.set(city || "", item);
      }
    }

    const rooms = Array.from(map.values()).sort(
      (a, b) => (a.name || "").localeCompare(b.name || "")
    );

    return res.json({ success: true, rooms });
  } catch (error) {
    console.error("getGlobalChatRooms error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};


async function uploadFileToS3(filePath, bucketName, fileName) {
  const fileStream = fs.createReadStream(filePath);
  const uploadParams = {
    Bucket: bucketName,
    Key: fileName,
    Body: fileStream,
  };

  try {
    await s3Client.send(new PutObjectCommand(uploadParams));
    return `https://${bucketName}.s3.amazonaws.com/${fileName}`;
  } catch (err) {
    console.error('Error uploading file to S3:', err);
    throw err;
  }
}


exports.uploadChatImage = (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      console.error('Error uploading file:', err);
      return res.status(400).json({ error: 'Error uploading file', details: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${req.file.originalname.split('.').pop()}`;
    const filePath = req.file.path;

    try {
      const fileUrl = await uploadFileToS3(filePath, process.env.S3_BUCKET_NAME, fileName);

      const chatImage = await prisma.chatImage.create({
        data: {
          userId: req.authData.id,
          fileUrl,
        },
      });

      return res.json({ message: 'Image uploaded successfully', chatImage });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to upload file to S3', details: err.message });
    }
  });
};

exports.createPrivateChat = async (req, res) => {
  try {
    const currentUserId = req.authData.id;
    const { UserId, isGroup } = req.body;

    if (!UserId || !Array.isArray(UserId) || UserId.length === 0) {
      return res.status(400).json({ message: 'UserId is required and must be an array' });
    }

    if (!isGroup && UserId.length === 1) {
      const targetUserId = Number(UserId[0]);

  
      if (currentUserId === targetUserId) {
        return res.status(400).json({ message: 'Cannot create chat with yourself' });
      }

      const existingChats = await prisma.chat.findMany({
   where: {
  isGroup: false,
  isCommunity: false,

  // Include null-named private chats (NOT alone excludes NULLs in SQL)
  OR: [
    { name: null },
    { NOT: { name: { startsWith: "Global Chat" } } },
  ],

  AND: [
    { users: { some: { userId: currentUserId } } },
    { users: { some: { userId: targetUserId } } },
  ],
},

        include: { 
          users: { select: { userId: true } },
          _count: { select: { users: true } },
        },
      });

 
      const exactMatch = existingChats.find(chat => 
        chat._count.users === 2 && 
        chat.users.some(u => u.userId === currentUserId) &&
        chat.users.some(u => u.userId === targetUserId)
      );

      if (exactMatch) {
        return res.json({ message: 'Private chat already exists', chatId: exactMatch.id });
      }
    }


    const chat = await prisma.chat.create({
      data: {
        isGroup: isGroup || false,
        users: {
          create: [
            { userId: currentUserId, role: 'ADMIN' },
            ...UserId.map(id => ({ userId: Number(id), role: 'ADMIN' })),
          ],
        },
      },
    });

    // Notify all participants via socket so they auto-join the new chat room
    try {
      const io = require('../utils/socket').getIO();
      const allUserIds = [currentUserId, ...UserId.map(Number)];
      for (const uid of allUserIds) {
        io.to(`user:${uid}`).emit('newChat', { chatId: chat.id });
      }
    } catch (socketErr) {
      console.error('createPrivateChat socket notify error:', socketErr);
    }

    return res.json({ message: 'Chat created', chatId: chat.id });
  } catch (error) {
    console.error('Error creating chat:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.createGroupChat = async (req, res) => {
  try {
    const currentUserId = req.authData.id;
    let { userIds, name } = req.body;

    if (!name) return res.status(400).json({ message: 'Group name is required' });

    if (typeof userIds === 'string') {
      try { userIds = JSON.parse(userIds); }
      catch { userIds = [parseInt(userIds, 10)]; }
    }
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: 'At least one userId required' });
    }

    const allMemberIds = [...new Set(userIds.concat(currentUserId))].map(id => parseInt(id, 10));

    let imageUrl = null;
    if (req.file) imageUrl = await uploadToS3(req.file, 'chat-images');

    const membersCreate = allMemberIds.map(uid => ({
      userId: uid,
      role: uid === currentUserId ? 'ADMIN' : 'MEMBER',
    }));

    const created = await prisma.chat.create({
      data: {
        name,
        isGroup: true,
        imageUrl,
        createdById: currentUserId,
        users: { create: membersCreate },
      },
      include: {
        users: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                totalPoints: true,
                minime: {
                  select: { avatarUrl: true },
                  where: { isSaved: true },
                  orderBy: { updatedAt: 'desc' },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    const chat = {
      ...created,
      users: created.users.map(u => ({
        ...u,
        user: { ...u.user, avatarUrl: firstAvatar(u.user.minime) },
      })),
    };

    return res.json({ message: 'Group chat created', chat });
  } catch (error) {
    console.error('Error creating group chat:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.updateGroupChat = async (req, res) => {
  try {
    const currentUserId = req.authData.id;
    const { chatId } = req.params;
    const { name } = req.body;

    const chat = await prisma.chat.findUnique({
      where: { id: parseInt(chatId, 10) },
      include: {
        users: { where: { userId: currentUserId }, select: { role: true } },
      },
    });

    if (!chat || !chat.isGroup) return res.status(404).json({ message: 'Group chat not found' });

    const membership = chat.users[0];
    if (!membership || membership.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Only group admins can update this chat' });
    }

    let imageUrl = chat.imageUrl;
    if (req.file) imageUrl = await uploadToS3(req.file, 'chat-images');

    const updatedChat = await prisma.chat.update({
      where: { id: chat.id },
      data: {
        name: name || chat.name,
        imageUrl,
      },
      include: {
        users: {
          include: {
            user: {
              select: {
                id: true, username: true, firstName: true, lastName: true, totalPoints: true,
                minime: {
                  select: { avatarUrl: true },
                  where: { isSaved: true },
                  orderBy: { updatedAt: 'desc' },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    const flattened = {
      ...updatedChat,
      users: updatedChat.users.map(u => ({
        ...u,
        user: { ...u.user, avatarUrl: firstAvatar(u.user.minime) },
      })),
    };

    return res.json({ message: 'Group chat updated', chat: flattened });
  } catch (error) {
    console.error('Error updating group chat:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.deleteChat = async (req, res) => {
  const { chatId } = req.params;
  const currentUserId = req.authData.id;

  try {
    const chat = await prisma.chat.findUnique({
      where: { id: parseInt(chatId, 10) },
      include: { users: true },
    });

    if (!chat) return res.status(404).json({ message: 'Chat not found' });

    const userInChat = chat.users.find(u => u.userId === currentUserId);
    if (!userInChat) return res.status(403).json({ message: 'You are not part of this chat' });

  
    await prisma.$transaction(async (tx) => {

      await tx.userOnChat.delete({
        where: { id: userInChat.id }
      });

 
      const remainingUsers = await tx.userOnChat.count({
        where: { chatId: chat.id }
      });

   
      if (remainingUsers === 0 || (!chat.isGroup && remainingUsers === 1)) {
        await tx.chat.delete({ where: { id: chat.id } });
      }
    });

    return res.json({ message: 'Chat deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Delete multiple chats (participant only for each) - removes user from chats instead of deleting entire chats
exports.deleteBulkChats = async (req, res) => {
  const { chatIds } = req.body;
  const currentUserId = req.authData.id;

  try {
    // Validate input
    if (!chatIds || !Array.isArray(chatIds) || chatIds.length === 0) {
      return res.status(400).json({ message: 'Chat IDs array is required' });
    }

    // Convert all IDs to integers and validate
    const validChatIds = chatIds.map(id => {
      const parsedId = parseInt(id, 10);
      if (isNaN(parsedId)) {
        throw new Error(`Invalid chat ID: ${id}`);
      }
      return parsedId;
    });

    // Find all chats with their users
    const chats = await prisma.chat.findMany({
      where: { 
        id: { in: validChatIds } 
      },
      include: { users: true },
    });

    // Check if all requested chats exist
    const foundChatIds = chats.map(chat => chat.id);
    const missingChatIds = validChatIds.filter(id => !foundChatIds.includes(id));
    
    if (missingChatIds.length > 0) {
      return res.status(404).json({ 
        message: 'Some chats not found', 
        missingChatIds 
      });
    }

    // Check if user is participant in all chats and collect user-chat relationships
    const unauthorizedChats = [];
    const userChatRelations = [];

    chats.forEach(chat => {
      const userInChat = chat.users.find(u => u.userId === currentUserId);
      if (!userInChat) {
        unauthorizedChats.push(chat.id);
      } else {
        userChatRelations.push({
          chatId: chat.id,
          userOnChatId: userInChat.id,
          isGroup: chat.isGroup,
          totalUsers: chat.users.length
        });
      }
    });

    if (unauthorizedChats.length > 0) {
      return res.status(403).json({ 
        message: 'You are not authorized to delete some chats', 
        unauthorizedChats 
      });
    }

    // Process each chat deletion in a transaction
    const processedChatIds = [];
    const chatsToDelete = [];

    await prisma.$transaction(async (tx) => {
      for (const relation of userChatRelations) {
        // Remove the user from the chat
        await tx.userOnChat.delete({
          where: { id: relation.userOnChatId }
        });

        processedChatIds.push(relation.chatId);

        // Check if chat should be completely deleted
        // For private chats: delete if only 1 user remains
        // For group chats: delete if no users remain
        const remainingUsers = relation.totalUsers - 1;
        
        if (remainingUsers === 0 || (!relation.isGroup && remainingUsers === 1)) {
          chatsToDelete.push(relation.chatId);
        }
      }

      // Delete empty chats or private chats with only 1 user left
      if (chatsToDelete.length > 0) {
        await tx.chat.deleteMany({
          where: { id: { in: chatsToDelete } }
        });
      }
    });

    return res.json({ 
      message: 'Chats processed successfully',
      processedCount: processedChatIds.length,
      processedChatIds: processedChatIds,
      completelyDeletedChats: chatsToDelete
    });
  } catch (error) {
    console.error('Error deleting bulk chats:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
// Get my chats (includes participants + weekly points via ledger)
exports.getMyChats = async (req, res) => {
  const currentUserId = req.authData.id;

  try {


const chats = await prisma.chat.findMany({
  where: {
    users: { some: { userId: currentUserId } },
    ...NOT_GLOBAL_CHAT_WHERE,          // ✅ Global variants বাদ
  },


      include: {
        users: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                totalPoints: true,
                minime: {
                  select: { avatarUrl: true },
                  where: { isSaved: true },
                  orderBy: { updatedAt: 'desc' },
                  take: 1,
                },
              },
            },
          },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1, // Only get latest message for preview
          select: {
            id: true,
            content: true,
            imageUrl: true,
            createdAt: true,
            senderId: true,
          },
        },
        _count: {
          select: { messages: true }, // Total message count
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // নিচের enriched part আগের মতোই থাকবে ⬇
    const allUserIds = Array.from(
      new Set(chats.flatMap(c => c.users.map(u => u.userId)))
    );
    const weekPointsMap = await getWeeklyPointsForUsers(allUserIds);

    const chatIds = chats.map(c => c.id);
    const unreadCountsMap = await getBulkUnreadCounts(currentUserId, chatIds);

    // Block-aware preview (item 4): if the chat's latest message is from a
    // blocked user, show "[blocked]" in the preview instead of the raw content.
    // Read-path filtering for full message lists is in getMessages.
    const blockedIds = await getBlockedUserIdSet(currentUserId);

    const enrichedChats = chats.map(chat => {
      const chatUsers = chat.users.map(userOnChat => {
        const u = userOnChat.user;
        return {
          id: u.id,
          username: u.username,
          firstName: u.firstName || null,
          lastName: u.lastName || null,
          avatarUrl: firstAvatar(u.minime),
          totalPoints: u.totalPoints || 0,
          thisWeekPoints: weekPointsMap.get(u.id) || 0,
          profileUrl: `/api/users/${u.id}/profile`,
          role: userOnChat.role,
          joinedAt: userOnChat.joinedAt
        };
      });

      const currentUserOnChat = chat.users.find(u => u.userId === currentUserId);
      const isMuted = currentUserOnChat?.isMuted || false;
      const unreadCount = isMuted ? 0 : (unreadCountsMap.get(chat.id) || 0);
      // disappear-on-exit: messages this user cleared by leaving must not show
      // as the chat-list preview (keeps the list consistent with the open chat).
      const myCleared = currentUserOnChat?.clearedUpToMessageId || 0;
      let latestMessage =
        chat.messages.length > 0 && chat.messages[0].id > myCleared
          ? chat.messages[0]
          : null;

      // If the last message is from a blocked user, scrub the preview.
      if (latestMessage && blockedIds.has(latestMessage.senderId)) {
        latestMessage = { ...latestMessage, content: '[blocked]', imageUrl: null };
      }

      // Derive a clear chatType: 'personal' | 'group' | 'community'
      const chatType = chat.isCommunity ? 'community'
        : chat.isGroup ? 'group'
        : 'personal';

      // Per-user effective sort time: max of latest-message time and THIS user's
      // joinedAt. Ensures a newly-accepted friend chat / freshly-joined community
      // chat appears at top for the joining user without reordering for others.
      const lastMsgAt = latestMessage?.createdAt ? new Date(latestMessage.createdAt).getTime() : 0;
      const joinedAtMs = currentUserOnChat?.joinedAt ? new Date(currentUserOnChat.joinedAt).getTime() : 0;
      const _sortTime = Math.max(lastMsgAt, joinedAtMs);

      return {
        ...chat,
        chatType,
        users: chatUsers,
        unreadCount,
        isMuted,
        latestMessage: latestMessage ? {
          id: latestMessage.id,
          content: latestMessage.content,
          imageUrl: latestMessage.imageUrl,
          createdAt: latestMessage.createdAt,
          senderId: latestMessage.senderId,
          readBy: chat.users
            .filter(u => u.userId !== latestMessage.senderId && u.lastSeenMessageId && u.lastSeenMessageId >= latestMessage.id)
            .map(u => u.userId),
          deliveredTo: chat.users
            .filter(u => u.userId !== latestMessage.senderId && u.lastDeliveredMessageId && u.lastDeliveredMessageId >= latestMessage.id)
            .map(u => u.userId),
        } : null,
        totalMessages: chat._count.messages,
        _sortTime,
      };
    });

    // Re-sort per-user: newest activity OR newest join. Drop internal field.
    enrichedChats.sort((a, b) => (b._sortTime || 0) - (a._sortTime || 0));
    enrichedChats.forEach(c => { delete c._sortTime; });

    res.json(enrichedChats);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.getMessages = async (req, res) => {
  const { chatId } = req.params;
  const userId = req.authData.id;

  try {
    const cid = parseInt(chatId, 10);
    const now = new Date();
    // disappear-on-exit: hide messages this user already cleared by leaving.
    // Non-immediate chats keep clearedUpToMessageId = 0, so this is a no-op there.
    const myRow = await prisma.userOnChat.findFirst({
      where: { userId, chatId: cid },
      select: { clearedUpToMessageId: true },
    });
    const cleared = myRow?.clearedUpToMessageId || 0;

    // Block-aware filter (item 4): hide messages from users I blocked or who
    // blocked me. Skipped when the user has no blocks (the common case).
    const blockedIds = await getBlockedUserIdSet(userId);
    const messageWhere = {
      chatId: cid,
      id: { gt: cleared },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };
    if (blockedIds.size > 0) {
      messageWhere.senderId = { notIn: [...blockedIds] };
    }

    const messages = await prisma.message.findMany({
      where: messageWhere,
      include: {
        sender: {
          select: {
            id: true, username: true, firstName: true, lastName: true,
            email: true, phone: true, isVerified: true,
            bio: true, bodyType: true, bodyShapeUrl: true,
            totalPoints: true, createdAt: true, updatedAt: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              orderBy: { updatedAt: 'desc' },
              take: 1,
            },
          },
        },
        // Item 8: quoted message for the reply bubble.
        replyTo: {
          select: {
            id: true, content: true, imageUrl: true, senderId: true,
            sender: { select: { username: true, firstName: true, lastName: true } },
          },
        },
        chat: {
          include: {
            users: { select: { userId: true, lastSeenMessageId: true, lastDeliveredMessageId: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const formatted = messages.map(m => ({
      id: m.id,
      content: m.content,
      imageUrl: m.imageUrl,
      isSystem: m.isSystem || false,
      expiresAt: m.expiresAt || null,
      createdAt: m.createdAt,
      chatId: m.chatId,
      sender: {
        id: m.sender.id,
        username: m.sender.username,
        firstName: m.sender.firstName,
        lastName: m.sender.lastName,
        avatarUrl: firstAvatar(m.sender.minime),
      },
      // Items 6 + 8 (additive — old clients that don't expect these keys ignore them)
      forwarded: m.forwarded || false,
      replyTo: m.replyTo
        ? {
            id: m.replyTo.id,
            content: m.replyTo.content,
            imageUrl: m.replyTo.imageUrl,
            senderId: m.replyTo.senderId,
            senderName: [m.replyTo.sender?.firstName, m.replyTo.sender?.lastName]
              .filter(Boolean).join(' ') || m.replyTo.sender?.username || null,
          }
        : null,
      readBy: m.chat.users
        .filter(u => u.userId !== m.senderId && u.lastSeenMessageId && u.lastSeenMessageId >= m.id)
        .map(u => u.userId),
      deliveredTo: m.chat.users
        .filter(u => u.userId !== m.senderId && u.lastDeliveredMessageId && u.lastDeliveredMessageId >= m.id)
        .map(u => u.userId),
    }));

    res.json(formatted);
  } catch (error) {
    console.error('getMessages error:', error);
    res.status(500).json({ message: 'Failed to fetch messages' });
  }
};

// Simple descending pagination
exports.getMessagesPaginated = async (req, res) => {
  const { chatId } = req.params;
  const userId = req.authData.id;
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  try {
    const cid = parseInt(chatId, 10);
    const now = new Date();
    // disappear-on-exit per-user filter (no-op for non-immediate chats).
    const myRow = await prisma.userOnChat.findFirst({
      where: { userId, chatId: cid },
      select: { clearedUpToMessageId: true },
    });
    const cleared = myRow?.clearedUpToMessageId || 0;

    // Block-aware filter (item 4) — see getMessages above.
    const blockedIds = await getBlockedUserIdSet(userId);
    const messageWhere = {
      chatId: cid,
      id: { gt: cleared },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };
    if (blockedIds.size > 0) {
      messageWhere.senderId = { notIn: [...blockedIds] };
    }

    const messages = await prisma.message.findMany({
      where: messageWhere,
      include: {
        sender: {
          select: {
            id: true, username: true, firstName: true, lastName: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              orderBy: { updatedAt: 'asc' },
              take: 1,
            },
          },
        },
        // Item 8: quoted message for the reply bubble.
        replyTo: {
          select: {
            id: true, content: true, imageUrl: true, senderId: true,
            sender: { select: { username: true, firstName: true, lastName: true } },
          },
        },
        chat: {
          include: {
            users: { select: { userId: true, lastSeenMessageId: true, lastDeliveredMessageId: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit, 10),
    });

    const formatted = messages.map(m => ({
      id: m.id,
      content: m.content,
      imageUrl: m.imageUrl,
      isSystem: m.isSystem || false,
      expiresAt: m.expiresAt || null,
      createdAt: m.createdAt,
      chatId: m.chatId,
      sender: {
        id: m.sender.id,
        username: m.sender.username,
        firstName: m.sender.firstName,
        lastName: m.sender.lastName,
        avatarUrl: firstAvatar(m.sender.minime),
      },
      // Items 6 + 8 (additive)
      forwarded: m.forwarded || false,
      replyTo: m.replyTo
        ? {
            id: m.replyTo.id,
            content: m.replyTo.content,
            imageUrl: m.replyTo.imageUrl,
            senderId: m.replyTo.senderId,
            senderName: [m.replyTo.sender?.firstName, m.replyTo.sender?.lastName]
              .filter(Boolean).join(' ') || m.replyTo.sender?.username || null,
          }
        : null,
      readBy: m.chat.users
        .filter(u => u.userId !== m.senderId && u.lastSeenMessageId && u.lastSeenMessageId >= m.id)
        .map(u => u.userId),
      deliveredTo: m.chat.users
        .filter(u => u.userId !== m.senderId && u.lastDeliveredMessageId && u.lastDeliveredMessageId >= m.id)
        .map(u => u.userId),
    }));

    res.json(formatted);
  } catch (e) {
    console.error('Error fetching paginated messages:', e);
    res.status(500).json({ message: 'Server error' });
  }
};
// Find chats that contain only the two specified users
exports.getChatsByUsers = async (req, res) => {
  const user1Id = req.authData.id;
  const user2Id = parseInt(req.params.user2Id, 10);
  if (isNaN(user2Id)) return res.status(400).json({ message: 'Invalid user ID' });

  try {
 const chats = await prisma.chat.findMany({
  where: {
    ...NOT_GLOBAL_CHAT_WHERE, 

    users: {
      every: { userId: { in: [user1Id, user2Id] } },
    },
  },
  include: { users: { select: { userId: true } } },
});


    const result = chats
      .filter(c => {
        const set = new Set(c.users.map(u => u.userId));
        return set.has(user1Id) && set.has(user2Id) && set.size <= 2;
      })
      .map(c => ({ chatId: c.id }));

    res.json(result);
  } catch (e) {
    console.error('Error fetching chats:', e);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.addUsersToGroup = async (req, res) => {
  const { chatId } = req.params;
  const { userIds } = req.body;
  const currentUserId = req.authData.id;

  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ message: 'User IDs required' });
  }

  const chat = await prisma.chat.findUnique({
    where: { id: parseInt(chatId, 10) },
    include: { users: true },
  });
  if (!chat || !chat.isGroup) {
    return res.status(404).json({ message: 'Group chat not found' });
  }

  const me = chat.users.find(u => u.userId === currentUserId);
  if (!me || me.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Only admins can add users.' });
  }

  const existing = new Set(chat.users.map(u => u.userId));
  let toAdd = userIds.map(Number).filter(id => !existing.has(id));

  // Item 5b: block re-add of banned users.
  if (toAdd.length) {
    const bans = await prisma.chatBan.findMany({
      where: { chatId: chat.id, userId: { in: toAdd } },
      select: { userId: true },
    });
    if (bans.length) {
      const bannedSet = new Set(bans.map((b) => b.userId));
      toAdd = toAdd.filter((id) => !bannedSet.has(id));
      if (!toAdd.length) {
        return res.status(403).json({
          message: 'All selected users are banned from this group',
          bannedUserIds: [...bannedSet],
        });
      }
    }
  }

  if (!toAdd.length) {
    return res.status(400).json({ message: 'All users are already in the group' });
  }

  await prisma.chat.update({
    where: { id: chat.id },
    data: {
      users: { 
        create: toAdd.map(id => ({
          userId: id, 
          role: 'MEMBER',
          lastSeenMessageId: 0 // ✅ Initialize read position
        }))
      },
    },
  });

  // ✅ Notify via socket about new members added
  try {
    const io = require('../utils/socket').getIO();
    io.to(`chat_${chat.id}`).emit('usersAdded', {
      chatId: chat.id,
      addedUserIds: toAdd,
      addedBy: currentUserId,
    });
  } catch (socketErr) {
    console.error('Socket notification error:', socketErr);
  }

  // Realtime: group member list / participant count refresh + added users' own lists
  realtime.toGroup(chat.id, 'group.member_added', { chatId: chat.id, addedUserIds: toAdd });
  realtime.toUsers(toAdd, 'group.member_added', { chatId: chat.id });

  return res.json({ message: 'Users added to the group chat' });
};

// Remove a user from a group (admin only; protect last admin)
exports.removeUserFromGroup = async (req, res) => {
  const { chatId, userId } = req.params;
  const currentUserId = req.authData.id;

  const chat = await prisma.chat.findUnique({
    where: { id: parseInt(chatId, 10) },
    include: { users: true },
  });
  if (!chat || !chat.isGroup) {
    return res.status(404).json({ message: 'Group chat not found' });
  }

  const me = chat.users.find(u => u.userId === currentUserId);
  if (!me || me.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Only admins can remove users.' });
  }

  const targetUserId = parseInt(userId, 10);
  const target = chat.users.find(u => u.userId === targetUserId);
  if (!target) return res.status(404).json({ message: 'User is not in this group.' });

  if (target.role === 'ADMIN') {
    const adminCount = chat.users.filter(u => u.role === 'ADMIN').length;
    const otherMembersExist = chat.users.some(u => u.userId !== targetUserId);
    if (adminCount <= 1 && otherMembersExist) {
      return res.status(400).json({ message: 'Cannot remove the last admin. Promote another user first.' });
    }
  }

  await prisma.userOnChat.delete({ where: { id: target.id } });

  // Realtime: remaining members refresh + removed user's own group/chat list
  realtime.toGroup(chat.id, 'group.member_removed', { chatId: chat.id, userId: targetUserId });
  realtime.toUser(targetUserId, 'group.member_removed', { chatId: chat.id, userId: targetUserId });

  return res.json({ message: 'User removed from group.' });
};

// Leave a group (promote someone if you’re the last admin; delete if last member)
exports.leaveGroup = async (req, res) => {
  const { chatId } = req.params;
  const currentUserId = req.authData.id;

  const chat = await prisma.chat.findUnique({
    where: { id: parseInt(chatId, 10) },
    include: { users: true },
  });
  if (!chat || !chat.isGroup) {
    return res.status(404).json({ message: 'Group chat not found' });
  }

  const myRow = chat.users.find(u => u.userId === currentUserId);
  if (!myRow) return res.status(403).json({ message: 'You are not in this group' });

  const otherUsers = chat.users.filter(u => u.userId !== currentUserId);
  const adminCount = chat.users.filter(u => u.role === 'ADMIN').length;

  await prisma.$transaction(async (tx) => {
    if (otherUsers.length === 0) {
      await tx.chat.delete({ where: { id: chat.id } });
      return;
    }

    if (myRow.role === 'ADMIN' && adminCount <= 1) {
      const candidate = otherUsers.sort((a, b) => a.id - b.id)[0];
      await tx.userOnChat.update({ where: { id: candidate.id }, data: { role: 'ADMIN' } });
    }

    await tx.userOnChat.delete({ where: { id: myRow.id } });
  });

  // Realtime: remaining members refresh member list / participant count
  realtime.toGroup(chat.id, 'group.member_left', { chatId: chat.id, userId: currentUserId });

  return res.json({ message: 'You left the group.' });
};

// Group members (with role/joinedAt + avatar)
exports.getGroupMembers = async (req, res) => {
  const { chatId } = req.params;

  try {
    const chat = await prisma.chat.findUnique({
      where: { id: parseInt(chatId, 10) },
      include: {
        users: {
          include: {
            user: {
              select: {
                id: true, username: true, firstName: true, lastName: true, totalPoints: true,
                minime: {
                  select: { avatarUrl: true },
                  where: { isSaved: true },
                  orderBy: { updatedAt: 'desc' },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    if (!chat || !chat.isGroup) {
      return res.status(404).json({ message: 'Group not found' });
    }

    // ✅ Batch weekly points for all group members
    const memberUserIds = chat.users.map(u => u.user.id);
    const weekPointsMap = await getWeeklyPointsForUsers(memberUserIds);

    const members = chat.users.map(u => ({
      id: u.user.id,
      username: u.user.username,
      firstName: u.user.firstName,
      lastName: u.user.lastName,
      avatarUrl: firstAvatar(u.user.minime),
      totalPoints: u.user.totalPoints || 0,
      thisWeekPoints: weekPointsMap.get(u.user.id) || 0,
      profileUrl: `/api/users/${u.user.id}/profile`,
      role: u.role,
      joinedAt: u.joinedAt,
    }));

    return res.json({
      groupId: chat.id,
      groupName: chat.name,
      groupImage: chat.imageUrl || null,
      createdById: chat.createdById,
      isLocked: chat.isLocked || false,
      members,
    });
  } catch (error) {
    console.error('Error fetching group members:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Edit group chat (multipart; admin only)
exports.editGroupChat = (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ error: 'File upload failed', details: err.message });
    }

    const { chatId } = req.params;
    const { name } = req.body;
    const currentUserId = req.authData.id;

    try {
      const chat = await prisma.chat.findUnique({
        where: { id: parseInt(chatId, 10) },
        include: { users: true },
      });

      if (!chat || !chat.isGroup) {
        return res.status(404).json({ message: 'Group chat not found' });
      }

      const me = chat.users.find(u => u.userId === currentUserId);
      if (!me || me.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Only admins can edit the group' });
      }

      let imageUrl = chat.imageUrl || null;
      if (req.file) imageUrl = await uploadToS3(req.file, 'chat-images');

      const updated = await prisma.chat.update({
        where: { id: chat.id },
        data: { name: name || chat.name, imageUrl },
        include: { users: { include: { user: { select: { id: true, username: true } } } } },
      });

      return res.json({ message: 'Group chat updated', chat: updated });
    } catch (error) {
      console.error('Error editing group chat:', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });
};

// Lock group chat (admin only) - only admins can send messages
exports.lockGroupChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const currentUserId = req.authData.id;

    const chat = await prisma.chat.findUnique({
      where: { id: parseInt(chatId, 10) },
      include: { 
        users: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true
              }
            }
          }
        }
      },
    });

    if (!chat) {
      return res.status(404).json({ message: 'Chat not found' });
    }

    if (!chat.isGroup) {
      return res.status(400).json({ message: 'This action is only available for group chats' });
    }

    // Check if user is admin of this group
    const userInChat = chat.users.find(u => u.userId === currentUserId);
    if (!userInChat || userInChat.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Only group admins can lock the chat' });
    }

    if (chat.isLocked) {
      return res.status(400).json({ message: 'Group chat is already locked' });
    }

    // Update chat to locked status
    const updatedChat = await prisma.chat.update({
      where: { id: parseInt(chatId, 10) },
      data: { isLocked: true },
      include: {
        users: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true
              }
            }
          }
        }
      }
    });

    // Emit socket event to notify all group members
    const io = require('../utils/socket').getIO();
    io.to(`chat_${chatId}`).emit('chatLocked', {
      chatId: parseInt(chatId, 10),
      isLocked: true,
      lockedBy: {
        id: currentUserId,
        username: userInChat.user.username,
        firstName: userInChat.user.firstName,
        lastName: userInChat.user.lastName
      },
      message: 'Group chat has been locked by admin. Only admins can send messages.'
    });

    return res.json({ 
      message: 'Group chat locked successfully',
      chat: {
        id: updatedChat.id,
        name: updatedChat.name,
        isGroup: updatedChat.isGroup,
        isLocked: updatedChat.isLocked,
        imageUrl: updatedChat.imageUrl
      }
    });
  } catch (error) {
    console.error('Error locking group chat:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Unlock group chat (admin only) - all members can send messages
exports.unlockGroupChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const currentUserId = req.authData.id;

    const chat = await prisma.chat.findUnique({
      where: { id: parseInt(chatId, 10) },
      include: { 
        users: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true
              }
            }
          }
        }
      },
    });

    if (!chat) {
      return res.status(404).json({ message: 'Chat not found' });
    }

    if (!chat.isGroup) {
      return res.status(400).json({ message: 'This action is only available for group chats' });
    }

    // Check if user is admin of this group
    const userInChat = chat.users.find(u => u.userId === currentUserId);
    if (!userInChat || userInChat.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Only group admins can unlock the chat' });
    }

    if (!chat.isLocked) {
      return res.status(400).json({ message: 'Group chat is already unlocked' });
    }

    // Update chat to unlocked status
    const updatedChat = await prisma.chat.update({
      where: { id: parseInt(chatId, 10) },
      data: { isLocked: false },
      include: {
        users: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true
              }
            }
          }
        }
      }
    });

    // Emit socket event to notify all group members
    const io = require('../utils/socket').getIO();
    io.to(`chat_${chatId}`).emit('chatUnlocked', {
      chatId: parseInt(chatId, 10),
      isLocked: false,
      unlockedBy: {
        id: currentUserId,
        username: userInChat.user.username,
        firstName: userInChat.user.firstName,
        lastName: userInChat.user.lastName
      },
      message: 'Group chat has been unlocked by admin. All members can now send messages.'
    });

    return res.json({ 
      message: 'Group chat unlocked successfully',
      chat: {
        id: updatedChat.id,
        name: updatedChat.name,
        isGroup: updatedChat.isGroup,
        isLocked: updatedChat.isLocked,
        imageUrl: updatedChat.imageUrl
      }
    });
  } catch (error) {
    console.error('Error unlocking group chat:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};



// 🚀 NEW: Mark entire chat as read (simpler approach)
exports.markChatAsRead = async (req, res) => {
  try {
    const currentUserId = req.authData.id;
    const { chatId } = req.body;

    if (!chatId) {
      return res.status(400).json({ message: 'chatId is required' });
    }

    // Verify user is part of the chat
    const userInChat = await prisma.userOnChat.findFirst({
      where: { userId: currentUserId, chatId: parseInt(chatId, 10) },
    });

    if (!userInChat) {
      return res.status(403).json({ message: 'You are not part of this chat' });
    }

    // Get the latest message in this chat
    const latestMessage = await prisma.message.findFirst({
      where: { chatId: parseInt(chatId, 10) },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    });

    if (!latestMessage) {
      return res.json({ 
        message: 'No messages in chat to mark as read',
        chatId: parseInt(chatId, 10),
        success: true
      });
    }

    // Update lastSeenMessageId to the latest message
    const updated = await prisma.userOnChat.update({
      where: { id: userInChat.id },
      data: { lastSeenMessageId: latestMessage.id }
    });

    console.log(`✅ Updated UserOnChat for user ${currentUserId} in chat ${chatId}:`, {
      userOnChatId: userInChat.id,
      oldLastSeenMessageId: userInChat.lastSeenMessageId,
      newLastSeenMessageId: latestMessage.id,
      updatedRecord: updated
    });

    // Emit socket event to notify other users (optional)
    try {
      const io = require('../utils/socket').getIO();
      io.to(`chat_${chatId}`).emit('chatRead', {
        chatId: parseInt(chatId, 10),
        userId: currentUserId,
        readAt: new Date().toISOString()
      });
    } catch (socketErr) {
      console.error('Socket emission error:', socketErr);
    }

    // View-once: schedule deletion 5s after recipient reads
    const cid = parseInt(chatId, 10);
    const chat = await prisma.chat.findUnique({
      where: { id: cid },
      select: { disappearingSeconds: true },
    });
    if (chat && chat.disappearingSeconds === 1) {
      const VIEW_ONCE_SENTINEL = new Date('2099-01-01T00:00:00.000Z');
      const viewOnceMessages = await prisma.message.findMany({
        where: {
          chatId: cid,
          id: { lte: latestMessage.id },
          isSystem: false,
          expiresAt: VIEW_ONCE_SENTINEL,
          senderId: { not: currentUserId },
        },
        select: { id: true, imageUrl: true },
      });
      if (viewOnceMessages.length > 0) {
        const msgIds = viewOnceMessages.map(m => m.id);
        const imageUrls = viewOnceMessages.map(m => m.imageUrl).filter(Boolean);
        setTimeout(async () => {
          try {
            await prisma.message.deleteMany({ where: { id: { in: msgIds } } });
            // Orphan-only S3 cleanup — same URL may live on a SavedStory clone
            // or other table; skip the S3 delete when still referenced.
            const { deleteS3IfOrphanBulk } = require('../utils/s3Cleanup');
            const uniqUrls = [...new Set(imageUrls)];
            if (uniqUrls.length) await deleteS3IfOrphanBulk(uniqUrls);
            const io = require('../utils/socket').getIO();
            io.to(`chat_${cid}`).emit('messagesDeleted', { chatId: cid, messageIds: msgIds });
          } catch (e) {
            console.error('View-once delete error:', e);
          }
        }, 5000);
      }
    }

    return res.json({
      message: 'Chat marked as read',
      chatId: cid,
      lastSeenMessageId: latestMessage.id,
      success: true
    });
  } catch (error) {
    console.error('Error in markChatAsRead:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// 🚀 NEW: Get chat read status
exports.getChatReadStatus = async (req, res) => {
  try {
    const currentUserId = req.authData.id;
    const { chatId } = req.params;

    if (!chatId) {
      return res.status(400).json({ message: 'chatId is required' });
    }

    // Verify user is part of the chat
    const userInChat = await prisma.userOnChat.findFirst({
      where: { userId: currentUserId, chatId: parseInt(chatId, 10) },
      include: {
        chat: {
          include: {
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true, createdAt: true }
            }
          }
        }
      }
    });

    if (!userInChat) {
      return res.status(403).json({ message: 'You are not part of this chat' });
    }

    const latestMessage = userInChat.chat.messages[0];
    const isRead = latestMessage ? 
      userInChat.lastSeenMessageId >= latestMessage.id : true;

    return res.json({
      chatId: parseInt(chatId, 10),
      lastSeenMessageId: userInChat.lastSeenMessageId,
      latestMessageId: latestMessage?.id || 0,
      isRead,
      success: true
    });
  } catch (error) {
    console.error('Error in getChatReadStatus:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getUnreadChats = async (req, res) => {
  const currentUserId = req.authData.id;

  try {
 

const chats = await prisma.chat.findMany({
  where: {
    users: { some: { userId: currentUserId } },
    ...NOT_GLOBAL_CHAT_WHERE,    
  },

      include: {
        users: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                totalPoints: true,
                minime: {
                  select: { avatarUrl: true },
                  where: { isSaved: true },
                  orderBy: { updatedAt: 'desc' },
                  take: 1,
                },
              },
            },
          },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, content: true, imageUrl: true, createdAt: true, senderId: true },
        },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

 
    const allUserIds = Array.from(
      new Set(chats.flatMap(c => c.users.map(u => u.userId)))
    );
    const weekPointsMap = await getWeeklyPointsForUsers(allUserIds);

    // ✅ Get accurate unread counts for all chats
    const chatIds = chats.map(c => c.id);
    const unreadCountsMap = await getBulkUnreadCounts(currentUserId, chatIds);

    const blockedIds = await getBlockedUserIdSet(currentUserId);

    const enrichedChats = chats.map(chat => {
      const chatUsers = chat.users.map(userOnChat => {
        const u = userOnChat.user;
        return {
          id: u.id,
          username: u.username,
          firstName: u.firstName || null,
          lastName: u.lastName || null,
          avatarUrl: firstAvatar(u.minime),
          totalPoints: u.totalPoints || 0,
          thisWeekPoints: weekPointsMap.get(u.id) || 0,
          profileUrl: `/api/users/${u.id}/profile`,
          role: userOnChat.role,
          joinedAt: userOnChat.joinedAt
        };
      });

      const currentUserOnChat = chat.users.find(u => u.userId === currentUserId);
      const isMuted = currentUserOnChat?.isMuted || false;
      const unreadCount = isMuted ? 0 : (unreadCountsMap.get(chat.id) || 0);

      let latestMessage = chat.messages.length > 0
        ? chat.messages[0]
        : null;

      // Block-aware preview (item 4): scrub if from a blocked user.
      if (latestMessage && blockedIds.has(latestMessage.senderId)) {
        latestMessage = { ...latestMessage, content: '[blocked]', imageUrl: null };
      }

      return {
        ...chat,
        users: chatUsers,
        unreadCount,
        isMuted,
        latestMessage: latestMessage ? {
          id: latestMessage.id,
          content: latestMessage.content,
          imageUrl: latestMessage.imageUrl,
          createdAt: latestMessage.createdAt,
          senderId: latestMessage.senderId,
          readBy: chat.users
            .filter(u => u.userId !== latestMessage.senderId && u.lastSeenMessageId && u.lastSeenMessageId >= latestMessage.id)
            .map(u => u.userId),
          deliveredTo: chat.users
            .filter(u => u.userId !== latestMessage.senderId && u.lastDeliveredMessageId && u.lastDeliveredMessageId >= latestMessage.id)
            .map(u => u.userId),
        } : null,
        totalMessages: chat._count.messages
      };
    });

    const unreadChats = enrichedChats.filter(chat => chat.unreadCount > 0);

    res.json(unreadChats);
  } catch (error) {
    console.error('Error fetching unread chats:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.getMyGroupChats = async (req, res) => {
  const currentUserId = req.authData.id;

  try {
    const chats = await prisma.chat.findMany({
      where: { 
        users: { some: { userId: currentUserId } },
        isGroup: true // ✅ Only group chats
      },
      include: {
        users: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                totalPoints: true,
                minime: {
                  select: { avatarUrl: true },
                  where: { isSaved: true },
                  orderBy: { updatedAt: 'desc' },
                  take: 1,
                },
              },
            },
          },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            content: true,
            imageUrl: true,
            createdAt: true,
            senderId: true,
          },
        },
        _count: {
          select: { messages: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // ✅ Batch weekly points for all unique users across all chats
    const allUserIds = Array.from(
      new Set(chats.flatMap(c => c.users.map(u => u.userId)))
    );
    const weekPointsMap = await getWeeklyPointsForUsers(allUserIds);

    // ✅ Get accurate unread counts for all chats
    const chatIds = chats.map(c => c.id);
    const unreadCountsMap = await getBulkUnreadCounts(currentUserId, chatIds);

    const blockedIds = await getBlockedUserIdSet(currentUserId);

    const enrichedChats = chats.map(chat => {
      let latestMessage = chat.messages[0] || null;
      // Block-aware preview (item 4): scrub if from a blocked user.
      if (latestMessage && blockedIds.has(latestMessage.senderId)) {
        latestMessage = { ...latestMessage, content: '[blocked]', imageUrl: null };
      }

      const enrichedUsers = chat.users.map(userOnChat => {
        const weekPoints = weekPointsMap[userOnChat.userId] || 0;
        return {
          id: userOnChat.user.id,
          username: userOnChat.user.username,
          firstName: userOnChat.user.firstName,
          lastName: userOnChat.user.lastName,
          avatarUrl: firstAvatar(userOnChat.user.minime),
          totalPoints: userOnChat.user.totalPoints,
          thisWeekPoints: weekPoints,
          profileUrl: `/api/users/${userOnChat.user.id}/profile`,
          role: userOnChat.role,
          joinedAt: userOnChat.joinedAt,
        };
      });

      let readBy = [];
      let deliveredTo = [];
      if (latestMessage) {
        readBy = chat.users
          .filter(u => u.userId !== latestMessage.senderId && u.lastSeenMessageId && u.lastSeenMessageId >= latestMessage.id)
          .map(u => u.userId);
        deliveredTo = chat.users
          .filter(u => u.userId !== latestMessage.senderId && u.lastDeliveredMessageId && u.lastDeliveredMessageId >= latestMessage.id)
          .map(u => u.userId);
      }

      // Per-user effective sort time: max of latest-message and joinedAt.
      // See getMyChats for rationale.
      const currentUserOnChat = chat.users.find(u => u.userId === currentUserId);
      const lastMsgAt = latestMessage?.createdAt ? new Date(latestMessage.createdAt).getTime() : 0;
      const joinedAtMs = currentUserOnChat?.joinedAt ? new Date(currentUserOnChat.joinedAt).getTime() : 0;
      const _sortTime = Math.max(lastMsgAt, joinedAtMs);

      return {
        id: chat.id,
        name: chat.name,
        isGroup: chat.isGroup,
        isCommunity: chat.isCommunity,
        isLocked: chat.isLocked,
        communityId: chat.communityId,
        imageUrl: chat.imageUrl,
        updatedAt: chat.updatedAt,
        createdAt: chat.createdAt,
        createdById: chat.createdById,
        users: enrichedUsers,
        messages: latestMessage ? [latestMessage] : [],
        _count: { messages: chat._count.messages },
        unreadCount: (chat.users.find(u => u.userId === currentUserId)?.isMuted)
          ? 0 : (unreadCountsMap[chat.id] || 0),
        isMuted: chat.users.find(u => u.userId === currentUserId)?.isMuted || false,
        latestMessage: latestMessage ? { ...latestMessage, readBy, deliveredTo } : null,
        totalMessages: chat._count.messages,
        _sortTime,
      };
    });

    enrichedChats.sort((a, b) => (b._sortTime || 0) - (a._sortTime || 0));
    enrichedChats.forEach(c => { delete c._sortTime; });

    res.json(enrichedChats);
  } catch (error) {
    console.error('Error fetching group chats:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Search chats by keyword (in name or message content)
exports.searchChats = async (req, res) => {
  try {
    const currentUserId = req.authData.id;
    const { keyword } = req.query;

    if (!keyword || keyword.trim() === "") {
      return res.status(400).json({ error: "Keyword is required for search" });
    }

const userChats = await prisma.chat.findMany({
  where: {
    users: { some: { userId: currentUserId } },
    ...NOT_GLOBAL_CHAT_WHERE, 
  },
  select: { id: true },
});


    const chatIds = userChats.map(chat => chat.id);

    const matchingChats = await prisma.chat.findMany({
      where: {
        id: { in: chatIds },
        messages: { some: { content: { contains: keyword, mode: "insensitive" } } },
      },
      select: { id: true },
    });

    res.json(matchingChats);
  } catch (error) {
    console.error("Search chats error:", error);
    res.status(500).json({ error: "Failed to search chats" });
  }
};

// ───────── Disappearing Messages ─────────

// 0=forever, 1=view-once (disappear 5s after read), 300=5m, 900=15m, 1800=30m, 3600=1h, 10800=3h, 21600=6h
const ALLOWED_DURATIONS = [0, 1, 300, 900, 1800, 3600, 10800, 21600];

exports.setDisappearingMessages = async (req, res) => {
  try {
    const userId = req.authData.id;
    const chatId = parseInt(req.params.chatId, 10);
    const { seconds } = req.body; // 0 = off, or one of the allowed durations

    if (!chatId || !Number.isInteger(chatId)) {
      return res.status(400).json({ error: 'Valid chatId is required' });
    }

    if (!ALLOWED_DURATIONS.includes(seconds)) {
      return res.status(400).json({
        error: `Invalid duration. Allowed: ${ALLOWED_DURATIONS.join(', ')} (seconds)`,
      });
    }

    // Verify user is a member of this chat
    const membership = await prisma.userOnChat.findFirst({
      where: { userId, chatId },
    });
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this chat' });
    }

    // Block disappearing messages on global chats and group chats
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { name: true, isGroup: true },
    });
    if (chat && isGlobalChatName(chat.name)) {
      return res.status(400).json({ error: 'Disappearing messages are not available for global chats' });
    }
    if (chat && chat.isGroup) {
      return res.status(400).json({ error: 'Disappearing messages are only available for personal conversations' });
    }

    const newValue = seconds === 0 ? null : seconds;

    await prisma.chat.update({
      where: { id: chatId },
      data: { disappearingSeconds: newValue },
    });

    // Build human-readable label
    const LABELS = {
      0: 'off', 1: 'immediately', 300: '5 minutes', 900: '15 minutes',
      1800: '30 minutes', 3600: '1 hour', 10800: '3 hours', 21600: '6 hours',
    };
    const label = LABELS[seconds] || `${seconds} seconds`;

    // Fetch sender name for the alert
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    const senderName = `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'Someone';

    const alertContent = seconds === 0
      ? `${senderName} turned off disappearing messages`
      : `${senderName} set disappearing messages to ${label}`;

    // Create system message alert
    const systemMsg = await prisma.message.create({
      data: {
        chatId,
        senderId: userId,
        content: alertContent,
        isSystem: true,
        expiresAt: null, // system messages don't expire
      },
    });

    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    });

    // Emit socket events
    try {
      const io = require('../utils/socket').getIO();

      // Alert all participants about the system message
      io.to(`chat_${chatId}`).emit('newMessage', {
        id: systemMsg.id,
        content: alertContent,
        imageUrl: null,
        isSystem: true,
        sender: { id: userId, firstName: user?.firstName, lastName: user?.lastName },
        chatId,
        createdAt: systemMsg.createdAt,
      });

      // Dedicated event so Flutter can update the chat settings UI
      io.to(`chat_${chatId}`).emit('disappearingMessagesChanged', {
        chatId,
        disappearingSeconds: newValue,
        changedBy: userId,
        label,
      });
    } catch (socketErr) {
      console.error('disappearingMessages socket error:', socketErr);
    }

    return res.json({
      success: true,
      disappearingSeconds: newValue,
      label,
      systemMessageId: systemMsg.id,
    });
  } catch (error) {
    console.error('setDisappearingMessages error:', error);
    return res.status(500).json({ error: 'Failed to update disappearing messages' });
  }
};

exports.getDisappearingMessages = async (req, res) => {
  try {
    const userId = req.authData.id;
    const chatId = parseInt(req.params.chatId, 10);

    if (!chatId || !Number.isInteger(chatId)) {
      return res.status(400).json({ error: 'Valid chatId is required' });
    }

    const membership = await prisma.userOnChat.findFirst({
      where: { userId, chatId },
      select: { chatId: true },
    });
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this chat' });
    }

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { disappearingSeconds: true },
    });

    return res.json({
      success: true,
      disappearingSeconds: chat?.disappearingSeconds || null,
    });
  } catch (error) {
    console.error('getDisappearingMessages error:', error);
    return res.status(500).json({ error: 'Failed to fetch disappearing messages setting' });
  }
};

// POST /api/chats/confirm-delivery
// Called from Flutter's onBackgroundMessage handler when FCM push arrives on device.
// Marks all undelivered messages in a chat as delivered for this user.
exports.confirmDelivery = async (req, res) => {
  const userId = req.authData.id;
  const chatId = parseInt(req.body.chatId, 10);

  if (!chatId) return res.status(400).json({ error: 'chatId required' });

  try {
    const userOnChat = await prisma.userOnChat.findFirst({
      where: { userId, chatId },
      select: { id: true, lastDeliveredMessageId: true },
    });
    if (!userOnChat) return res.status(403).json({ error: 'Not a member' });

    // Find latest message in this chat (not sent by this user)
    const latestMsg = await prisma.message.findFirst({
      where: { chatId, senderId: { not: userId } },
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    if (!latestMsg) return res.json({ success: true, delivered: false });

    // Only advance forward
    if (userOnChat.lastDeliveredMessageId && userOnChat.lastDeliveredMessageId >= latestMsg.id) {
      return res.json({ success: true, delivered: false, already: true });
    }

    await prisma.userOnChat.updateMany({
      where: { userId, chatId },
      data: { lastDeliveredMessageId: latestMsg.id },
    });

    // Notify sender via socket so tick updates in real-time
    try {
      const io = require('../utils/socket').getIO();
      io.to(`chat_${chatId}`).emit('messageDelivered', {
        chatId,
        userId,
        lastDeliveredMessageId: latestMsg.id,
      });
    } catch (_) {}

    return res.json({ success: true, delivered: true, lastDeliveredMessageId: latestMsg.id });
  } catch (error) {
    console.error('confirmDelivery error:', error);
    return res.status(500).json({ error: 'Failed to confirm delivery' });
  }
};

// Disappear-on-exit: reliable HTTP backup to the socket 'exitChat' event.
// Call when leaving the conversation screen. No-op unless the chat is in
// disappear-immediately mode. Per-user — does not affect other members.
exports.exitChat = async (req, res) => {
  try {
    const userId = req.authData.id;
    const chatId = parseInt(req.params.chatId, 10);
    if (!chatId || !Number.isInteger(chatId)) {
      return res.status(400).json({ message: 'Invalid chatId' });
    }
    const { clearChatOnExit } = require('../utils/socket');
    await clearChatOnExit(userId, chatId);
    return res.json({ message: 'Exited chat' });
  } catch (error) {
    console.error('exitChat error:', error);
    return res.status(500).json({ message: 'Failed to exit chat' });
  }
};

// -------------------- Moderation (additive) --------------------

// POST /api/chats/messages/:messageId/report  (item 2)
// Body: { reason: string (required), note?: string }
// Only chat members can report; non-members get 403. Inserts a row in the
// existing Report table with type='message' so the moderation dashboard sees
// both user-reports and message-reports in one place.
exports.reportMessage = async (req, res) => {
  try {
    const reporterId = req.authData.id;
    const messageId = parseInt(req.params.messageId, 10);
    const { reason, note } = req.body || {};

    if (!messageId || !Number.isInteger(messageId)) {
      return res.status(400).json({ error: 'Invalid messageId' });
    }
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json({ error: 'reason required' });
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { chat: { include: { users: { select: { userId: true } } } } },
    });
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const isMember = message.chat.users.some((u) => u.userId === reporterId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this chat' });
    }

    const contextType = message.chat.isCommunity
      ? 'community'
      : message.chat.isGroup
        ? 'group'
        : 'dm';

    await prisma.report.create({
      data: {
        type: 'message',
        reporterId,
        reportedId: message.senderId,
        messageId: message.id,
        chatId: message.chatId,
        contextType,
        communityId: message.chat.communityId || null,
        reason: String(reason).slice(0, 191),
        note: note ? String(note).slice(0, 10000) : null,
        status: 'PENDING',
      },
    });

    return res.status(201).json({ success: true });
  } catch (err) {
    console.error('reportMessage error:', err);
    return res.status(500).json({ error: 'Failed to report message' });
  }
};

// POST /api/chats/:chatId/members/:userId/ban  (item 5b — group ban)
// Only group admins can ban. Inserts ChatBan + removes UserOnChat.
exports.banGroupMember = async (req, res) => {
  try {
    const adminId = req.authData.id;
    const chatId = parseInt(req.params?.chatId, 10);
    const targetUserId = parseInt(req.params?.userId, 10);
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 191) : null;

    if (!chatId || !Number.isInteger(chatId))                 return res.status(400).json({ error: 'Invalid chatId' });
    if (!targetUserId || !Number.isInteger(targetUserId))     return res.status(400).json({ error: 'Invalid userId' });
    if (targetUserId === adminId)                              return res.status(400).json({ error: 'Cannot ban yourself' });

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true, isGroup: true, name: true,
        users: { select: { userId: true, role: true } },
      },
    });
    if (!chat || !chat.isGroup) return res.status(404).json({ error: 'Group chat not found' });

    const me = chat.users.find((u) => u.userId === adminId);
    if (!me || me.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only group admins can ban' });
    }

    const target = chat.users.find((u) => u.userId === targetUserId);
    if (target?.role === 'ADMIN') {
      const adminCount = chat.users.filter((u) => u.role === 'ADMIN').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot ban the last admin' });
      }
    }

    await prisma.chatBan.upsert({
      where: { chatId_userId: { chatId, userId: targetUserId } },
      update: { reason, bannedById: adminId, bannedAt: new Date() },
      create: { chatId, userId: targetUserId, bannedById: adminId, reason },
    });

    if (target) {
      await prisma.userOnChat.deleteMany({ where: { chatId, userId: targetUserId } });
    }

    realtime.toGroup(chatId, 'group.member_banned',  { chatId, userId: targetUserId });
    realtime.toGroup(chatId, 'group.member_removed', { chatId, userId: targetUserId });
    realtime.toUser(targetUserId, 'group.member_banned',  { chatId, userId: targetUserId, reason });
    realtime.toUser(targetUserId, 'group.member_removed', { chatId, userId: targetUserId });

    // Item 10: persistent in-app notification + FCM push (respects toggle).
    try {
      const gname = chat.name || 'group';
      const desc  = `You were removed by an admin.${reason ? ` Reason: ${reason}` : ''}`;
      await notifyUser(
        targetUserId,
        'GROUP_BANNED',
        `Removed from ${gname}`,
        desc,
        { actorId: adminId, chatId, ...(reason ? { reason } : {}) },
      );
    } catch (e) {
      console.error('banGroupMember notifyUser error:', e);
    }

    return res.json({ message: 'Member banned from group' });
  } catch (err) {
    console.error('banGroupMember error:', err);
    return res.status(500).json({ error: 'Failed to ban member' });
  }
};

// DELETE /api/chats/:chatId/members/:userId/ban  (unban)
exports.unbanGroupMember = async (req, res) => {
  try {
    const adminId = req.authData.id;
    const chatId = parseInt(req.params?.chatId, 10);
    const targetUserId = parseInt(req.params?.userId, 10);
    if (!chatId || !Number.isInteger(chatId))             return res.status(400).json({ error: 'Invalid chatId' });
    if (!targetUserId || !Number.isInteger(targetUserId)) return res.status(400).json({ error: 'Invalid userId' });

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true, isGroup: true, name: true,
        users: { select: { userId: true, role: true } },
      },
    });
    if (!chat || !chat.isGroup) return res.status(404).json({ error: 'Group chat not found' });

    const me = chat.users.find((u) => u.userId === adminId);
    if (!me || me.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only group admins can unban' });
    }

    await prisma.chatBan.deleteMany({ where: { chatId, userId: targetUserId } });
    realtime.toUser(targetUserId, 'group.member_unbanned', { chatId, userId: targetUserId });

    // Item 10: reinstatement notification + FCM push.
    try {
      const gname = chat.name || 'group';
      await notifyUser(
        targetUserId,
        'GROUP_UNBANNED',
        `Reinstated to ${gname}`,
        'An admin has unbanned you. You can rejoin now.',
        { actorId: adminId, chatId },
      );
    } catch (e) {
      console.error('unbanGroupMember notifyUser error:', e);
    }

    return res.json({ message: 'Member unbanned' });
  } catch (err) {
    console.error('unbanGroupMember error:', err);
    return res.status(500).json({ error: 'Failed to unban member' });
  }
};

// POST /api/chats/messages/:messageId/admin-delete  (item 5c)
// Group admin OR community creator can delete any message in their space.
// DM context → 403. Emits the same messagesDeleted event as item 1.
exports.adminDeleteMessage = async (req, res) => {
  try {
    const callerId = req.authData.id;
    const messageId = parseInt(req.params?.messageId, 10);
    if (!messageId || !Number.isInteger(messageId)) {
      return res.status(400).json({ error: 'Invalid messageId' });
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: {
        chat: {
          include: {
            users: { select: { userId: true, role: true } },
            community: { select: { id: true, creatorId: true } },
          },
        },
      },
    });
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const chat = message.chat;
    if (!chat.isGroup && !chat.isCommunity) {
      return res.status(403).json({ error: 'Admin delete is only for group/community chats' });
    }

    // Permission gate
    let permitted = false;
    if (chat.isCommunity && chat.community?.creatorId === callerId) permitted = true;
    if (!permitted && chat.isGroup) {
      const me = chat.users.find((u) => u.userId === callerId);
      if (me && me.role === 'ADMIN') permitted = true;
    }
    if (!permitted) {
      return res.status(403).json({ error: 'Only the group admin / community creator can delete messages' });
    }

    // Hard delete
    await prisma.message.delete({ where: { id: message.id } });

    // Orphan-only S3 cleanup
    try {
      if (message.imageUrl) {
        const { deleteS3IfOrphanBulk } = require('../utils/s3Cleanup');
        deleteS3IfOrphanBulk([message.imageUrl]).catch((err) =>
          console.error('adminDeleteMessage S3 cleanup error', err)
        );
      }
    } catch (_) { /* s3 module unavailable — skip */ }

    // Broadcast same event as item 1
    try {
      const { getIO } = require('../utils/socket');
      const io = getIO && getIO();
      if (io) {
        io.to(`chat_${chat.id}`).emit('messagesDeleted', {
          chatId: chat.id,
          messageIds: [message.id],
        });
      }
    } catch (_) { /* socket not ready */ }

    return res.json({ success: true, deleted: [message.id] });
  } catch (err) {
    console.error('adminDeleteMessage error:', err);
    return res.status(500).json({ error: 'Failed to delete message' });
  }
};
