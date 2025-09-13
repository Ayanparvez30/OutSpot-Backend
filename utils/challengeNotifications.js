// utils/challengeNotifications.js
const { notifyUser } = require('./notificationService');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Send notification when a new challenge becomes available for a user
 * @param {number} userId - The user to notify
 * @param {object} challenge - The challenge object
 * @param {string} frequency - 'DAILY' or 'WEEKLY'
 */
async function notifyNewChallenge(userId, challenge, frequency) {
  try {
    const notificationType = frequency === 'DAILY' ? 'DAILY_CHALLENGE' : 'WEEKLY_CHALLENGE';
    
    // Use the actual challenge title and description from the database
    const title = challenge.title;
    const description = challenge.description;

    await notifyUser(
      userId,
      notificationType,
      title,
      description,
      {
        challengeId: challenge.id,
        frequency: frequency,
        points: challenge.points,
        tier: challenge.tier
      }
    );

    console.log(`✅ ${frequency.toLowerCase()} challenge notification sent to user ${userId}`);
  } catch (error) {
    console.error(`❌ Failed to send ${frequency.toLowerCase()} challenge notification to user ${userId}:`, error);
  }
}

/**
 * Check if a user should be notified about a new challenge
 * This prevents spam notifications by checking if the user already has this challenge for the current window
 * @param {number} userId - The user to check
 * @param {object} challenge - The challenge object
 * @param {string} windowKey - The window key (date for daily, week start for weekly)
 * @param {string} frequency - 'DAILY' or 'WEEKLY'
 */
async function shouldNotifyUser(userId, challenge, windowKey, frequency) {
  try {
    // Check if user has already been notified about this challenge in this window
    const notificationType = frequency === 'DAILY' ? 'DAILY_CHALLENGE' : 'WEEKLY_CHALLENGE';
    
    // We need to check notifications from the start of the current window
    // For daily: start of current day
    // For weekly: start of current week
    const { DateTime } = require('luxon');
    const { resolveZone, startOfDayInZone, getWeekStartEndInZone } = require('./challenges');
    
    const zone = resolveZone(null); // Use default zone
    const now = new Date();
    
    let windowStart;
    if (frequency === 'DAILY') {
      windowStart = startOfDayInZone(now, zone);
    } else {
      const { startUTC } = getWeekStartEndInZone(now, zone);
      windowStart = startUTC;
    }

    // Check if there's already a notification for this challenge type in this window
    const existingNotification = await prisma.notification.findFirst({
      where: {
        userId: userId,
        type: notificationType,
        createdAt: {
          gte: windowStart
        }
      }
    });

    return !existingNotification; // Notify if no existing notification found
  } catch (error) {
    console.error(`❌ Error checking if user ${userId} should be notified:`, error);
    return false; // Don't notify on error to prevent spam
  }
}

/**
 * Notify all active users about new daily challenges
 * This should be called once per day (e.g., via cron job)
 */
async function notifyAllUsersAboutDailyChallenge() {
  try {
    console.log('🔔 Starting daily challenge notifications...');
    
    // Get all users with FCM tokens (active users)
    const activeUsers = await prisma.user.findMany({
      where: {
        fcmToken: {
          not: null
        }
      },
      select: {
        id: true
      }
    });

    let notifiedCount = 0;
    
    for (const user of activeUsers) {
      try {
        const { getAssignedChallenge, resolveZone } = require('./challenges');
        const zone = resolveZone(null); // Use default timezone since User doesn't have timezone field
        const now = new Date();
        
        const assignment = await getAssignedChallenge(prisma, user.id, 'DAILY', zone, now);
        
        if (assignment?.challenge) {
          const shouldNotify = await shouldNotifyUser(user.id, assignment.challenge, assignment.windowKey, 'DAILY');
          
          if (shouldNotify) {
            await notifyNewChallenge(user.id, assignment.challenge, 'DAILY');
            notifiedCount++;
          }
        }
      } catch (error) {
        console.error(`❌ Failed to notify user ${user.id} about daily challenge:`, error);
      }
    }
    
    console.log(`✅ Daily challenge notifications completed. Notified ${notifiedCount} users.`);
  } catch (error) {
    console.error('❌ Failed to send daily challenge notifications:', error);
  }
}

/**
 * Notify all active users about new weekly challenges
 * This should be called once per week (e.g., via cron job on Sunday)
 */
async function notifyAllUsersAboutWeeklyChallenge() {
  try {
    console.log('🔔 Starting weekly challenge notifications...');
    
    // Get all users with FCM tokens (active users)
    const activeUsers = await prisma.user.findMany({
      where: {
        fcmToken: {
          not: null
        }
      },
      select: {
        id: true
      }
    });

    let notifiedCount = 0;
    
    for (const user of activeUsers) {
      try {
        const { getAssignedChallenge, resolveZone } = require('./challenges');
        const zone = resolveZone(null); // Use default timezone since User doesn't have timezone field
        const now = new Date();
        
        const assignment = await getAssignedChallenge(prisma, user.id, 'WEEKLY', zone, now);
        
        if (assignment?.challenge) {
          const shouldNotify = await shouldNotifyUser(user.id, assignment.challenge, assignment.windowKey, 'WEEKLY');
          
          if (shouldNotify) {
            await notifyNewChallenge(user.id, assignment.challenge, 'WEEKLY');
            notifiedCount++;
          }
        }
      } catch (error) {
        console.error(`❌ Failed to notify user ${user.id} about weekly challenge:`, error);
      }
    }
    
    console.log(`✅ Weekly challenge notifications completed. Notified ${notifiedCount} users.`);
  } catch (error) {
    console.error('❌ Failed to send weekly challenge notifications:', error);
  }
}

module.exports = {
  notifyNewChallenge,
  shouldNotifyUser,
  notifyAllUsersAboutDailyChallenge,
  notifyAllUsersAboutWeeklyChallenge
};
