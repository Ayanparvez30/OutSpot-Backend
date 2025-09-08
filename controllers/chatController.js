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

// -------------------- AWS + Multer setup --------------------
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const upload = multer({ dest: 'uploads/' });

// -------------------- helpers --------------------
const firstAvatar = (minimeArr) =>
  Array.isArray(minimeArr) && minimeArr.length > 0
    ? (minimeArr[0]?.avatarUrl || null)
    : null;

// -------------------- S3 uploader (v3) --------------------
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

// -------------------- Controllers --------------------

// Upload a chat image (standalone)
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

// Create (or reuse) a private chat; also supports group=false + one target
exports.createPrivateChat = async (req, res) => {
  try {
    const currentUserId = req.authData.id;
    const { UserId, isGroup } = req.body;

    if (!UserId || !Array.isArray(UserId) || UserId.length === 0) {
      return res.status(400).json({ message: 'UserId is required and must be an array' });
    }

    if (!isGroup && UserId.length === 1) {
      const targetUserId = Number(UserId[0]);

      const existingChat = await prisma.chat.findFirst({
        where: {
          isGroup: false,
          users: { some: { userId: currentUserId } },
        },
        include: { users: true },
      });

      if (existingChat) {
        const memberIds = existingChat.users.map(u => u.userId);
        if (memberIds.includes(currentUserId) && memberIds.includes(targetUserId)) {
          return res.json({ message: 'Private chat already exists', chatId: existingChat.id });
        }
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

// Create a group chat (with optional image upload via req.file)
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

// Update group chat (name/image) — admin only
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

// Delete a chat (participant only)
exports.deleteChat = async (req, res) => {
  const { chatId } = req.params;
  const currentUserId = req.authData.id;

  try {
    const chat = await prisma.chat.findUnique({
      where: { id: parseInt(chatId, 10) },
      include: { users: true },
    });

    if (!chat) return res.status(404).json({ message: 'Chat not found' });

    const isParticipant = chat.users.some(u => u.userId === currentUserId);
    if (!isParticipant) return res.status(403).json({ message: 'You are not part of this chat' });

    await prisma.chat.delete({ where: { id: chat.id } });

    return res.json({ message: 'Chat deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Get my chats (includes participants + weekly points via ledger)
exports.getMyChats = async (req, res) => {
  const currentUserId = req.authData.id;

  try {
    const chats = await prisma.chat.findMany({
      where: { users: { some: { userId: currentUserId } } },
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
        messages: true, // keep as-is; can be trimmed if heavy
      },
      orderBy: { updatedAt: 'desc' },
    });

    // ✅ Batch weekly points for all unique users across all chats
    const allUserIds = Array.from(
      new Set(chats.flatMap(c => c.users.map(u => u.userId)))
    );
    const weekPointsMap = await getWeeklyPointsForUsers(allUserIds);

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
          role: userOnChat.role,       // useful in UI
          joinedAt: userOnChat.joinedAt
        };
      });

      return { ...chat, users: chatUsers };
    });

    res.json(enrichedChats);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get messages (with read receipts + sender avatar)
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
              orderBy: { updatedAt: 'desc' },
              take: 1,
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit, 10),
    });

    const shaped = messages.map(m => ({
      ...m,
      sender: {
        id: m.sender.id,
        username: m.sender.username,
        firstName: m.sender.firstName,
        lastName: m.sender.lastName,
        avatarUrl: firstAvatar(m.sender.minime),
      },
    }));

    res.json(shaped);
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

// Add users to a group (admin only)
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
      users: { create: toAdd.map(id => ({ userId: id, role: 'MEMBER' })) },
    },
  });

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

    const members = chat.users.map(u => ({
      id: u.user.id,
      username: u.user.username,
      firstName: u.user.firstName,
      lastName: u.user.lastName,
      avatarUrl: firstAvatar(u.user.minime),
      totalPoints: u.user.totalPoints || 0,
      profileUrl: `/api/users/${u.user.id}/profile`,
      role: u.role,
      joinedAt: u.joinedAt,
    }));

    return res.json({
      groupId: chat.id,
      groupName: chat.name,
      groupImage: chat.imageUrl || null,
      createdById: chat.createdById,
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
