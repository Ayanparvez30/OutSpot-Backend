// controllers/friendController.js
const { PrismaClient } = require('@prisma/client');
const nodemailer = require('nodemailer');
const prisma = new PrismaClient();
const { notifyUser } = require('../utils/notificationService');

// ✅ NEW: single source of truth for weekly points (sums pointsLedger.finalPoints since Monday)
const {
  getWeeklyPointsForUsers,
  getWeeklyPointsForUser,
} = require('../utils/weeklyPoints');

// -------------------- helpers --------------------
const firstAvatar = (minimeArr) =>
  Array.isArray(minimeArr) && minimeArr.length > 0
    ? (minimeArr[0]?.avatarUrl || "")
    : "";

const REASON_RANK = { CONTACT: 3, MUTUAL: 2, COMMUNITY: 1 };

const getMatchScore = (user, q) => {
  const qLower = q.toLowerCase();
  let score = 0;
  const fields = [user.username, user.firstName, user.lastName]
    .filter(Boolean)
    .map((f) => f.toLowerCase());

  for (const field of fields) {
    if (field === qLower) score += 40;
    else if (field.startsWith(qLower)) score += 30;
    else if (field.includes(qLower)) score += 20;
    else if (field.endsWith(qLower)) score += 10;
  }
  return score;
};

// -------------------- controllers --------------------

// Search users (with weekly points from ledger)
exports.searchUsers = async (req, res) => {
  const currentUserId = req.authData.id;
  const query = req.query.q;

  if (!query || query.length < 2) {
    return res.status(400).json({
      success: false,
      message: "Search term must be at least 2 characters.",
      data: [],
    });
  }

  const searchTerm = query.trim().toLowerCase();

  try {
    // block list
    const blocks = await prisma.block.findMany({
      where: {
        OR: [{ blockerId: currentUserId }, { blockedId: currentUserId }],
      },
    });
    const blockedIds = new Set(
      blocks.map((b) =>
        b.blockerId === currentUserId ? b.blockedId : b.blockerId
      )
    );

    // communities
    const myCommunities = await prisma.communityMember.findMany({
      where: { userId: currentUserId },
    });
    const communityIds = myCommunities.map((c) => c.communityId);

    const sameCommunityMembers = await prisma.communityMember.findMany({
      where: {
        communityId: { in: communityIds },
        userId: { not: currentUserId },
      },
    });
    const sameCommunityUserIds = new Set(
      sameCommunityMembers.map((m) => m.userId)
    );

    // users
    const users = await prisma.user.findMany({
      where: {
        id: { not: currentUserId },
        AND: [
          {
            OR: [
              { firstName: { contains: searchTerm } },
              { lastName: { contains: searchTerm } },
              { username: { contains: searchTerm } },
            ],
          },
          { id: { notIn: Array.from(blockedIds) } },
        ],
      },
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
        },
      },
      take: 30,
    });

    // batch weekly points from ledger
    const idList = users.map((u) => u.id);
    const weekPointsMap = await getWeeklyPointsForUsers(idList);

    // enrich + score
    const enriched = await Promise.all(
      users.map(async (user) => {
        const friendship = await prisma.friendship.findFirst({
          where: {
            OR: [
              { requesterId: currentUserId, receiverId: user.id },
              { requesterId: user.id, receiverId: currentUserId },
            ],
          },
        });

        const isMutualFriend = friendship?.status === "ACCEPTED";
        const isInSameCommunity = sameCommunityUserIds.has(user.id);

        const score =
          getMatchScore(user, searchTerm) +
          (isMutualFriend ? 20 : 0) +
          (isInSameCommunity ? 10 : 0);

        return {
          id: user.id,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          avatarUrl: user.minime?.[0]?.avatarUrl || null,
          totalPoints: user.totalPoints || 0,
          thisWeekPoints: weekPointsMap.get(user.id) || 0,
          friendshipStatus: friendship?.status || null,
          profileUrl: `/api/users/${user.id}/profile`,
          score,
        };
      })
    );

    // sort by score
    enriched.sort((a, b) => b.score - a.score);

    return res.status(200).json({
      success: true,
      message: "Search results",
      data: enriched,
    });
  } catch (error) {
    console.error("Search error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to search users",
      data: [],
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

  try {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      return res.status(404).json({ error: "User not found." });
    }

    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: currentUserId, receiverId: targetUserId },
          { requesterId: targetUserId, receiverId: currentUserId },
        ],
      },
    });
    if (existing) {
      return res
        .status(400)
        .json({ error: "Friend request already sent or users already friends." });
    }

    const blocked = await prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: currentUserId, blockedId: targetUserId },
          { blockerId: targetUserId, blockedId: currentUserId },
        ],
      },
    });
    if (blocked) {
      return res
        .status(403)
        .json({ error: "Cannot send request - one user has blocked the other." });
    }

    // Get current user's info for the notification
    const currentUser = await prisma.user.findUnique({
      where: { id: currentUserId },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
      },
    });

    // Create the friend request
    await prisma.friendship.create({
      data: {
        requesterId: currentUserId,
        receiverId: targetUserId,
        status: "PENDING",
      },
    });

    // Build sender's full name for notification title
    const fullName = [currentUser.firstName, currentUser.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() || currentUser.username;

    // Send notification to the receiver
    try {
      await notifyUser(
        targetUserId,                    // recipient of the notification
        "FRIEND_REQUEST",                // notification type
        fullName,                        // title shows sender's FULL NAME
        "sent you a friend request.",    // description
        {
          actorId: currentUserId,        // the person who sent the request
          firstName: currentUser.firstName || "",
          lastName: currentUser.lastName || "",
        }
      );
    } catch (notificationError) {
      console.error("Failed to send friend request notification:", notificationError);
      // Continue with success response even if notification fails
    }

    return res.json({ message: "Friend request sent." });
  } catch (error) {
    console.error("Send friend request error:", error);
    return res.status(500).json({ error: "Failed to send friend request" });
  }
};


exports.acceptFriendRequest = async (req, res) => {
  try {
 
    const receiverId = req.authData.id;

    const requesterId = parseInt(req.params.userId, 10);

    if (!Number.isFinite(requesterId)) {
      return res.status(400).json({ error: "Invalid requester user id." });
    }
    if (receiverId === requesterId) {
      return res.status(400).json({ error: "You cannot accept your own request." });
    }

    const friendRecord = await prisma.friendship.findFirst({
      where: {
        requesterId: requesterId,
        receiverId: receiverId,
        status: "PENDING",
      },
      include: { requester: true, receiver: true },
    });

    if (!friendRecord) {
      return res.status(404).json({ error: "Friend request not found or already handled." });
    }

    if (friendRecord.status !== "ACCEPTED") {
      await prisma.friendship.update({
        where: { id: friendRecord.id },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });
    }


    const actor = friendRecord.receiver; // acceptor = current user
    const fullName =
      [actor.firstName, actor.lastName].filter(Boolean).join(" ").trim() ||
      actor.username;

   
    try {
      await notifyUser(
        requesterId,                
        "FRIEND_ACCEPTED",
        fullName,                    // title shows actor's name
        "accepted your friend request.",
        {
          actorId: receiverId,       // critical: to fetch actor's avatar in list
          friendId: receiverId,      // optional: helpful for deep links
          firstName: actor.firstName || "",
          lastName: actor.lastName || "",
        }
      );
    } catch (e) {
  
      console.error("notifyUser failed:", e);
    }

    return res.json({ message: "Friend request accepted." });
  } catch (err) {
    console.error("acceptFriendRequest error:", err);
    return res.status(500).json({ error: "Failed to accept friend request" });
  }
};


exports.declineFriendRequest = async (req, res) => {
  const currentUserId = req.authData.id;
  const otherUserId = parseInt(req.params.userId);

  const friendRecord = await prisma.friendship.findFirst({
    where: {
      status: "PENDING",
      OR: [
        { requesterId: currentUserId, receiverId: otherUserId }, // cancel sent
        { requesterId: otherUserId, receiverId: currentUserId }, // decline received
      ],
    },
  });
  if (!friendRecord) {
    return res
      .status(404)
      .json({ error: "No pending friend request between these users." });
  }

  await prisma.friendship.delete({ where: { id: friendRecord.id } });
  return res.json({ message: "Friend request declined (or cancelled)." });
};

// Unfriend
exports.unfriend = async (req, res) => {
  const currentUserId = req.authData.id;
  const friendUserId = parseInt(req.params.userId);

  const friendRecord = await prisma.friendship.findFirst({
    where: {
      status: "ACCEPTED",
      OR: [
        { requesterId: currentUserId, receiverId: friendUserId },
        { requesterId: friendUserId, receiverId: currentUserId },
      ],
    },
  });
  if (!friendRecord) {
    return res.status(404).json({ error: "No friendship exists with that user." });
  }

  await prisma.friendship.delete({ where: { id: friendRecord.id } });
  return res.json({ message: "Unfriended successfully." });
};

// Friend list (weekly points from ledger)
exports.getFriendList = async (req, res) => {
  const currentUserId = req.authData.id;

  const friendships = await prisma.friendship.findMany({
    where: {
      status: "ACCEPTED",
      OR: [{ requesterId: currentUserId }, { receiverId: currentUserId }],
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
            where: { isSaved: true },
            orderBy: { updatedAt: "desc" },
          },
        },
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
            orderBy: { updatedAt: "desc" },
          },
        },
      },
    },
  });

  const friendsRaw = friendships.map((fr) =>
    fr.requesterId === currentUserId ? fr.receiver : fr.requester
  );
  const friendIds = friendsRaw.map((f) => f.id);

  const weekPointsMap = await getWeeklyPointsForUsers(friendIds);

  const friends = friendsRaw.map((friend) => ({
    id: friend.id,
    username: friend.username,
    firstName: friend.firstName,
    lastName: friend.lastName,
    avatarUrl: friend.minime?.[0]?.avatarUrl || null,
    totalPoints: friend.totalPoints || 0,
    thisWeekPoints: weekPointsMap.get(friend.id) || 0,
    profileUrl: `/api/users/${friend.id}/profile`,
  }));

  return res.status(200).json({
    success: true,
    message: "Friends fetched successfully",
    data: friends,
  });
};

// Pending friend request count
exports.getPendingFriendRequestCount = async (req, res) => {
  try {
    const currentUserId = req.authData.id;

    const count = await prisma.friendship.count({
      where: {
        receiverId: currentUserId,
        status: "PENDING",
      },
    });

    return res.json({ count });
  } catch (error) {
    console.error("Error getting pending friend request count:", error);
    return res.status(500).json({ error: "Failed to fetch count" });
  }
};

// Block user
exports.blockUser = async (req, res) => {
  const currentUserId = req.authData.id;
  const targetUserId = parseInt(req.params.userId);

  if (currentUserId === targetUserId) {
    return res.status(400).json({ error: "You cannot block yourself." });
  }

  const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!targetUser) {
    return res.status(404).json({ error: "User not found." });
  }

  const existing = await prisma.block.findUnique({
    where: {
      blockerId_blockedId: { blockerId: currentUserId, blockedId: targetUserId },
    },
  });
  if (existing) {
    return res.status(400).json({ error: "User is already blocked." });
  }

  await prisma.friendship.deleteMany({
    where: {
      OR: [
        { requesterId: currentUserId, receiverId: targetUserId },
        { requesterId: targetUserId, receiverId: currentUserId },
      ],
    },
  });

  await prisma.block.create({
    data: { blockerId: currentUserId, blockedId: targetUserId },
  });
  return res.json({ message: "User blocked successfully." });
};

// Incoming friend requests (weekly points from ledger)
exports.getFriendRequests = async (req, res) => {
  const currentUserId = req.authData.id;

  try {
    const pendingRequests = await prisma.friendship.findMany({
      where: {
        receiverId: currentUserId,
        status: "PENDING",
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
              where: { isSaved: true },
              orderBy: { updatedAt: "desc" },
            },
          },
        },
      },
    });

    const requesters = pendingRequests.map((r) => r.requester);
    const requesterIds = requesters.map((u) => u.id);
    const weekPointsMap = await getWeeklyPointsForUsers(requesterIds);

    const enriched = requesters.map((user) => ({
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.minime?.[0]?.avatarUrl || null,
      totalPoints: user.totalPoints || 0,
      thisWeekPoints: weekPointsMap.get(user.id) || 0,
      profileUrl: `/api/users/${user.id}/profile`,
    }));

    return res.status(200).json({
      success: true,
      message: "Incoming friend requests fetched",
      data: enriched,
    });
  } catch (error) {
    console.error("Friend request fetch error:", error);
    return res.status(500).json({ error: "Failed to load friend requests" });
  }
};

// Unblock user
exports.unblockUser = async (req, res) => {
  const currentUserId = req.authData.id;
  const targetUserId = parseInt(req.params.userId);

  const blockRecord = await prisma.block.findUnique({
    where: {
      blockerId_blockedId: { blockerId: currentUserId, blockedId: targetUserId },
    },
  });
  if (!blockRecord) {
    return res
      .status(404)
      .json({ error: "Block record not found or user is not blocked." });
  }

  await prisma.block.delete({ where: { id: blockRecord.id } });
  return res.json({ message: "User unblocked successfully." });
};

// Recommended friends (weekly points from ledger)
exports.getRecommendedFriends = async (req, res) => {
  const userId = req.authData.id;

  // current friends
  const friendships = await prisma.friendship.findMany({
    where: {
      status: "ACCEPTED",
      OR: [{ requesterId: userId }, { receiverId: userId }],
    },
  });
  const friendIds = friendships.map((f) =>
    f.requesterId === userId ? f.receiverId : f.requesterId
  );

  // blocked
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
  });
  const blockedIds = blocks.map((b) =>
    b.blockerId === userId ? b.blockedId : b.blockerId
  );

  // contacts
  const syncedContacts = await prisma.contactSync.findMany({ where: { userId } });
  const contactUsernames = syncedContacts.map((c) => c.username).filter(Boolean);
  const contactPhones = syncedContacts.map((c) => c.phone).filter(Boolean);

  const contactUsers = await prisma.user.findMany({
    where: {
      OR: [
        contactUsernames.length
          ? { username: { in: contactUsernames } }
          : undefined,
        contactPhones.length ? { phone: { in: contactPhones } } : undefined,
      ].filter(Boolean),
      id: { notIn: [...friendIds, ...blockedIds, userId] },
    },
    select: {
      id: true,
      username: true,
      totalPoints: true,
      minime: {
        select: { avatarUrl: true, isSaved: true, updatedAt: true },
        orderBy: [{ isSaved: "desc" }, { updatedAt: "desc" }],
        take: 1,
      },
    },
  });

  // mutual friends graph
  const mutualFriendships = await prisma.friendship.findMany({
    where: {
      status: "ACCEPTED",
      OR: [{ requesterId: { in: friendIds } }, { receiverId: { in: friendIds } }],
    },
    include: {
      requester: {
        select: {
          id: true,
          username: true,
          minime: {
            select: { avatarUrl: true, isSaved: true, updatedAt: true },
            orderBy: [{ isSaved: "desc" }, { updatedAt: "desc" }],
            take: 1,
          },
        },
      },
      receiver: {
        select: {
          id: true,
          username: true,
          minime: {
            select: { avatarUrl: true, isSaved: true, updatedAt: true },
            orderBy: [{ isSaved: "desc" }, { updatedAt: "desc" }],
            take: 1,
          },
        },
      },
    },
  });

  // communities
  const myCommunities = await prisma.communityMember.findMany({
    where: { userId },
    select: { communityId: true },
  });
  const communityIds = myCommunities.map((c) => c.communityId);

  const communityMembers = communityIds.length
    ? await prisma.communityMember.findMany({
        where: {
          communityId: { in: communityIds },
          userId: { notIn: [...friendIds, ...blockedIds, userId] },
        },
        include: {
          community: { select: { id: true, name: true, imageUrl: true } },
          user: {
            select: {
              id: true,
              username: true,
              totalPoints: true,
              minime: {
                select: { avatarUrl: true, isSaved: true, updatedAt: true },
                orderBy: [{ isSaved: "desc" }, { updatedAt: "desc" }],
                take: 1,
              },
            },
          },
        },
      })
    : [];

  // combine suggestions with single best reason
  const suggested = new Map();

  const upsert = (uId, base) => {
    if (!suggested.has(uId)) {
      suggested.set(uId, {
        id: base.id,
        username: base.username,
        avatarUrl: base.avatarUrl || "",
        totalPoints: base.totalPoints ?? 0,
        thisWeekPoints: 0,
        reason: null,
        _reasonRank: 0,
        mutualFriends: [],
      });
    }
    const entry = suggested.get(uId);

    if (!entry.avatarUrl && base.avatarUrl) entry.avatarUrl = base.avatarUrl;
    if (
      (entry.totalPoints == null || entry.totalPoints === 0) &&
      typeof base.totalPoints === "number"
    )
      entry.totalPoints = base.totalPoints;

    if (base.reason && REASON_RANK[base.reason.type] > (entry._reasonRank || 0)) {
      entry.reason = base.reason;
      entry._reasonRank = REASON_RANK[base.reason.type];
    }

    if (Array.isArray(base.mutualFriends) && base.mutualFriends.length) {
      const seen = new Set(entry.mutualFriends.map((m) => m.id));
      for (const m of base.mutualFriends) {
        if (!seen.has(m.id)) {
          entry.mutualFriends.push({
            id: m.id,
            username: m.username,
            avatarUrl: m.avatarUrl || "",
          });
          seen.add(m.id);
        }
      }
    }
  };

  // from contacts (highest)
  for (const u of contactUsers) {
    upsert(u.id, {
      id: u.id,
      username: u.username,
      avatarUrl: firstAvatar(u.minime),
      totalPoints: u.totalPoints || 0,
      reason: { type: "CONTACT", label: "From contact list" },
    });
  }

  // from mutual friends (2nd) — with via
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
          type: "MUTUAL",
          label: "Mutual Friend",
          via: {
            id: mutual.id,
            username: mutual.username,
            avatarUrl: firstAvatar(mutual.minime),
          },
        },
        mutualFriends: [
          {
            id: mutual.id,
            username: mutual.username,
            avatarUrl: firstAvatar(mutual.minime),
          },
        ],
      });
    };

    if (friendIds.includes(a.id)) pushCandidate(a, b);
    if (friendIds.includes(b.id)) pushCandidate(b, a);
  }

  // from community (lowest)
  for (const cm of communityMembers) {
    const u = cm.user;
    upsert(u.id, {
      id: u.id,
      username: u.username,
      avatarUrl: firstAvatar(u.minime),
      totalPoints: u.totalPoints || 0,
      reason: {
        type: "COMMUNITY",
        label: "Community",
        community: {
          id: cm.community.id,
          name: cm.community.name,
          imageUrl: cm.community.imageUrl || "",
        },
      },
    });
  }

  // weekly points (batch) — from ledger
  const candidateIds = Array.from(suggested.keys());
  if (candidateIds.length) {
    const weekPointsMap = await getWeeklyPointsForUsers(candidateIds);
    for (const id of candidateIds) {
      const e = suggested.get(id);
      e.thisWeekPoints = weekPointsMap.get(id) || 0;
    }
  }

  const payload = Array.from(suggested.values())
    .map((s) => ({
      id: s.id,
      username: s.username,
      avatarUrl: s.avatarUrl || "",
      totalPoints: s.totalPoints,
      thisWeekPoints: s.thisWeekPoints,
      reason:
        s.reason && s.reason.type === "MUTUAL"
          ? s.reason
          : s.reason && s.reason.type === "COMMUNITY"
          ? {
              ...s.reason,
              community: { ...s.reason.community, imageUrl: s.reason.community.imageUrl || "" },
            }
          : s.reason,
    }))
    .slice(0, 20);

  return res.json({ recommended: payload });
};

// Sync contacts
exports.syncContacts = async (req, res) => {
  const userId = req.authData.id;
  const { contacts } = req.body; // [{ username?, phone? }, ...]

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: "No contacts provided" });
  }

  await prisma.contactSync.deleteMany({ where: { userId } });

  const toInsert = contacts.map((c) => ({
    userId,
    username: c.username || null,
    phone: c.phone || null,
  }));

  await prisma.contactSync.createMany({ data: toInsert });

  const matchedUsers = await prisma.user.findMany({
    where: {
      OR: [
        { username: { in: contacts.map((c) => c.username).filter(Boolean) } },
        { phone: { in: contacts.map((c) => c.phone).filter(Boolean) } },
      ],
      id: { not: userId },
    },
    select: {
      id: true,
      username: true,
      phone: true,
      minime: {
        select: { avatarUrl: true },
        where: { isSaved: true },
        orderBy: { updatedAt: 'desc' }
      },
    },
  });

  res.json({
    message: "Contacts synced",
    matched: matchedUsers.map(u => ({
      id: u.id,
      username: u.username,
      phone: u.phone,
      avatarUrl: u.minime?.[0]?.avatarUrl || null
    })),
  });
};

// Blocked users list
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
            totalPoints: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              orderBy: { updatedAt: "desc" },
            },
          },
        },
      },
    });

    const users = blockedUsers.map((block) => ({
      id: block.blocked.id,
      username: block.blocked.username,
      firstName: block.blocked.firstName,
      lastName: block.blocked.lastName,
      avatarUrl:
        block.blocked.minime.length > 0
          ? block.blocked.minime[0].avatarUrl
          : null,
      totalPoints: block.blocked.totalPoints || 0,
    }));

    return res.status(200).json({
      success: true,
      message: "Blocked users fetched successfully",
      data: users,
    });
  } catch (error) {
    console.error("Error fetching blocked users:", error);
    return res.status(500).json({ error: "Failed to fetch blocked users" });
  }
};

// Sent friend requests
exports.getSentFriendRequests = async (req, res) => {
  const currentUserId = req.authData.id;

  try {
    const sentRequests = await prisma.friendship.findMany({
      where: { requesterId: currentUserId, status: "PENDING" },
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
              where: { isSaved: true },
              orderBy: { updatedAt: 'desc' },
            },
          },
        },
      },
    });

    const users = sentRequests.map((request) => ({
      id: request.receiver.id,
      username: request.receiver.username,
      firstName: request.receiver.firstName,
      lastName: request.receiver.lastName,
      avatarUrl: request.receiver.minime?.[0]?.avatarUrl || null, // fixed (array)
      totalPoints: request.receiver.totalPoints || 0,
    }));

    return res.status(200).json({
      success: true,
      message: "Sent friend requests fetched successfully",
      data: users,
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
        status: "ACCEPTED",
        OR: [
          { requesterId: currentUserId, receiverId: friendId },
          { requesterId: friendId, receiverId: currentUserId },
        ],
      },
    });
    if (!friendship) {
      return res.status(403).json({ error: "Not friends with this user" });
    }

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
          orderBy: { updatedAt: "desc" },
        },
      },
    });
    if (!friend) return res.status(404).json({ error: "User not found" });

    const friendStories = await prisma.story.findMany({
      where: {
        userId: friendId,
        visibility: "profile",
        NOT: { status: "VAULT" },
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              orderBy: { updatedAt: "desc" },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const friendCount = await prisma.friendship.count({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: friendId }, { receiverId: friendId }],
      },
    });

    const communitiesRaw = await prisma.communityMember.findMany({
      where: { userId: friendId },
      include: { community: true },
      orderBy: [{ joinedAt: "desc" }],
    });
    const communities = communitiesRaw.map((c) => c.community);
    const recentCommunityImageUrl = communities.length
      ? communities[0].imageUrl || ""
      : "";

    // this friend's weekly points from ledger
    const thisWeekPoints = await getWeeklyPointsForUser(friendId);

    // friend-of-friend list
    const friendLinks = await prisma.friendship.findMany({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: friendId }, { receiverId: friendId }],
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
              where: { isSaved: true },
              orderBy: { updatedAt: "desc" },
              take: 1,
            },
          },
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
              orderBy: { updatedAt: "desc" },
              take: 1,
            },
          },
        },
      },
    });

    const rawOthers = [];
    for (const row of friendLinks) {
      const other = row.requester.id === friendId ? row.receiver : row.requester;
      if (other.id !== friendId && other.id !== currentUserId) {
        rawOthers.push(other);
      }
    }
    const seen = new Set();
    const allFriendUsers = [];
    for (const u of rawOthers) {
      if (!seen.has(u.id)) {
        allFriendUsers.push(u);
        seen.add(u.id);
      }
    }

    const fofIds = allFriendUsers.map((u) => u.id);
    const fofWeeklyMap = await getWeeklyPointsForUsers(fofIds);

    let friendFriends = allFriendUsers.map((u) => ({
      id: u.id,
      username: u.username,
      firstName: u.firstName,
      lastName: u.lastName,
      avatarUrl: u.minime?.[0]?.avatarUrl || "",
      totalPoints: u.totalPoints || 0,
      thisWeekPoints: fofWeeklyMap.get(u.id) || 0,
    }));

    const sortBy = (req.query.sortBy || "").toString();
    if (sortBy === "thisWeekPoints") {
      friendFriends.sort((a, b) => b.thisWeekPoints - a.thisWeekPoints);
    } else if (sortBy === "totalPoints") {
      friendFriends.sort((a, b) => b.totalPoints - a.totalPoints);
    } else if (sortBy === "username") {
      friendFriends.sort((a, b) =>
        (a.username || "").localeCompare(b.username || "")
      );
    }
    const limit = parseInt(req.query.limit, 10);
    if (Number.isFinite(limit) && limit > 0) {
      friendFriends = friendFriends.slice(0, limit);
    }

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
        communities,
        recentCommunityImageUrl,
        thisWeekPoints,
        stories: friendStories,
        friendFriends,
      },
    });
  } catch (error) {
    console.error("Error fetching friend profile:", error);
    return res.status(500).json({ error: "Failed to fetch friend profile" });
  }
};

// Public user profile (weekly points shown only for self/friend; calculated from ledger)
exports.getUserProfile = async (req, res) => {
  const currentUserId = req.authData.id;
  const targetUserId = parseInt(req.params.userId);

  try {
    const isSelf = currentUserId === targetUserId;

    const friendship = await prisma.friendship.findFirst({
      where: {
        status: "ACCEPTED",
        OR: [
          { requesterId: currentUserId, receiverId: targetUserId },
          { requesterId: targetUserId, receiverId: currentUserId },
        ],
      },
    });
    const isFriend = !!friendship;

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
          orderBy: { updatedAt: "desc" },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const stories = await prisma.story.findMany({
      where: {
        userId: targetUserId,
        visibility: "profile",
        NOT: { status: "VAULT" },
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              orderBy: { updatedAt: "desc" },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const friendCount = await prisma.friendship.count({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: targetUserId }, { receiverId: targetUserId }],
      },
    });

    const communities = await prisma.communityMember.findMany({
      where: { userId: targetUserId },
      include: { community: true },
    });

    let thisWeekPoints = null;
    if (isSelf || isFriend) {
      thisWeekPoints = await getWeeklyPointsForUser(targetUserId);
    }

    // Fetch the most recent joined or created community
    const mostRecentCommunity = await prisma.communityMember.findFirst({
      where: { userId: targetUserId },
      include: {
        community: true,
      },
      orderBy: { joinedAt: "desc" },
    });

    const mostRecent = mostRecentCommunity
      ? {
          id: mostRecentCommunity.community.id,
          name: mostRecentCommunity.community.name,
          imageUrl: mostRecentCommunity.community.imageUrl || null,
          membersCount: await prisma.communityMember.count({
            where: { communityId: mostRecentCommunity.community.id },
          }),
          type: mostRecentCommunity.community.creatorId === targetUserId ? "created" : "joined",
          at: mostRecentCommunity.joinedAt,
        }
      : null;

    const profileData = {
      id: user.id,
      username: user.username,
      firstName: isSelf || isFriend ? user.firstName : null,
      lastName: isSelf || isFriend ? user.lastName : null,
      minime: user.minime,
      friendCount,
      communities: isSelf || isFriend ? communities.map((c) => c.community) : [],
      thisWeekPoints: isSelf || isFriend ? thisWeekPoints : null,
      bio: isSelf || isFriend ? user.bio : null,
      totalPoints: isSelf || isFriend ? user.totalPoints : null,
      stories,
      mostRecent,
    };

    return res.status(200).json({
      success: true,
      message: "User profile fetched",
      data: profileData,
    });
  } catch (error) {
    console.error("Error fetching profile:", error);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
};
