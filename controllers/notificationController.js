const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.getNotifications = async (req, res) => {
  try {
    const userId = req.authData.id;
    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(notifications);
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
