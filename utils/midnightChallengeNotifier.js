// utils/midnightChallengeNotifier.js
const { PrismaClient } = require('@prisma/client');
const { notifyUser } = require('./notificationService');
const { getAssignedChallenge, resolveZone, startOfDayInZone, getWeekStartEndInZone } = require('./challenges');

const prisma = new PrismaClient();

/**
 * Check if a notification was already sent for this user + type + current window
 */
async function alreadyNotified(userId, type, windowStart) {
  const existing = await prisma.notification.findFirst({
    where: { userId, type, createdAt: { gte: windowStart } }
  });
  return !!existing;
}

/**
 * Notify all users whose local timezone midnight matches the given timezone.
 * Called by the scheduler once per timezone at midnight.
 *
 * @param {string} timezone - IANA timezone (e.g. 'America/New_York')
 * @returns {{ success: boolean, usersProcessed: number, dailyNotifications: number, weeklyNotifications: number, totalNotifications: number, error?: string }}
 */
async function notifyUsersAboutMidnightChallenges(timezone) {
  try {
    const zone = resolveZone(timezone);
    const now = new Date();
    const dayStart = startOfDayInZone(now, zone);
    const { startUTC: weekStart } = getWeekStartEndInZone(now, zone);
    const isMonday = new Date(now).toLocaleString('en-US', { timeZone: zone, weekday: 'long' }) === 'Sunday';

    // Only users with a valid FCM token (exclude null and empty string)
    const users = await prisma.user.findMany({
      where: { fcmToken: { not: null }, NOT: { fcmToken: '' } },
      select: { id: true }
    });

    let usersProcessed = 0;
    let dailyNotifications = 0;
    let weeklyNotifications = 0;

    for (const user of users) {
      try {
        usersProcessed++;

        // --- Daily ---
        const dailySent = await alreadyNotified(user.id, 'DAILY_CHALLENGE', dayStart);
        if (!dailySent) {
          const assignment = await getAssignedChallenge(prisma, user.id, 'DAILY', zone, now);
          if (assignment?.challenge) {
            await notifyUser(
              user.id,
              'DAILY_CHALLENGE',
              assignment.challenge.title,
              assignment.challenge.description,
              {
                challengeId: assignment.challenge.id,
                frequency: 'DAILY',
                points: assignment.challenge.points,
                tier: assignment.challenge.tier
              }
            );
            dailyNotifications++;
          }
        }

        // --- Weekly (only on Sunday / week rollover) ---
        if (isMonday) {
          const weeklySent = await alreadyNotified(user.id, 'WEEKLY_CHALLENGE', weekStart);
          if (!weeklySent) {
            const assignment = await getAssignedChallenge(prisma, user.id, 'WEEKLY', zone, now);
            if (assignment?.challenge) {
              await notifyUser(
                user.id,
                'WEEKLY_CHALLENGE',
                assignment.challenge.title,
                assignment.challenge.description,
                {
                  challengeId: assignment.challenge.id,
                  frequency: 'WEEKLY',
                  points: assignment.challenge.points,
                  tier: assignment.challenge.tier
                }
              );
              weeklyNotifications++;
            }
          }
        }
      } catch (err) {
        console.error(`❌ Failed challenge notification for user ${user.id}:`, err.message);
      }
    }

    return {
      success: true,
      usersProcessed,
      dailyNotifications,
      weeklyNotifications,
      totalNotifications: dailyNotifications + weeklyNotifications
    };
  } catch (err) {
    console.error('❌ notifyUsersAboutMidnightChallenges error:', err);
    return { success: false, error: err.message, usersProcessed: 0, dailyNotifications: 0, weeklyNotifications: 0, totalNotifications: 0 };
  }
}

module.exports = { notifyUsersAboutMidnightChallenges };
