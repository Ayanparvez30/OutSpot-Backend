
const { PrismaClient } = require('@prisma/client');
const nodemailer = require('nodemailer');
const prisma = new PrismaClient();

// Send a friend request
exports.sendFriendRequest = async (req, res) => {
  const currentUserId = req.authData.id;
  const targetUserId = parseInt(req.params.userId);

  if (currentUserId === targetUserId) {
    return res.status(400).json({ error: "You cannot friend yourself." });
  }
  // Check if target user exists
  const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!targetUser) {
    return res.status(404).json({ error: "User not found." });
  }
  // Check if any friendship (pending or accepted) already exists between users
  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { requesterId: currentUserId, receiverId: targetUserId },
        { requesterId: targetUserId, receiverId: currentUserId }
      ]
    }
  });
  if (existing) {
    return res.status(400).json({ error: "Friend request already sent or users already friends." });
  }
  // Check blocking: if either has blocked the other, disallow request
  const blocked = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: currentUserId, blockedId: targetUserId },
        { blockerId: targetUserId, blockedId: currentUserId }
      ]
    }
  });
  if (blocked) {
    return res.status(403).json({ error: "Cannot send request - one user has blocked the other." });
  }
  // Create friendship request (pending)
  await prisma.friendship.create({
    data: {
      requesterId: currentUserId,
      receiverId: targetUserId,
      status: 'PENDING'
    }
  });
  return res.json({ message: "Friend request sent." });
};

// Accept a friend request
exports.acceptFriendRequest = async (req, res) => {
  const currentUserId = req.authData.id;
  const fromUserId = parseInt(req.params.userId);  // user who sent the request
  // Find the pending friend request record
  const friendRecord = await prisma.friendship.findFirst({
    where: {
      requesterId: fromUserId,
      receiverId: currentUserId,
      status: 'PENDING'
    },
    include: { requester: true, receiver: true }
  });
  if (!friendRecord) {
    return res.status(404).json({ error: "Friend request not found." });
  }
  // Update the friendship status to ACCEPTED
  await prisma.friendship.update({
    where: { id: friendRecord.id },
    data: {
      status: 'ACCEPTED',
      acceptedAt: new Date()
    }
  });
  // Send notification email to the requester 
  try {
    const requesterEmail = friendRecord.requester.email;
    if (requesterEmail) {
      const transporter = nodemailer.createTransport({
        // Configure your SMTP or email service
        // (using a test Ethereal account for example)
        host: "smtp.ethereal.email",
        port: 587,
        auth: {
          user: "test_account@ethereal.email",
          pass: "ethereal_password"
        }
      });
      await transporter.sendMail({
        from: '"MyApp" <no-reply@myapp.com>',
        to: requesterEmail,
        subject: "Friend Request Accepted",
        text: `Hi ${friendRecord.requester.username}, your friend request to ${friendRecord.receiver.username} has been accepted!`
      });
    }
  } catch (err) {
    console.error("Email send failed:", err);
    // (Even if email fails, we continue without failing the request)
  }
  return res.json({ message: "Friend request accepted." });
};

// Decline or cancel a friend request
exports.declineFriendRequest = async (req, res) => {
  const currentUserId = req.authData.id;
  const otherUserId = parseInt(req.params.userId);
  // A decline can be done by receiver of the request, or sender can cancel.
  const friendRecord = await prisma.friendship.findFirst({
    where: {
      status: 'PENDING',
      OR: [
        { requesterId: currentUserId, receiverId: otherUserId },   // cancel sent request
        { requesterId: otherUserId, receiverId: currentUserId }    // decline received request
      ]
    }
  });
  if (!friendRecord) {
    return res.status(404).json({ error: "No pending friend request between these users." });
  }
  // Delete the friend request record (reject the request)
  await prisma.friendship.delete({ where: { id: friendRecord.id } });
  return res.json({ message: "Friend request declined (or cancelled)."});
};

// Unfriend an existing friend
exports.unfriend = async (req, res) => {
  const currentUserId = req.authData.id;
  const friendUserId = parseInt(req.params.userId);
  // Find an accepted friendship record in either direction
  const friendRecord = await prisma.friendship.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: currentUserId, receiverId: friendUserId },
        { requesterId: friendUserId, receiverId: currentUserId }
      ]
    }
  });
  if (!friendRecord) {
    return res.status(404).json({ error: "No friendship exists with that user." });
  }
  // Remove the friendship (unfriend)
  await prisma.friendship.delete({ where: { id: friendRecord.id } });
  return res.json({ message: "Unfriended successfully." });
};

// Get list of friends (accepted friendships) for current user
exports.getFriendList = async (req, res) => {
  const currentUserId = req.authData.id;
  // Find all accepted friendships where current user is either requester or receiver
const friendships = await prisma.friendship.findMany({
  where: {
    OR: [
      {
        requesterId: currentUserId,
        status: 'ACCEPTED'
      },
      {
        receiverId: currentUserId,
        status: 'ACCEPTED'
      }
    ]
  },
  include: {
    requester: { select: { id: true, username: true, } },
    receiver:  { select: { id: true, username: true,  } }
  }
});

  // Map the friendships to a list of friend user info
  const friendsList = friendships.map(fr => {
    // Determine which side is the friend (other than current user)
    let friendUser = (fr.requesterId === currentUserId) ? fr.receiver : fr.requester;
    return friendUser;
  });
  return res.json(friendsList);
};

// Get count of incoming pending friend requests
exports.getPendingFriendRequestCount = async (req, res) => {
  try {
    const currentUserId = req.authData.id;

    const count = await prisma.friendship.count({
      where: {
        receiverId: currentUserId,
        status: 'PENDING'
      }
    });

    return res.json({ count });
  } catch (error) {
    console.error('Error getting pending friend request count:', error);
    return res.status(500).json({ error: 'Failed to fetch count' });
  }
};
