const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

let ioInstance;

function initSocket(server) {
    const io = new Server(server, {
        cors: { origin: '*' }
    });

    io.on('connection', (socket) => {
        console.log('✅ Socket connected:', socket.id);

        socket.on('joinChat', (chatId) => {
            socket.join(`chat_${chatId}`);
            console.log(`🔵 User joined chat_${chatId}`);
        });

        socket.on('sendMessage', async (data) => {
            const { chatId, content, senderId } = data;

            if (!chatId || !content || !senderId) {
                console.log('❌ Missing fields in sendMessage:', data);
                return;
            }

            try {
                // 🛡️ Block check logic
                const chat = await prisma.chat.findUnique({
                    where: { id: chatId },
                    include: {
                        users: {
                            include: { user: true }
                        }
                    }
                });

                if (!chat || !chat.users) {
                    console.log('❌ Chat not found or invalid participants');
                    return;
                }

                const recipient = chat.users.find(u => u.userId !== senderId)?.user;

                if (!recipient) {
                    console.log('❌ Could not determine recipient');
                    return;
                }

                const isBlocked = await prisma.block.findFirst({
                    where: {
                        OR: [
                            { blockerId: senderId, blockedId: recipient.id },
                            { blockerId: recipient.id, blockedId: senderId }
                        ]
                    }
                });

                if (isBlocked) {
                    console.log('🚫 Message blocked due to block relationship');
                    return;
                }

                // ✅ Proceed to save and emit message
                const message = await prisma.message.create({
                    data: { content, senderId, chatId },
                    include: { sender: true },
                });

                io.to(`chat_${chatId}`).emit('newMessage', {
                    id: message.id,
                    content: message.content,
                    sender: { id: message.sender.id, username: message.sender.username },
                    chatId: message.chatId,
                    createdAt: message.createdAt,
                });
            } catch (error) {
                console.error('❌ Error saving message:', error);
            }
        });

        socket.on('typing', ({ chatId, username }) => {
            socket.to(`chat_${chatId}`).emit('typing', { username });
        });

        socket.on('stopTyping', ({ chatId, username }) => {
            socket.to(`chat_${chatId}`).emit('stopTyping', { username });
        });

        socket.on('disconnect', () => {
            console.log('❌ Socket disconnected:', socket.id);
        });
    });

    ioInstance = io;
}

function getIO() {
    if (!ioInstance) {
        throw new Error('Socket.IO not initialized!');
    }
    return ioInstance;
}

module.exports = { initSocket, getIO };
