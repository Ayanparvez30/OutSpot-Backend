const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const multer = require('multer');
const uploadToS3 = require('../utils/s3Upload'); // your existing util

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();

// Configure AWS SDK v3 S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Set up multer to store files temporarily
const upload = multer({ dest: 'uploads/' });

// Function to upload the file to S3 using AWS SDK v3
async function uploadFileToS3(filePath, bucketName, fileName) {
  const fileStream = fs.createReadStream(filePath);
  const uploadParams = {
    Bucket: bucketName,
    Key: fileName, // Unique file name
    Body: fileStream,
  };

  try {
    const data = await s3Client.send(new PutObjectCommand(uploadParams));
    return `https://${bucketName}.s3.amazonaws.com/${fileName}`; // Return the S3 URL
  } catch (err) {
    console.error('Error uploading file to S3:', err);
    throw err;
  }
}

// Controller method for uploading chat image
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

      // Save the uploaded file URL to the database
      const chatImage = await prisma.chatImage.create({
        data: {
          userId: req.authData.id, // Assuming `authData` contains the authenticated user's info
          fileUrl: fileUrl,
        },
      });

      return res.json({ message: 'Image uploaded successfully', chatImage });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to upload file to S3', details: err.message });
    }
  });
};




//



exports.createPrivateChat = async (req, res) => {
  try {
    const currentUserId = req.authData.id;
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ message: 'targetUserId is required' });
    }

    // ✅ Check if private chat already exists
    const existingChat = await prisma.chat.findFirst({
      where: {
        isGroup: false,
        users: {
          some: { userId: currentUserId }
        }
      },
      include: { users: true }
    });

    if (existingChat) {
      const memberIds = existingChat.users.map(u => u.userId);
      if (
        memberIds.includes(currentUserId) &&
        memberIds.includes(Number(targetUserId))
      ) {
        return res.json({
          message: 'Private chat already exists',
          chatId: existingChat.id
        });
      }
    }

    // ✅ Create new chat
    const chat = await prisma.chat.create({
      data: {
        isGroup: false,
        users: {
          create: [
            { userId: currentUserId, role: 'ADMIN' },
            { userId: parseInt(targetUserId), role: 'ADMIN' }
          ]
        }
      }
    });

    return res.json({ message: 'Private chat created', chatId: chat.id });
  } catch (error) {
    console.error('Error creating private chat:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};






exports.createGroupChat = async (req, res) => {
  try {
    const currentUserId = req.authData.id;
    let { userIds, name } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Group name is required' });
    }

    if (typeof userIds === 'string') {
      try {
        userIds = JSON.parse(userIds);
      } catch {
        userIds = [parseInt(userIds, 10)];
      }
    }

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: 'At least one userId required' });
    }

    // ✅ Build full member list
    const allMemberIds = [...new Set(userIds.concat(currentUserId))].map(id => parseInt(id));

    // ✅ Check if such a group already exists (same member set)
    // const candidateChats = await prisma.chat.findMany({
    //   where: { isGroup: true },
    //   include: { users: true }
    // });

    // for (const chat of candidateChats) {
    //   const chatMemberIds = chat.users.map(u => u.userId).sort();
    //   if (
    //     chatMemberIds.length === allMemberIds.length &&
    //     chatMemberIds.every((id, idx) => id === allMemberIds.sort()[idx])
    //   ) {
    //     return res.json({ message: 'Group chat already exists', chat });
    //   }
    // }

    // ✅ Upload image if provided
    let imageUrl = null;
    if (req.file) {
      imageUrl = await uploadToS3(req.file, 'chat-images');
    }

    // ✅ Create group chat
    const membersCreate = allMemberIds.map(uid => ({
      userId: uid,
      role: uid === currentUserId ? 'ADMIN' : 'MEMBER'
    }));

    const chat = await prisma.chat.create({
      data: {
        name,
        isGroup: true,
        imageUrl,
        createdById: currentUserId,
        users: { create: membersCreate }
      },
      include: { users: { include: { user: true } } }
    });

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

    // 1. Find chat and membership
    const chat = await prisma.chat.findUnique({
      where: { id: parseInt(chatId, 10) },
      include: {
        users: {
          where: { userId: currentUserId },
          select: { role: true }
        }
      }
    });

    if (!chat || !chat.isGroup) {
      return res.status(404).json({ message: 'Group chat not found' });
    }

    // 2. Ensure user is ADMIN
    const membership = chat.users[0];
    if (!membership || membership.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Only group admins can update this chat' });
    }

    // 3. Handle image upload (optional)
    let imageUrl = chat.imageUrl;
    if (req.file) {
      imageUrl = await uploadToS3(req.file, 'chat-images');
    }

    // 4. Update chat
    const updatedChat = await prisma.chat.update({
      where: { id: chat.id },
      data: {
        name: name || chat.name,
        imageUrl
      },
      include: {
        users: {
          include: { user: true }
        }
      }
    });

    return res.json({ message: 'Group chat updated', chat: updatedChat });
  } catch (error) {
    console.error('Error updating group chat:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};





exports.deleteChat = async (req, res) => {
  const { chatId } = req.params;
  const currentUserId = req.authData.id;

  try {
    // Check if chat exists and user is part of it
    const chat = await prisma.chat.findUnique({
      where: { id: parseInt(chatId) },
      include: { users: true }
    });

    if (!chat) {
      return res.status(404).json({ message: 'Chat not found' });
    }

    // Only participants can delete the chat
    const isParticipant = chat.users.some(u => u.userId === currentUserId);
    if (!isParticipant) {
      return res.status(403).json({ message: 'You are not part of this chat' });
    }

    // Delete the chat → cascades will clean messages + userOnChat
    await prisma.chat.delete({
      where: { id: chat.id }
    });

    return res.json({ message: 'Chat deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};



exports.getMyChats = async (req, res) => {
  const currentUserId = req.authData.id;

  try {
    const chats = await prisma.chat.findMany({
      where: {
        users: { some: { userId: currentUserId } },
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
                  orderBy: { createdAt: 'desc' },
                  take: 1
                }
              }
            }
          },
        },
        messages: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const weekStart = getStartOfWeek();

    const getThisWeekPoints = async (userId) => {
      const submissions = await prisma.submission.findMany({
        where: { userId, createdAt: { gte: weekStart } },
        include: { challenge: true },
      });

      const challengePoints = submissions.reduce(
        (sum, s) => sum + (s.challenge.points || 0),
        0
      );

      const locationPoints = await prisma.locationPoint.findMany({
        where: { userId, createdAt: { gte: weekStart } },
      });

      const mapPoints = locationPoints.reduce(
        (sum, p) => sum + (p.points || 0),
        0
      );

      return challengePoints + mapPoints;
    };

    const enrichedChats = await Promise.all(
      chats.map(async (chat) => {
        const chatUsers = await Promise.all(
          chat.users.map(async (userOnChat) => {
            const user = userOnChat.user;
            const thisWeekPoints = await getThisWeekPoints(user.id);

            return {
              id: user.id,
              username: user.username,
              firstName: user.firstName || null,
              lastName: user.lastName || null,
              avatarUrl: user.minime?.[0]?.avatarUrl || null, // ✅ FIXED
              totalPoints: user.totalPoints || 0,
              thisWeekPoints,
              profileUrl: `/api/users/${user.id}/profile`,
            };
          })
        );

        return { ...chat, users: chatUsers };
      })
    );

    res.json(enrichedChats);
  } catch (error) {
    console.error("Error fetching chats:", error);
    res.status(500).json({ message: "Server error" });
  }
};


// Helper function to calculate the start of the week (Monday)
function getStartOfWeek() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}


exports.getMessages = async (req, res) => {
    const { chatId } = req.params;

    const messages = await prisma.message.findMany({
        where: { chatId: parseInt(chatId) },
        include: { sender: true },
        orderBy: { createdAt: 'asc' }
    });

    res.json(messages);
};
exports.getMessagesPaginated = async (req, res) => {
    const { chatId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    const messages = await prisma.message.findMany({
        where: { chatId: parseInt(chatId) },
        include: { sender: true },
        orderBy: { createdAt: 'desc' },
        skip: parseInt(skip),
        take: parseInt(limit),
    });

    res.json(messages);
};


exports.getChatsByUsers = async (req, res) => {
  const user1Id = req.authData.id;
  const user2Id = parseInt(req.params.user2Id, 10);
  if (isNaN(user2Id)) return res.status(400).json({ message: 'Invalid user ID' });

  try {
    const chats = await prisma.chat.findMany({
      where: {
        users: {
          every: { userId: { in: [user1Id, user2Id] } } // all users are either me or user2
        }
      },
      include: { users: { select: { userId: true } } }
    });

    // filter out any chat that doesn't contain BOTH users
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

// exports.getChatsByUsers = async (req, res) => {
//   const user1Id = req.authData.id; // assuming the current user's ID is user1
//   const user2Id = parseInt(req.params.user2Id, 10); // parse user2Id to an integer

//   if (isNaN(user2Id)) {
//     return res.status(400).json({ message: 'Invalid user ID' });
//   }

//   try {
//     const chats = await prisma.chat.findMany({
//       where: {
//         users: {
//           every: {
//             userId: {
//               in: [user1Id, user2Id] // Ensure both are integers
//             }
//           }
//         }
//       },
//       select: {
//         users: {
//           select: {
//             id: true,
//             userId: true,
//             chatId: true
//           }
//         }
//       }
//     });

//     if (chats.length === 0) {
//       return res.status(200).json([]);
//     }

//     // Reformat the response to match the desired output
//     const chatIds = chats.map(chat => {
//       return {
//         id: chat.users[0].id,
//         userId: chat.users[0].userId,
//         chatId: chat.users[0].chatId
//       };
//     });

//     res.json(chatIds); // Return the reformatted response
//   } catch (error) {
//     console.error('Error fetching chats:', error);
//     return res.status(500).json({ message: 'Server error' });
//   }
// };

// controllers/chatController.js
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

  // ✅ must be admin
  const me = chat.users.find(u => u.userId === currentUserId);
  if (!me || me.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Only admins can add users.' });
  }

  const existing = new Set(chat.users.map(u => u.userId));
  const toAdd = userIds.filter(id => !existing.has(id));

  if (!toAdd.length) {
    return res.status(400).json({ message: 'All users are already in the group' });
  }

  await prisma.chat.update({
    where: { id: chat.id },
    data: {
      users: {
        create: toAdd.map((id) => ({ userId: id, role: 'MEMBER' }))
      }
    }
  });

  return res.json({ message: 'Users added to the group chat' });
};

// controllers/chatController.js
exports.removeUserFromGroup = async (req, res) => {
  const { chatId, userId } = req.params;
  const currentUserId = req.authData.id;

  const chat = await prisma.chat.findUnique({
    where: { id: parseInt(chatId, 10) },
    include: { users: true }
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
  if (!target) {
    return res.status(404).json({ message: 'User is not in this group.' });
  }

  // If target is ADMIN, make sure they’re not the last admin
  if (target.role === 'ADMIN') {
    const adminCount = chat.users.filter(u => u.role === 'ADMIN').length;

    // disallow removing the last admin while others still remain
    const otherMembersExist = chat.users.some(u => u.userId !== targetUserId);
    if (adminCount <= 1 && otherMembersExist) {
      return res.status(400).json({ message: 'Cannot remove the last admin. Promote another user first.' });
    }
  }

  await prisma.userOnChat.delete({
    where: { id: target.id } // id is the join row id
  });

  return res.json({ message: 'User removed from group.' });
};


exports.leaveGroup = async (req, res) => {
  const { chatId } = req.params;
  const currentUserId = req.authData.id;

  const chat = await prisma.chat.findUnique({
    where: { id: parseInt(chatId, 10) },
    include: { users: true }
  });
  if (!chat || !chat.isGroup) {
    return res.status(404).json({ message: 'Group chat not found' });
  }

  const myRow = chat.users.find(u => u.userId === currentUserId);
  if (!myRow) return res.status(403).json({ message: 'You are not in this group' });

  // If I'm admin, ensure at least one admin remains (if others remain)
  const otherUsers = chat.users.filter(u => u.userId !== currentUserId);
  const adminCount = chat.users.filter(u => u.role === 'ADMIN').length;

  await prisma.$transaction(async (tx) => {
    if (otherUsers.length === 0) {
      // I’m the last member → delete the chat
      await tx.chat.delete({ where: { id: chat.id } });
      return;
    }

    if (myRow.role === 'ADMIN' && adminCount <= 1) {
      // Promote first remaining member to ADMIN (oldest join row)
      const candidate = otherUsers
        .sort((a, b) => a.id - b.id)[0]; // deterministic pick
      await tx.userOnChat.update({
        where: { id: candidate.id },
        data: { role: 'ADMIN' }
      });
    }

    // Remove myself
    await tx.userOnChat.delete({ where: { id: myRow.id } });
  });

  return res.json({ message: 'You left the group.' });
};


exports.getGroupMembers = async (req, res) => {
  const { chatId } = req.params;

  try {
    const chat = await prisma.chat.findUnique({
      where: { id: parseInt(chatId) },
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
                  where: { isSaved: true }
                }
              }
            }
          }
        }
      }
    });

    if (!chat || !chat.isGroup) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const members = chat.users.map(u => ({
      id: u.user.id,
      username: u.user.username,
      firstName: u.user.firstName,
      lastName: u.user.lastName,
      avatarUrl: u.user.minime?.avatarUrl || null,
      totalPoints: u.user.totalPoints || 0,
      profileUrl: `/api/users/${u.user.id}/profile`
    }));

    return res.json({ members });
  } catch (error) {
    console.error("Error fetching group members:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

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

      // ✅ Must be ADMIN to edit group
      const me = chat.users.find(u => u.userId === currentUserId);
      if (!me || me.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Only admins can edit the group' });
      }

      // Upload new image if provided
      let imageUrl = chat.imageUrl || null; // you’ll need to add `imageUrl` column to Chat model
      if (req.file) {
        imageUrl = await uploadToS3(req.file, 'chat-images');
      }

      const updated = await prisma.chat.update({
        where: { id: chat.id },
        data: {
          name: name || chat.name,
          imageUrl, // make sure Chat model has this column
        },
        include: {
          users: {
            include: {
              user: { select: { id: true, username: true } }
            }
          }
        }
      });

      return res.json({ message: 'Group chat updated', chat: updated });
    } catch (error) {
      console.error('Error editing group chat:', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  });
};

