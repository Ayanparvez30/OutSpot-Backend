const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

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

    const enriched = notifications.map(n => ({
      id: n.id,
      userId: n.userId,
      type: n.type,
      title: n.title,
      description: n.description,
      isRead: n.isRead,
      createdAt: n.createdAt,
      avatarUrl: n.actor?.minime?.[0]?.avatarUrl || null,
      challengeId: n.data?.challengeId || null // Include challengeId if available
    }));

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

    await prisma.notification.updateMany({
      where: { id: parseInt(id), userId },
      data: { isRead: true }
    });

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

    // Use the same enrichment format as your getNotifications function
    const enriched = unreadNotifications.map(n => ({
      id: n.id,
      userId: n.userId,
      type: n.type,
      title: n.title,
      description: n.description,
      isRead: n.isRead,
      createdAt: n.createdAt,
      avatarUrl: n.actor?.minime?.[0]?.avatarUrl || null
    }));

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

    const enriched = friendRequestNotifications.map(n => ({
      id: n.id,
      userId: n.userId,
      type: n.type,
      title: n.title,
      description: n.description,
      isRead: n.isRead,
      createdAt: n.createdAt,
      avatarUrl: n.actor?.minime?.[0]?.avatarUrl || null
    }));

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

    const enriched = unreadFriendRequestNotifications.map(n => ({
      id: n.id,
      userId: n.userId,
      type: n.type,
      title: n.title,
      description: n.description,
      isRead: n.isRead,
      createdAt: n.createdAt,
      avatarUrl: n.actor?.minime?.[0]?.avatarUrl || null
    }));

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

    const enriched = challengeNotifications.map(n => ({
      id: n.id,
      userId: n.userId,
      type: n.type,
      title: n.title,
      description: n.description,
      isRead: n.isRead,
      createdAt: n.createdAt
    }));

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

    const enriched = unreadChallengeNotifications.map(n => ({
      id: n.id,
      userId: n.userId,
      type: n.type,
      title: n.title,
      description: n.description,
      isRead: n.isRead,
      createdAt: n.createdAt
    }));

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

    await prisma.notification.updateMany({
      where: {
        userId: userId,
        type: 'CHAT_MESSAGE', // Assuming the type for chat notifications
        'data.chatId': chatId // Match the specific chatId
      },
      data: { isMuted: true }
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

    await prisma.notification.updateMany({
      where: {
        userId: userId,
        type: 'CHAT_MESSAGE', // Assuming the type for chat notifications
        'data.chatId': chatId // Match the specific chatId
      },
      data: { isMuted: false }
    });

    res.json({ message: "Chat notifications unmuted" });
  } catch (err) {
    console.error("Unmute chat error:", err);
    res.status(500).json({ error: "Failed to unmute chat notifications" });
  }
};

//test
