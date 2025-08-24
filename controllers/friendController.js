const { PrismaClient } = require('@prisma/client');
const nodemailer = require('nodemailer');
const prisma = new PrismaClient();


exports.searchUsers = async (req, res) => {
  const currentUserId = req.authData.id;
  const query = req.query.q;

  if (!query || query.length < 2) {
    return res.status(400).json({
      success: false,
      message: "Search term must be at least 2 characters.",
      data: []
    });
  }

  const searchTerm = query.trim().toLowerCase();

  try {
    // 🛑 Get block list
    const blocks = await prisma.block.findMany({
      where: {
        OR: [
          { blockerId: currentUserId },
          { blockedId: currentUserId }
        ]
      }
    });
    const blockedIds = new Set(
      blocks.map(b => b.blockerId === currentUserId ? b.blockedId : b.blockerId)
    );

    // 🟢 Get community members
    const myCommunities = await prisma.communityMember.findMany({
      where: { userId: currentUserId }
    });
    const communityIds = myCommunities.map(c => c.communityId);

    const sameCommunityMembers = await prisma.communityMember.findMany({
      where: {
        communityId: { in: communityIds },
        userId: { not: currentUserId }
      }
    });

    const sameCommunityUserIds = new Set(sameCommunityMembers.map(m => m.userId));

    // 🟢 Get all users matching search
    const users = await prisma.user.findMany({
      where: {
        id: { not: currentUserId },
        AND: [
          {
            OR: [
              { firstName: { contains: searchTerm } },
              { lastName: { contains: searchTerm } },
              { username: { contains: searchTerm } }
            ]
          },
          { id: { notIn: Array.from(blockedIds) } }
        ]
      },
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

      },
      take: 30
    });

    // ⏱ Weekly point setup
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);

    // 🔁 Helper: calculate score
    const getMatchScore = (user, q) => {
      const qLower = q.toLowerCase();
      let score = 0;
      const fields = [user.username, user.firstName, user.lastName].filter(Boolean).map(f => f.toLowerCase());

      for (const field of fields) {
        if (field === qLower) score += 40;
        else if (field.startsWith(qLower)) score += 30;
        else if (field.includes(qLower)) score += 20;
        else if (field.endsWith(qLower)) score += 10;
      }

      return score;
    };

    const enriched = await Promise.all(users.map(async user => {
      const friendship = await prisma.friendship.findFirst({
        where: {
          OR: [
            { requesterId: currentUserId, receiverId: user.id },
            { requesterId: user.id, receiverId: currentUserId }
          ]
        }
      });

      const submissions = await prisma.submission.findMany({
        where: {
          userId: user.id,
          createdAt: { gte: weekStart }
        },
        include: { challenge: true }
      });
      const challengePoints = submissions.reduce((sum, s) => sum + (s.challenge?.points || 0), 0);

      const locationPoints = await prisma.locationPoint.findMany({
        where: {
          userId: user.id,
          createdAt: { gte: weekStart }
        }
      });
      const mapPoints = locationPoints.reduce((sum, p) => sum + (p.points || 0), 0);

      const thisWeekPoints = challengePoints + mapPoints;
      const isMutualFriend = friendship?.status === 'ACCEPTED';
      const isInSameCommunity = sameCommunityUserIds.has(user.id);

      // Final smart score
      const score = getMatchScore(user, searchTerm)
        + (isMutualFriend ? 20 : 0)
        + (isInSameCommunity ? 10 : 0);

      return {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.minime?.avatarUrl || null,
        totalPoints: user.totalPoints || 0,
        thisWeekPoints,
        friendshipStatus: friendship?.status || null,
        profileUrl: `/api/users/${user.id}/profile`,
        score
      };
    }));

    // 🔽 Sort by score
    enriched.sort((a, b) => b.score - a.score);

    return res.status(200).json({
      success: true,
      message: "Search results",
      data: enriched
    });

  } catch (error) {
    console.error("Search error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to search users",
      data: []
    });
  }
};


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
exports.getFriendList = async (req, res) => {
  const currentUserId = req.authData.id;

  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: currentUserId },
        { receiverId: currentUserId }
      ]
    },
    include: {
      requester: {
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
      },
      receiver: {
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
  });

  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const weekStart = new Date(now.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);

  const friends = await Promise.all(friendships.map(async fr => {
    const friend = fr.requesterId === currentUserId ? fr.receiver : fr.requester;

    // Weekly challenge points
    const submissions = await prisma.submission.findMany({
      where: {
        userId: friend.id,
        createdAt: { gte: weekStart }
      },
      include: { challenge: true }
    });
    const challengePoints = submissions.reduce((sum, s) => sum + (s.challenge?.points || 0), 0);

    // Weekly location points
    const locationPoints = await prisma.locationPoint.findMany({
      where: {
        userId: friend.id,
        createdAt: { gte: weekStart }
      }
    });
    const mapPoints = locationPoints.reduce((sum, p) => sum + (p.points || 0), 0);

    const thisWeekPoints = challengePoints + mapPoints;

    return {
      id: friend.id,
      username: friend.username,
      firstName: friend.firstName,
      lastName: friend.lastName,
      avatarUrl: friend.minime?.avatarUrl || null,
      totalPoints: friend.totalPoints || 0,
      thisWeekPoints,
      profileUrl: `/api/users/${friend.id}/profile`
    };
  }));

return res.status(200).json({
  success: true,
  message: "Friends fetched successfully",
  data: friends
});

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

// Block a user
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
exports.getFriendRequests = async (req, res) => {
  const currentUserId = req.authData.id;

  try {
    // Get all pending requests sent to current user
    const pendingRequests = await prisma.friendship.findMany({
      where: {
        receiverId: currentUserId,
        status: 'PENDING'
      },
      include: {
        requester: {
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
    });

    // Get current week's start (Monday)
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);

    const enriched = await Promise.all(
      pendingRequests.map(async (req) => {
        const user = req.requester;

        // Weekly challenge points
        const submissions = await prisma.submission.findMany({
          where: {
            userId: user.id,
            createdAt: { gte: weekStart }
          },
          include: { challenge: true }
        });
        const challengePoints = submissions.reduce((sum, s) => sum + (s.challenge?.points || 0), 0);

        // Weekly map points
        const locationPoints = await prisma.locationPoint.findMany({
          where: {
            userId: user.id,
            createdAt: { gte: weekStart }
          }
        });
        const mapPoints = locationPoints.reduce((sum, p) => sum + (p.points || 0), 0);

        return {
          id: user.id,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          avatarUrl: user.minime?.avatarUrl || null,
          totalPoints: user.totalPoints || 0,
          thisWeekPoints: challengePoints + mapPoints,
          profileUrl: `/api/users/${user.id}/profile`
        };
      })
    );

    return res.status(200).json({
      success: true,
      message: 'Incoming friend requests fetched',
      data: enriched
    });
  } catch (error) {
    console.error('Friend request fetch error:', error);
    return res.status(500).json({ error: 'Failed to load friend requests' });
  }
};

// Unblock a user
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
exports.getRecommendedFriends = async (req, res) => {
  const userId = req.authData.id;

  // 1. Get current friends
  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ requesterId: userId }, { receiverId: userId }]
    }
  });
  const friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId);

  // 2. Get blocked users
  const blocks = await prisma.block.findMany({
    where: {
      OR: [{ blockerId: userId }, { blockedId: userId }]
    }
  });
  const blockedIds = blocks.map(b =>
    b.blockerId === userId ? b.blockedId : b.blockerId
  );

  // 3. Load synced contacts from DB
  const syncedContacts = await prisma.contactSync.findMany({ where: { userId } });
  const contactUsernames = syncedContacts.map(c => c.username).filter(Boolean);
  const contactPhones = syncedContacts.map(c => c.phone).filter(Boolean);

  const contactUsers = await prisma.user.findMany({
    where: {
      OR: [
        { username: { in: contactUsernames } },
        { phone: { in: contactPhones } }
      ],
      id: { notIn: [...friendIds, ...blockedIds, userId] }
    },
    select: {
      id: true,
      username: true,
     minime: {
  select: { avatarUrl: true },
  where: { isSaved: true } 
}

    }
  });

  // 4. Mutual friends
  const mutualFriendships = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: { in: friendIds }, receiverId: { notIn: [...friendIds, ...blockedIds, userId] } },
        { receiverId: { in: friendIds }, requesterId: { notIn: [...friendIds, ...blockedIds, userId] } }
      ]
    },
    include: {
      requester: {
        select: {
          id: true, username: true,
        minime: {
  select: { avatarUrl: true },
  where: { isSaved: true } 
}

        }
      },
      receiver: {
        select: {
          id: true, username: true,
            minime: {
  select: { avatarUrl: true },
  where: { isSaved: true } 
}

        }
      }
    }
  });

  // 5. Community members
  const myCommunities = await prisma.communityMember.findMany({
    where: { userId },
    select: { communityId: true }
  });

  const communityIds = myCommunities.map(c => c.communityId);
  const communityMembers = await prisma.communityMember.findMany({
    where: {
      communityId: { in: communityIds },
      userId: { notIn: [...friendIds, ...blockedIds, userId] }
    },
    include: {
      user: {
        select: {
          id: true,
          username: true,
       minime: {
  select: { avatarUrl: true },
  where: { isSaved: true } 
}
        }
      }
    }
  });

  // 6. Combine suggestions
  const suggested = new Map();

  // From Contacts
  contactUsers.forEach(u => {
    suggested.set(u.id, {
      id: u.id,
      username: u.username,
      avatarUrl: u.minime?.avatarUrl || null,
      reason: 'From contact list',
      isAlreadyFriend: false
    });
  });

  // From Mutual Friends
  mutualFriendships.forEach(f => {
    const other = f.requester.id !== userId ? f.requester : f.receiver;
    if (!suggested.has(other.id)) {
      suggested.set(other.id, {
        id: other.id,
        username: other.username,
        avatarUrl: other.minime?.avatarUrl || null,
        reason: 'Mutual Friend',
        isAlreadyFriend: false
      });
    }
  });

  // From Community
  communityMembers.forEach(cm => {
    const u = cm.user;
    if (!suggested.has(u.id)) {
      suggested.set(u.id, {
        id: u.id,
        username: u.username,
        avatarUrl: u.minime?.avatarUrl || null,
        reason: 'Community',
        isAlreadyFriend: false
      });
    }
  });

  res.json({
    recommended: Array.from(suggested.values()).slice(0, 20)
  });
};

exports.syncContacts = async (req, res) => {
  const userId = req.authData.id;
  const { contacts } = req.body; // array of usernames or phone numbers

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'No contacts provided' });
  }

  // Save contacts (optional: clear old first)
  await prisma.contactSync.deleteMany({ where: { userId } });

  const toInsert = contacts.map(c => ({
    userId,
    username: c.username || null,
    phone: c.phone || null
  }));

  await prisma.contactSync.createMany({ data: toInsert });

  // Try to find existing users from contact data
  const matchedUsers = await prisma.user.findMany({
    where: {
      OR: [
        { username: { in: contacts.map(c => c.username).filter(Boolean) } },
        { phone: { in: contacts.map(c => c.phone).filter(Boolean) } }
      ],
      id: { not: userId }
    },
    select: {
      id: true,
      username: true,
      phone: true,
          minime: {
  select: { avatarUrl: true },
  where: { isSaved: true } 
}

    }
  });

  res.json({
    message: 'Contacts synced',
    matched: matchedUsers
  });
};
exports.getBlockedUsers = async (req, res) => {
  const currentUserId = req.authData.id;

  try {
    const blockedUsers = await prisma.block.findMany({
      where: { blockerId: currentUserId },
      include: {
        blocked: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            minime: {
              select: { avatarUrl: true }, 
              where: { isSaved: true }
            }
          }
        }
      }
    });

    const users = blockedUsers.map(block => ({
      id: block.blocked.id,
      username: block.blocked.username,
      firstName: block.blocked.firstName,
      lastName: block.blocked.lastName,
      avatarUrl: block.blocked.minime.length > 0 ? block.blocked.minime[0].avatarUrl : null, // Handle avatarUrl presence
      totalPoints: block.blocked.totalPoints || 0
    }));

    return res.status(200).json({
      success: true,
      message: "Blocked users fetched successfully",
      data: users
    });
  } catch (error) {
    console.error("Error fetching blocked users:", error);
    return res.status(500).json({ error: "Failed to fetch blocked users" });
  }
};


exports.getSentFriendRequests = async (req, res) => {
  const currentUserId = req.authData.id;

  try {
    // Get all pending requests sent by the current user
    const sentRequests = await prisma.friendship.findMany({
      where: {
        requesterId: currentUserId,
        status: 'PENDING'
      },
      include: {
        receiver: {
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
    });

    const users = sentRequests.map(request => ({
      id: request.receiver.id,
      username: request.receiver.username,
      firstName: request.receiver.firstName,
      lastName: request.receiver.lastName,
      avatarUrl: request.receiver.minime?.avatarUrl || null,
      totalPoints: request.receiver.totalPoints || 0
    }));

    return res.status(200).json({
      success: true,
      message: "Sent friend requests fetched successfully",
      data: users
    });
  } catch (error) {
    console.error("Error fetching sent friend requests:", error);
    return res.status(500).json({ error: "Failed to fetch sent friend requests" });
  }
};


exports.getFriendProfile = async (req, res) => {
  const currentUserId = req.authData.id;
  const friendId = parseInt(req.params.friendId);

  try {
    // 1. Check if friendId is accepted friend
    const friendship = await prisma.friendship.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: currentUserId, receiverId: friendId },
          { requesterId: friendId, receiverId: currentUserId }
        ]
      }
    });

    if (!friendship) {
      return res.status(403).json({ error: "Not friends with this user" });
    }

    // 2. Get friend full profile
    const friend = await prisma.user.findUnique({
      where: { id: friendId },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        bio: true,
        totalPoints: true,
            minime: {
  select: { avatarUrl: true },
  where: { isSaved: true } 
}

      }
    });

    if (!friend) {
      return res.status(404).json({ error: "User not found" });
    }
// 3. Friend's stories (public/profile only, not in vault)
const friendStories = await prisma.story.findMany({
  where: {
    userId: friendId,
    visibility: 'profile',
      NOT: { status: 'VAULT' }
  },
  include: {
    user: {
      select: {
        id: true,
        username: true,
       minime: {
  select: { avatarUrl: true },
  where: { isSaved: true } 
}

      }
    }
  },
  orderBy: { createdAt: 'desc' }
});
    // 4. Friend count
    const friendCount = await prisma.friendship.count({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: friendId },
          { receiverId: friendId }
        ]
      }
    });

    // 5. Communities
    const communities = await prisma.communityMember.findMany({
      where: { userId: friendId },
      include: { community: true }
    });

    // 6. Weekly points (reuse logic)
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);

    const submissions = await prisma.submission.findMany({
      where: { userId: friendId, createdAt: { gte: weekStart } },
      include: { challenge: true }
    });
    const challengePoints = submissions.reduce((sum, s) => sum + (s.challenge?.points || 0), 0);

    const locationPoints = await prisma.locationPoint.findMany({
      where: { userId: friendId, createdAt: { gte: weekStart } }
    });
    const mapPoints = locationPoints.reduce((sum, p) => sum + (p.points || 0), 0);

    const thisWeekPoints = challengePoints + mapPoints;

 return res.status(200).json({
  success: true,
  message: "Friend profile fetched",
  data: {
    ...friend,
    friendCount,
    communities: communities.map(c => c.community),
    thisWeekPoints,
    stories: friendStories
  }
});


  } catch (error) {
    console.error("Error fetching friend profile:", error);
    return res.status(500).json({ error: "Failed to fetch friend profile" });
  }
};


exports.getUserProfile = async (req, res) => {
  const currentUserId = req.authData.id;
  const targetUserId = parseInt(req.params.userId);

  try {
    // 1. Check if current user == target user (self)
    const isSelf = currentUserId === targetUserId;

    // 2. Check if they are friends
    const friendship = await prisma.friendship.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: currentUserId, receiverId: targetUserId },
          { requesterId: targetUserId, receiverId: currentUserId }
        ]
      }
    });
    const isFriend = !!friendship;

    // 3. Get user profile
    const user = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        bio: true,
        totalPoints: true,
        minime: {
          select: { avatarUrl: true },
          where: { isSaved: true }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // 4. Get stories (only public/profile stories)
    const stories = await prisma.story.findMany({
      where: {
        userId: targetUserId,
        visibility: 'profile',
        NOT: { status: 'VAULT' }
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // 5. Friend count
    const friendCount = await prisma.friendship.count({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: targetUserId }, { receiverId: targetUserId }]
      }
    });

    // 6. Communities
    const communities = await prisma.communityMember.findMany({
      where: { userId: targetUserId },
      include: { community: true }
    });

    // 7. Weekly points (only show if self or friend)
    let thisWeekPoints = 0;
    if (isSelf || isFriend) {
      const now = new Date();
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1);
      const weekStart = new Date(now.setDate(diff));
      weekStart.setHours(0, 0, 0, 0);

      const submissions = await prisma.submission.findMany({
        where: { userId: targetUserId, createdAt: { gte: weekStart } },
        include: { challenge: true }
      });
      const challengePoints = submissions.reduce(
        (sum, s) => sum + (s.challenge?.points || 0),
        0
      );

      const locationPoints = await prisma.locationPoint.findMany({
        where: { userId: targetUserId, createdAt: { gte: weekStart } }
      });
      const mapPoints = locationPoints.reduce((sum, p) => sum + (p.points || 0), 0);

      thisWeekPoints = challengePoints + mapPoints;
    }

    // 8. Restrict profile fields if not friend/self
    const profileData = {
      id: user.id,
      username: user.username,
      minime: user.minime,
      friendCount,
      communities: isSelf || isFriend ? communities.map(c => c.community) : [],
      thisWeekPoints: isSelf || isFriend ? thisWeekPoints : null,
      bio: isSelf || isFriend ? user.bio : null,
      totalPoints: isSelf || isFriend ? user.totalPoints : null,
      stories
    };

    return res.status(200).json({
      success: true,
      message: "User profile fetched",
      data: profileData
    });

  } catch (error) {
    console.error("Error fetching profile:", error);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
};


