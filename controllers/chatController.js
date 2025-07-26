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

