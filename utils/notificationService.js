const admin = require('../firebaseAdmin');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Send notification to a user (saves in DB + pushes via Firebase).
 *
 * @param {number} userId
 * @param {string} type
 * @param {string} title
 * @param {string} description
 * @param {object} data - extra data (e.g., { actorId, friendId, ... })
 */
async function notifyUser(userId, type, title, description, data = {}) {
  try {
    const { actorId = null, ...restData } = data;


    // 1) Save to DB (store actorId + extra metadata)
    const notification = await prisma.notification.create({
      data: {
        userId, type, title, description, actorId,
        data: Object.keys(restData).length > 0 ? restData : undefined,
      }
    });

    // 2) Set notificationRedDot to true for the user
    await prisma.user.update({
      where: { id: userId },
      data: { notificationRedDot: true }
    });

    // 2) Load recipient for FCM token
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Master notification switch: skip ALL FCM push if the user turned it off.
    // null/undefined is treated as ON (default). In-app record is still saved.
    if (user?.fcmToken && user.notificationEnabled !== false) {
      const message = {
        token: user.fcmToken,
        notification: { title, body: description },
        data: {
          type,
          notificationId: String(notification.id),
          // Always stringify FCM data values
          ...Object.fromEntries(
            Object.entries(restData).map(([k, v]) => [k, String(v)])
          ),
          ...(actorId != null ? { actorId: String(actorId) } : {})
        }
      };

      try {
        await admin.messaging().send(message);
        console.log(`✅ Push sent to user ${userId}`);
      } catch (fcmError) {
        console.log(`⚠️ FCM delivery failed for user ${userId}:`, fcmError.message);
        console.log(`   Notification still saved to database`);
      }
    } else {
      console.log(`ℹ️ User ${userId} has no FCM token, skipping push`);
    }

    return notification;
  } catch (err) {
    console.error('❌ notifyUser failed:', err);
    throw err;
  }
}

module.exports = { notifyUser };
