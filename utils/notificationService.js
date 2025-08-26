const admin = require('../firebaseAdmin');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Send notification to a user (saves in DB + pushes via Firebase).
 *
 * @param {number} userId - Recipient user ID
 * @param {string} type - NotificationType enum (e.g. FRIEND_ACCEPTED, NEW_CHALLENGE)
 * @param {string} title - Notification title
 * @param {string} description - Notification body
 * @param {object} data - Optional extra data for the app (deep link info, etc.)
 */
async function notifyUser(userId, type, title, description, data = {}) {
  try {
    // Save to DB
    const notification = await prisma.notification.create({
      data: { userId, type, title, description }
    });

    // Get user with FCM token
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (user?.fcmToken) {
      const message = {
        token: user.fcmToken,
        notification: { title, body: description },
        data: {
          type,
          notificationId: String(notification.id),
          ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) // stringify values
        }
      };

      await admin.messaging().send(message);
      console.log(`✅ Push sent to user ${userId}`);
    } else {
      console.log(`ℹ️ User ${userId} has no FCM token, skipping push`);
    }

    return notification;
  } catch (err) {
    console.error("❌ notifyUser failed:", err);
    throw err;
  }
}

module.exports = { notifyUser };
