const { PrismaClient } = require('@prisma/client');
const nodemailer = require('nodemailer');
const prisma = new PrismaClient();
const { notifyUser } = require('../utils/notificationService');

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
  where: { isSaved: true } ,
          orderBy: { updatedAt: 'desc' }
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
        avatarUrl: user.minime?.[0]?.avatarUrl || null,
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

exports.acceptFriendRequest = async (req, res) => {
  const receiverId = req.authData.id;               // the user ACCEPTING (actor)
  const requesterId = parseInt(req.params.userId, 10); // the one who SENT the request (recipient)

  // 1) Find a pending request requester -> receiver
  const friendRecord = await prisma.friendship.findFirst({
    where: {
      requesterId,
      receiverId,
      status: 'PENDING'
    },
    include: { requester: true, receiver: true }
  });

  if (!friendRecord) {
    return res.status(404).json({ error: "Friend request not found." });
  }

  // 2) Accept (guard if already accepted)
  if (friendRecord.status !== 'ACCEPTED') {
    await prisma.friendship.update({
      where: { id: friendRecord.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() }
    });
  }

  // 3) Build actor (the acceptor) full name for the title
  const actor = friendRecord.receiver; // the one accepting = current user
  const fullName =
    [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim() ||
    actor.username;

  // 4) Notify the original requester (recipient) with actorId
  await notifyUser(
    requesterId,                // recipient of the push
    "FRIEND_ACCEPTED",
    fullName,                   // title shows actor's name
    "accepted your friend request.",
    {
      actorId: receiverId,      // critical: used to fetch actor's avatar in the list
      friendId: receiverId,     // optional: helpful for deep links
      firstName: actor.firstName || '',
      lastName: actor.lastName || ''
    }
  );

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
  where: { isSaved: true } ,
          orderBy: { updatedAt: 'desc' }
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
  where: { isSaved: true },
          orderBy: { updatedAt: 'desc' } 
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
      avatarUrl: friend.minime?.[0]?.avatarUrl || null,
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
  where: { isSaved: true } ,
          orderBy: { updatedAt: 'desc' }
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
          avatarUrl: user.minime?.[0]?.avatarUrl || null,
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


function getWeekStartMonday() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const weekStart = new Date(now.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);
  return weekStart;
}

const firstAvatar = (minimeArr) =>
  Array.isArray(minimeArr) && minimeArr.length > 0
    ? (minimeArr[0]?.avatarUrl || "")
    : "";

const REASON_RANK = { CONTACT: 3, MUTUAL: 2, COMMUNITY: 1 };

exports.getRecommendedFriends = async (req, res) => {
  const userId = req.authData.id;
  const weekStart = getWeekStartMonday();

  // 1) current friends
  const friendships = await prisma.friendship.findMany({
    where: { status: 'ACCEPTED', OR: [{ requesterId: userId }, { receiverId: userId }] }
  });
  const friendIds = friendships.map(f => (f.requesterId === userId ? f.receiverId : f.requesterId));

  // 2) blocked
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] }
  });
  const blockedIds = blocks.map(b => (b.blockerId === userId ? b.blockedId : b.blockerId));

  // 3) contacts -> users
  const syncedContacts = await prisma.contactSync.findMany({ where: { userId } });
  const contactUsernames = syncedContacts.map(c => c.username).filter(Boolean);
  const contactPhones = syncedContacts.map(c => c.phone).filter(Boolean);

  const contactUsers = await prisma.user.findMany({
    where: {
      OR: [
        contactUsernames.length ? { username: { in: contactUsernames } } : undefined,
        contactPhones.length ? { phone: { in: contactPhones } } : undefined,
      ].filter(Boolean),
      id: { notIn: [...friendIds, ...blockedIds, userId] }
    },
    select: {
      id: true,
      username: true,
      totalPoints: true,
      minime: {
        select: { avatarUrl: true, isSaved: true, updatedAt: true },
        orderBy: [{ isSaved: 'desc' }, { updatedAt: 'desc' }],
        take: 1
      }
    }
  });

  // 4) mutual friends graph
  const mutualFriendships = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: { in: friendIds } },
        { receiverId: { in: friendIds } }
      ]
    },
    include: {
      requester: {
        select: {
          id: true, username: true,
          minime: {
            select: { avatarUrl: true, isSaved: true, updatedAt: true },
            orderBy: [{ isSaved: 'desc' }, { updatedAt: 'desc' }],
            take: 1
          }
        }
      },
      receiver: {
        select: {
          id: true, username: true,
          minime: {
            select: { avatarUrl: true, isSaved: true, updatedAt: true },
            orderBy: [{ isSaved: 'desc' }, { updatedAt: 'desc' }],
            take: 1
          }
        }
      }
    }
  });

  // 5) communities -> members (+community info)
  const myCommunities = await prisma.communityMember.findMany({
    where: { userId },
    select: { communityId: true }
  });
  const communityIds = myCommunities.map(c => c.communityId);

  const communityMembers = communityIds.length
    ? await prisma.communityMember.findMany({
        where: {
          communityId: { in: communityIds },
          userId: { notIn: [...friendIds, ...blockedIds, userId] }
        },
        include: {
          community: { select: { id: true, name: true, imageUrl: true } },
          user: {
            select: {
              id: true, username: true, totalPoints: true,
              minime: {
                select: { avatarUrl: true, isSaved: true, updatedAt: true },
                orderBy: [{ isSaved: 'desc' }, { updatedAt: 'desc' }],
                take: 1
              }
            }
          }
        }
      })
    : [];

  // 6) combine suggestions with single best reason
  const suggested = new Map();

  const upsert = (uId, base) => {
    if (!suggested.has(uId)) {
      suggested.set(uId, {
        id: base.id,
        username: base.username,
        avatarUrl: base.avatarUrl || "",
        totalPoints: base.totalPoints ?? 0,
        thisWeekPoints: 0,
        reason: null,        // best single reason
        _reasonRank: 0,      // internal rank for comparison
        mutualFriends: []    // preview list (not returned)
      });
    }
    const entry = suggested.get(uId);

    if (!entry.avatarUrl && base.avatarUrl) entry.avatarUrl = base.avatarUrl;
    if (!entry.totalPoints && typeof base.totalPoints === 'number') entry.totalPoints = base.totalPoints;

    // choose best reason by rank
    if (base.reason && REASON_RANK[base.reason.type] > (entry._reasonRank || 0)) {
      entry.reason = base.reason;
      entry._reasonRank = REASON_RANK[base.reason.type];
    }

    // accumulate mutual friends (dedupe) – optional cache, UI-তে ব্যবহার করছি না
    if (Array.isArray(base.mutualFriends) && base.mutualFriends.length) {
      const seen = new Set(entry.mutualFriends.map(m => m.id));
      for (const m of base.mutualFriends) {
        if (!seen.has(m.id)) {
          entry.mutualFriends.push({
            id: m.id,
            username: m.username,
            avatarUrl: m.avatarUrl || ""
          });
          seen.add(m.id);
        }
      }
    }
  };

  // from contacts (highest priority)
  for (const u of contactUsers) {
    upsert(u.id, {
      id: u.id,
      username: u.username,
      avatarUrl: firstAvatar(u.minime),
      totalPoints: u.totalPoints || 0,
      reason: { type: 'CONTACT', label: 'From contact list' }
    });
  }

  // from mutual friends (2nd priority) — with `via`
  for (const fr of mutualFriendships) {
    const a = fr.requester;
    const b = fr.receiver;

    const pushCandidate = (mutual, other) => {
      const otherId = other.id;
      if ([...friendIds, ...blockedIds, userId].includes(otherId)) return;
      upsert(otherId, {
        id: otherId,
        username: other.username,
        avatarUrl: firstAvatar(other.minime),
        reason: {
          type: 'MUTUAL',
          label: 'Mutual Friend',
          via: {
            id: mutual.id,
            username: mutual.username,
            avatarUrl: firstAvatar(mutual.minime) // "" if not found
          }
        },
        // optional cache
        mutualFriends: [{
          id: mutual.id,
          username: mutual.username,
          avatarUrl: firstAvatar(mutual.minime)
        }]
      });
    };

    if (friendIds.includes(a.id)) pushCandidate(a, b);
    if (friendIds.includes(b.id)) pushCandidate(b, a);
  }

  // from community (lowest priority)
  for (const cm of communityMembers) {
    const u = cm.user;
    upsert(u.id, {
      id: u.id,
      username: u.username,
      avatarUrl: firstAvatar(u.minime),
      totalPoints: u.totalPoints || 0,
      reason: {
        type: 'COMMUNITY',
        label: 'Community',
        community: {
          id: cm.community.id,
          name: cm.community.name,
          imageUrl: cm.community.imageUrl || "" // never null
        }
      }
    });
  }

  // 7) weekly points (batch)
  const candidateIds = Array.from(suggested.keys());
  if (candidateIds.length) {
    const subs = await prisma.submission.findMany({
      where: { userId: { in: candidateIds }, createdAt: { gte: weekStart } },
      include: { challenge: { select: { points: true } } }
    });
    const subPts = new Map();
    for (const s of subs) subPts.set(s.userId, (subPts.get(s.userId) || 0) + (s.challenge?.points || 0));

    const locs = await prisma.locationPoint.findMany({
      where: { userId: { in: candidateIds }, createdAt: { gte: weekStart } },
      select: { userId: true, points: true }
    });
    const locPts = new Map();
    for (const p of locs) locPts.set(p.userId, (locPts.get(p.userId) || 0) + (p.points || 0));

    for (const id of candidateIds) {
      const e = suggested.get(id);
      e.thisWeekPoints = (subPts.get(id) || 0) + (locPts.get(id) || 0);
    }
  }

  // 8) final payload (single best reason; mutual -> reason.via)
  const payload = Array.from(suggested.values())
    .map(s => ({
      id: s.id,
      username: s.username,
      avatarUrl: s.avatarUrl || "",
      totalPoints: s.totalPoints,
      thisWeekPoints: s.thisWeekPoints,
      reason: s.reason && s.reason.type === 'MUTUAL'
        ? s.reason
        : (s.reason && s.reason.type === 'COMMUNITY'
            ? { ...s.reason, community: { ...s.reason.community, imageUrl: s.reason.community.imageUrl || "" } }
            : s.reason
          )
    }))
    .slice(0, 20);

  return res.json({ recommended: payload });
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
  where: { isSaved: true } ,
          orderBy: { updatedAt: 'desc' }
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
              where: { isSaved: true },
          orderBy: { updatedAt: 'desc' }
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
  const friendId = parseInt(req.params.friendId, 10);

  try {

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

    // 2) Friend basic profile
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
          where: { isSaved: true },
          orderBy: { updatedAt: 'desc' }
        }
      }
    });
    if (!friend) return res.status(404).json({ error: "User not found" });

    // 3) Friend's visible stories (profile/public only, not vault)
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
              where: { isSaved: true },
              orderBy: { updatedAt: 'desc' }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // 4) Friend count
    const friendCount = await prisma.friendship.count({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: friendId }, { receiverId: friendId }]
      }
    });

    // 5) Communities (+ recent community imageUrl separately)
    // Prefer member.createdAt; fallback community.updatedAt
    const communitiesRaw = await prisma.communityMember.findMany({
      where: { userId: friendId },
      include: { community: true },
      orderBy: [{ joinedAt: 'desc' }]
    });
    const communities = communitiesRaw.map(c => c.community);
    const recentCommunityImageUrl = communities.length ? (communities[0].imageUrl || "") : "";

    // 6) Weekly window
    const now = new Date();
    const day = now.getDay(); // 0=Sun
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);

    // 7) Helper: batch weekly points
    const computeWeeklyPoints = async (userIds) => {
      if (!userIds.length) return new Map();

      const submissions = await prisma.submission.findMany({
        where: { userId: { in: userIds }, createdAt: { gte: weekStart } },
        include: { challenge: { select: { points: true } } }
      });
      const locationPoints = await prisma.locationPoint.findMany({
        where: { userId: { in: userIds }, createdAt: { gte: weekStart } },
        select: { userId: true, points: true }
      });

      const subPts = new Map();
      for (const s of submissions) {
        subPts.set(s.userId, (subPts.get(s.userId) || 0) + (s.challenge?.points || 0));
      }
      const locPts = new Map();
      for (const p of locationPoints) {
        locPts.set(p.userId, (locPts.get(p.userId) || 0) + (p.points || 0));
      }

      const totals = new Map();
      for (const id of userIds) {
        totals.set(id, (subPts.get(id) || 0) + (locPts.get(id) || 0));
      }
      return totals;
    };

    // 8) This friend's weekly points
    const friendWeeklyMap = await computeWeeklyPoints([friendId]);
    const thisWeekPoints = friendWeeklyMap.get(friendId) || 0;

    // 9) Friend's ALL friends (accepted) → list every "other user"
    const friendLinks = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: friendId }, { receiverId: friendId }]
      },
      include: {
        requester: {
          select: {
            id: true, username: true, firstName: true, lastName: true, totalPoints: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              orderBy: { updatedAt: 'desc' },
              take: 1
            }
          }
        },
        receiver: {
          select: {
            id: true, username: true, firstName: true, lastName: true, totalPoints: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              orderBy: { updatedAt: 'desc' },
              take: 1
            }
          }
        }
      }
    });

    const rawOthers = [];
    for (const row of friendLinks) {
      const other = (row.requester.id === friendId) ? row.receiver : row.requester;
      if (other.id !== friendId && other.id !== currentUserId) {
        rawOthers.push(other);
      }
    }
    // Dedupe
    const seen = new Set();
    const allFriendUsers = [];
    for (const u of rawOthers) {
      if (!seen.has(u.id)) {
        allFriendUsers.push(u);
        seen.add(u.id);
      }
    }

    // 10) Weekly points for all those users
    const fofIds = allFriendUsers.map(u => u.id);
    const fofWeeklyMap = await computeWeeklyPoints(fofIds);

    let friendFriends = allFriendUsers.map(u => ({
      id: u.id,
      username: u.username,
      firstName: u.firstName,
      lastName: u.lastName,
      avatarUrl: (u.minime && u.minime[0] && u.minime[0].avatarUrl) ? u.minime[0].avatarUrl : "",
      totalPoints: u.totalPoints || 0,
      thisWeekPoints: fofWeeklyMap.get(u.id) || 0
    }));

    // 11) Optional sorting & limiting
    const sortBy = (req.query.sortBy || '').toString();
    if (sortBy === 'thisWeekPoints') {
      friendFriends.sort((a, b) => b.thisWeekPoints - a.thisWeekPoints);
    } else if (sortBy === 'totalPoints') {
      friendFriends.sort((a, b) => b.totalPoints - a.totalPoints);
    } else if (sortBy === 'username') {
      friendFriends.sort((a, b) => (a.username || '').localeCompare(b.username || ''));
    }
    const limit = parseInt(req.query.limit, 10);
    if (Number.isFinite(limit) && limit > 0) {
      friendFriends = friendFriends.slice(0, limit);
    }

    // 12) Final response
    return res.status(200).json({
      success: true,
      message: "Friend profile fetched",
      data: {
        id: friend.id,
        username: friend.username,
        firstName: friend.firstName,
        lastName: friend.lastName,
        bio: friend.bio,
        totalPoints: friend.totalPoints || 0,
        minime: friend.minime,
        friendCount,
        communities: communities,                 // full list
        recentCommunityImageUrl,                  // most recent community image
        thisWeekPoints,                           // this friend's weekly points
        stories: friendStories,
        friendFriends                              // ALL friends of this friend
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
          where: { isSaved: true },
          orderBy: { updatedAt: 'desc' }
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
              where: { isSaved: true },
          orderBy: { updatedAt: 'desc' }
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
  firstName: isSelf || isFriend ? user.firstName : null,
  lastName: isSelf || isFriend ? user.lastName : null,
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


