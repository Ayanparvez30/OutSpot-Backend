const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

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

    const chats = await prisma.chat.findMany({
        where: {
            users: { some: { userId: currentUserId } },
        },
        include: { users: { include: { user: true } }, messages: true },
        orderBy: { updatedAt: 'desc' }
    });

    res.json(chats);
};

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
      return res.status(404).json({ message: 'No chats found for these users' });
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
