// controllers/chatController.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const multer = require('multer');
const uploadToS3 = require('../utils/s3Upload');

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


const NOT_GLOBAL_CHAT_WHERE = { NOT: { name: { startsWith: "Global Chat" } } };

const upload = multer({ dest: 'uploads/' });


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
  const label = normCityLabel(cityLabel) || "All USA";
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
      name: chat.name || "Global Chat",
      city: city || "All USA",
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
  let { chatId, content } = req.body;

  try {
    chatId = parseInt(chatId, 10);
    if (!chatId || !Number.isInteger(chatId)) {
      return res.status(400).json({ message: "Valid chatId is required" });
    }

    if (!content || !String(content).trim()) {
      return res.status(400).json({ message: "Message content is required" });
    }
    content = String(content).trim();

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

    const message = await prisma.message.create({
      data: {
        chatId,
        senderId: userId,
        content,
        imageUrl: null,
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
    } catch (socketErr) {
      console.error("sendTextMessage socket error:", socketErr);
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

      const item = {
        chatId: r.id,
        name: r.name,
        city,
        isLocked: r.isLocked,
        updatedAt: r.updatedAt,
        memberCount: r._count.users,
        latestMessage: r.messages?.[0] || null,
      };

      // keep latest updated room for same city
      const prev = map.get(city || "");
      if (!prev || new Date(item.updatedAt) > new Date(prev.updatedAt)) {
        map.set(city || "", item);
      }
    }

    const rooms = Array.from(map.values()).sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
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

  NOT: { name: { startsWith: "Global Chat" } },

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

      const unreadCount = unreadCountsMap.get(chat.id) || 0;
      const latestMessage = chat.messages.length > 0 ? chat.messages[0] : null;

      return { 
        ...chat, 
        users: chatUsers,
        unreadCount,
        latestMessage: latestMessage ? {
          id: latestMessage.id,
          content: latestMessage.content,
          imageUrl: latestMessage.imageUrl,
          createdAt: latestMessage.createdAt,
          senderId: latestMessage.senderId,
          readBy: chat.users
            .filter(u => u.lastSeenMessageId && u.lastSeenMessageId >= latestMessage.id)
            .map(u => u.userId)
        } : null,
        totalMessages: chat._count.messages
      };
    });

    res.json(enrichedChats);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.getMessages = async (req, res) => {
  const { chatId } = req.params;

  try {
    const messages = await prisma.message.findMany({
      where: { chatId: parseInt(chatId, 10) },
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
        chat: {
          include: {
            users: { select: { userId: true, lastSeenMessageId: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const formatted = messages.map(m => ({
      id: m.id,
      content: m.content,
      imageUrl: m.imageUrl,
      createdAt: m.createdAt,
      chatId: m.chatId,
      sender: {
        id: m.sender.id,
        username: m.sender.username,
        firstName: m.sender.firstName,
        lastName: m.sender.lastName,
        avatarUrl: firstAvatar(m.sender.minime),
      },
      readBy: m.chat.users
        .filter(u => u.lastSeenMessageId && u.lastSeenMessageId >= m.id)
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
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  try {
    const messages = await prisma.message.findMany({
      where: { chatId: parseInt(chatId, 10) },
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
        chat: {
          include: {
            users: { select: { userId: true, lastSeenMessageId: true } },
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
      createdAt: m.createdAt,
      chatId: m.chatId,
      sender: {
        id: m.sender.id,
        username: m.sender.username,
        firstName: m.sender.firstName,
        lastName: m.sender.lastName,
        avatarUrl: firstAvatar(m.sender.minime),
      },
      readBy: m.chat.users
        .filter(u => u.lastSeenMessageId && u.lastSeenMessageId >= m.id)
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
  const toAdd = userIds.map(Number).filter(id => !existing.has(id));

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
      // Don't fail the request if socket fails
    }

    return res.json({ 
      message: 'Chat marked as read',
      chatId: parseInt(chatId, 10),
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

      // ✅ Get accurate unread count
      const unreadCount = unreadCountsMap.get(chat.id) || 0;

      // ✅ Get latest message for preview with proper readBy information
      const latestMessage = chat.messages.length > 0 
        ? chat.messages[0] // Already ordered desc, so first is latest
        : null;

      return { 
        ...chat, 
        users: chatUsers,
        unreadCount,
        latestMessage: latestMessage ? {
          id: latestMessage.id,
          content: latestMessage.content,
          imageUrl: latestMessage.imageUrl,
          createdAt: latestMessage.createdAt,
          senderId: latestMessage.senderId,
          // ✅ Add readBy array based on lastSeenMessageId
          readBy: chat.users
            .filter(u => u.lastSeenMessageId && u.lastSeenMessageId >= latestMessage.id)
            .map(u => u.userId)
        } : null,
        totalMessages: chat._count.messages
      };
    });

    // 🚀 Filter out chats with unreadCount = 0
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

    const enrichedChats = chats.map(chat => {
      const latestMessage = chat.messages[0] || null;
      
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
      if (latestMessage) {
        readBy = chat.users
          .filter(u => u.lastSeenMessageId && u.lastSeenMessageId >= latestMessage.id)
          .map(u => u.userId);
      }

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
        unreadCount: unreadCountsMap[chat.id] || 0,
        latestMessage: latestMessage ? { ...latestMessage, readBy } : null,
        totalMessages: chat._count.messages,
      };
    });

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
