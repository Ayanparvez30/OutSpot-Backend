const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const multer = require('multer');
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


exports.createChat = async (req, res) => {
    const { userIds, name, isGroup } = req.body;
    const currentUserId = req.authData.id;

    if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ message: 'User IDs required' });
    }

    // ✅ Only allow private chats between friends
    if (!isGroup && userIds.length === 1) {
        const targetUserId = userIds[0];

        const isFriend = await prisma.friendship.findFirst({
            where: {
                status: 'ACCEPTED',
                OR: [
                    { requesterId: currentUserId, receiverId: targetUserId },
                    { requesterId: targetUserId, receiverId: currentUserId },
                ],
            },
        });

        if (!isFriend) {
            return res.status(403).json({ message: 'You can only start chats with friends.' });
        }
    }

    const chat = await prisma.chat.create({
        data: {
            name,
            isGroup: isGroup || false,
            users: {
                create: userIds.concat(currentUserId).map(userId => ({ userId })),
            },
        },
        include: { users: true }
    });

    res.json(chat);
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
            user: true,
          },
        },
        messages: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const weekStart = getStartOfWeek();  
    const getThisWeekPoints = async (userId) => {
      const submissions = await prisma.submission.findMany({
        where: {
          userId,
          createdAt: { gte: weekStart },
        },
        include: { challenge: true },
      });

      const challengePoints = submissions.reduce(
        (sum, s) => sum + (s.challenge.points || 0),
        0
      );

      const locationPoints = await prisma.locationPoint.findMany({
        where: {
          userId,
          createdAt: { gte: weekStart },
        },
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
              avatarUrl: user.minime?.avatarUrl || null,
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
  const user1Id = req.authData.id; // assuming the current user's ID is user1
  const user2Id = parseInt(req.params.user2Id, 10); // parse user2Id to an integer

  if (isNaN(user2Id)) {
    return res.status(400).json({ message: 'Invalid user ID' });
  }

  try {
    const chats = await prisma.chat.findMany({
      where: {
        users: {
          every: {
            userId: {
              in: [user1Id, user2Id] // Ensure both are integers
            }
          }
        }
      },
      select: {
        users: {
          select: {
            id: true,
            userId: true,
            chatId: true
          }
        }
      }
    });

    if (chats.length === 0) {
      return res.status(200).json([]);
    }

    // Reformat the response to match the desired output
    const chatIds = chats.map(chat => {
      return {
        id: chat.users[0].id,
        userId: chat.users[0].userId,
        chatId: chat.users[0].chatId
      };
    });

    res.json(chatIds); // Return the reformatted response
  } catch (error) {
    console.error('Error fetching chats:', error);
    return res.status(500).json({ message: 'Server error' });
  }
};
