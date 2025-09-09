const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.getNotifications = async (req, res) => {
  try {
    const userId = req.authData.id;

const notifications = await prisma.notification.findMany({
  where: { userId },
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
  avatarUrl: n.actor?.minime?.[0]?.avatarUrl || null
}));


    res.json(enriched);
  } catch (err) {
    console.error("Get notifications error:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
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
    const userId = req.user.id;

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
            lastName: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.status(200).json({
      success: true,
      data: unreadNotifications,
      count: unreadNotifications.length
    });

  } catch (error) {
    console.error('Error fetching unread notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch unread notifications'
    });
  }
};
