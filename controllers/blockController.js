
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.blockUser = async (req, res) => {
  const currentUserId = req.authData.id;
  const targetUserId = parseInt(req.params.userId);
  if (currentUserId === targetUserId) {
    return res.status(400).json({ error: "You cannot block yourself." });
  }
  // Check if target user exists
  const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!targetUser) {
    return res.status(404).json({ error: "User not found." });
  }
  // Check if already blocked
  const existing = await prisma.block.findUnique({
    where: { blockerId_blockedId: { blockerId: currentUserId, blockedId: targetUserId } }
  });
  if (existing) {
    return res.status(400).json({ error: "User is already blocked." });
  }
  // Remove any friendships or pending requests between the two users
  await prisma.friendship.deleteMany({
    where: {
      OR: [
        { requesterId: currentUserId, receiverId: targetUserId },
        { requesterId: targetUserId, receiverId: currentUserId }
      ]
    }
  });
  // Create a block record
  await prisma.block.create({
    data: { blockerId: currentUserId, blockedId: targetUserId }
  });
  return res.json({ message: "User blocked successfully." });
};

exports.unblockUser = async (req, res) => {
  const currentUserId = req.authData.id;
  const targetUserId = parseInt(req.params.userId);
  // Check if a block record exists
  const blockRecord = await prisma.block.findUnique({
    where: { blockerId_blockedId: { blockerId: currentUserId, blockedId: targetUserId } }
  });
  if (!blockRecord) {
    return res.status(404).json({ error: "Block record not found or user is not blocked." });
  }
  // Delete the block record
  await prisma.block.delete({
    where: { id: blockRecord.id }
  });
  return res.json({ message: "User unblocked successfully." });
};
