// Get notificationRedDot value for authenticated user
exports.getNotificationRedDot = async (req, res) => {
  try {
    const userId = req.authData.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { notificationRedDot: true }
    });
    res.json({ success: true, notificationRedDot: user?.notificationRedDot ?? false });
  } catch (err) {
    console.error('Get notificationRedDot error:', err);
    res.status(500).json({ success: false, message: 'Failed to get notification red dot.' });
  }
};
// Reset notificationRedDot to false for authenticated user
exports.resetNotificationRedDot = async (req, res) => {
  try {
    const userId = req.authData.id;
    await prisma.user.update({
      where: { id: userId },
      data: { notificationRedDot: false }
    });
    res.json({ success: true, message: 'Notification red dot reset.' });
  } catch (err) {
    console.error('Reset notificationRedDot error:', err);
    res.status(500).json({ success: false, message: 'Failed to reset notification red dot.' });
  }
};
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function enrichNotification(n) {
  return {
    id: n.id,
    userId: n.userId,
    actorId: n.actorId,
    type: n.type,
    title: n.title,
    description: n.description,
    isRead: n.isRead,
    createdAt: n.createdAt,
    avatarUrl: n.actor?.minime?.[0]?.avatarUrl || null,
    actorUsername: n.actor?.username || null,
    actorFirstName: n.actor?.firstName || null,
    actorLastName: n.actor?.lastName || null,
    challengeId: n.data?.challengeId || null,
    friendId: n.data?.friendId || n.actorId || null,
    frequency: n.data?.frequency || null,
    points: n.data?.points || null,
  };
}

exports.getNotifications = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { type, read } = req.query;

    // Build dynamic where clause based on query parameters
    let whereClause = { userId };

    // Filter by read status
    if (read === 'unread') {
      whereClause.isRead = false;
    } else if (read === 'read') {
      whereClause.isRead = true;
    }
    // if read is not specified, get all (read and unread)

    // Filter by notification type
    if (type === 'friend_requests') {
      whereClause.type = { in: ['FRIEND_REQUEST', 'FRIEND_ACCEPTED'] };
    } else if (type === 'challenges') {
      whereClause.type = { in: ['NEW_CHALLENGE', 'DAILY_CHALLENGE', 'WEEKLY_CHALLENGE'] };
    }
    // if type is not specified, get all types

    const notifications = await prisma.notification.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
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

    const enriched = notifications.map(enrichNotification);

    res.status(200).json({
      success: true,
      data: enriched,
      count: enriched.length
    });

  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications'
    });
  }
};


exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.authData.id;

    const result = await prisma.notification.updateMany({
      where: { id: parseInt(id), userId },
      data: { isRead: true }
    });

    if (!result.count) {
      return res.status(404).json({ error: "Notification not found" });
    }

    res.json({ message: "Notification marked as read" });
  } catch (err) {
    console.error("Mark read error:", err);
    res.status(500).json({ error: "Failed to mark notification" });
  }
};

exports.clearAll = async (req, res) => {
  try {
    const userId = req.authData.id;
    await prisma.notification.deleteMany({ where: { userId } });
    res.json({ message: "All notifications cleared" });
  } catch (err) {
    console.error("Clear all error:", err);
    res.status(500).json({ error: "Failed to clear notifications" });
  }
};

// Mark a single notification as unread
exports.markAsUnread = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.authData.id;

    const result = await prisma.notification.updateMany({
      where: { id: parseInt(id), userId },
      data: { isRead: false }
    });

    if (!result.count) {
      return res.status(404).json({ error: "Notification not found" });
    }

    res.json({ message: "Notification marked as unread" });
  } catch (err) {
    console.error("Mark unread error:", err);
    res.status(500).json({ error: "Failed to mark notification as unread" });
  }
};

// Delete a single notification by id
exports.deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.authData.id;

    const result = await prisma.notification.deleteMany({ where: { id: parseInt(id), userId } });

    if (!result.count) {
      return res.status(404).json({ error: "Notification not found" });
    }

    res.json({ message: "Notification deleted" });
  } catch (err) {
    console.error("Delete notification error:", err);
    res.status(500).json({ error: "Failed to delete notification" });
  }
};

exports.getUnreadNotifications = async (req, res) => {
  try {
    const userId = req.authData.id; // Changed from req.user.id to req.authData.id

    const unreadNotifications = await prisma.notification.findMany({
      where: {
        userId: userId,
        isRead: false
      },
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              orderBy: { updatedAt: 'desc' },
              take: 1
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    const enriched = unreadNotifications.map(enrichNotification);

    res.status(200).json({
      success: true,
      data: enriched,
      count: enriched.length
    });

  } catch (error) {
    console.error('Error fetching unread notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch unread notifications'
    });
  }
};

exports.getFriendRequestNotifications = async (req, res) => {
  try {
    const userId = req.authData.id;

    const friendRequestNotifications = await prisma.notification.findMany({
      where: {
        userId: userId,
        type: {
          in: ['FRIEND_REQUEST', 'FRIEND_ACCEPTED']
        }
      },
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              orderBy: { updatedAt: 'desc' },
              take: 1
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    const enriched = friendRequestNotifications.map(enrichNotification);

    res.status(200).json({
      success: true,
      data: enriched,
      count: enriched.length
    });

  } catch (error) {
    console.error('Error fetching friend request notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch friend request notifications'
    });
  }
};

exports.getFriendRequestsUnread = async (req, res) => {
  try {
    const userId = req.authData.id;

    const unreadFriendRequestNotifications = await prisma.notification.findMany({
      where: {
        userId: userId,
        type: {
          in: ['FRIEND_REQUEST', 'FRIEND_ACCEPTED']
        },
        isRead: false
      },
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              orderBy: { updatedAt: 'desc' },
              take: 1
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    const enriched = unreadFriendRequestNotifications.map(enrichNotification);

    res.status(200).json({
      success: true,
      data: enriched,
      count: enriched.length
    });

  } catch (error) {
    console.error('Error fetching unread friend request notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch unread friend request notifications'
    });
  }
};

exports.getChallengeNotifications = async (req, res) => {
  try {
    const userId = req.authData.id;

    const challengeNotifications = await prisma.notification.findMany({
      where: {
        userId: userId,
        type: {
          in: ['NEW_CHALLENGE', 'DAILY_CHALLENGE', 'WEEKLY_CHALLENGE']
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    const enriched = challengeNotifications.map(enrichNotification);

    res.status(200).json({
      success: true,
      data: enriched,
      count: enriched.length
    });

  } catch (error) {
    console.error('Error fetching challenge notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch challenge notifications'
    });
  }
};

exports.getChallengeNotificationsUnread = async (req, res) => {
  try {
    const userId = req.authData.id;

    const unreadChallengeNotifications = await prisma.notification.findMany({
      where: {
        userId: userId,
        type: {
          in: ['NEW_CHALLENGE', 'DAILY_CHALLENGE', 'WEEKLY_CHALLENGE']
        },
        isRead: false
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    const enriched = unreadChallengeNotifications.map(enrichNotification);

    res.status(200).json({
      success: true,
      data: enriched,
      count: enriched.length
    });

  } catch (error) {
    console.error('Error fetching unread challenge notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch unread challenge notifications'
    });
  }
};

exports.muteChat = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { chatId } = req.params; // Retrieve chatId from req.params

    await prisma.userOnChat.update({
      where: {
        userId_chatId: {
          userId: parseInt(userId, 10),
          chatId: parseInt(chatId, 10),
        },
      },
      data: {
        isMuted: true,
        mutedAt: new Date(),
      },
    });

    res.json({ message: "Chat notifications muted" });
  } catch (err) {
    console.error("Mute chat error:", err);
    res.status(500).json({ error: "Failed to mute chat notifications" });
  }
};

exports.unmuteChat = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { chatId } = req.params; // Retrieve chatId from req.params

    await prisma.userOnChat.update({
      where: {
        userId_chatId: {
          userId: parseInt(userId, 10),
          chatId: parseInt(chatId, 10),
        },
      },
      data: {
        isMuted: false,
        mutedAt: null,
      },
    });

    res.json({ message: "Chat notifications unmuted" });
  } catch (err) {
    console.error("Unmute chat error:", err);
    res.status(500).json({ error: "Failed to unmute chat notifications" });
  }
};

exports.getChatMuteStatus = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { chatId } = req.params; // Retrieve chatId from req.params

    const userOnChat = await prisma.userOnChat.findUnique({
      where: {
        userId_chatId: {
          userId: parseInt(userId, 10),
          chatId: parseInt(chatId, 10),
        },
      },
      select: {
        isMuted: true,
      },
    });

    if (!userOnChat) {
      return res.status(404).json({ error: "Chat not found or user not part of the chat" });
    }

    res.json({ isMuted: userOnChat.isMuted });
  } catch (err) {
    console.error("Get chat mute status error:", err);
    res.status(500).json({ error: "Failed to get chat mute status" });
  }
};

//test
