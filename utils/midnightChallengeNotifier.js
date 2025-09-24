// utils/midnightChallengeNotifier.js
const { PrismaClient } = require('@prisma/client');
const { DateTime } = require('luxon');
const prisma = new PrismaClient();

const {
  resolveZone,
  getAssignedChallenge,
  dateKeyInZone,
  weekKeyInZone,
} = require('./challenges');

/**
 * Notify users about new challenges available at midnight in their timezone
 * This should be called at midnight for each timezone
 */
async function notifyUsersAboutMidnightChallenges(targetTimezone = null) {
  try {
    console.log(`🌙 Starting midnight challenge notifications${targetTimezone ? ` for timezone: ${targetTimezone}` : ' for all users'}...`);
    
    // Get all users, optionally filtered by timezone
    const whereClause = {};
    if (targetTimezone) {
      // Note: If you don't store timezone in user table, we'll use the default timezone
      // For now, we'll process all users and use resolveZone for each
    }
    
    const users = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        username: true,
        fcmToken: true,
        // Add timezone field if you have it in your user model
        // timezone: true,
      },
    });

    console.log(`📱 Found ${users.length} users to process`);

    const now = new Date();
    let notificationCount = 0;
    let dailyNotifications = 0;
    let weeklyNotifications = 0;

    for (const user of users) {
      try {
        const userZone = resolveZone(targetTimezone || null); // Use provided timezone or default
        const userId = user.id;

        // Check what challenges are assigned to this user today
        const dailyAssign = await getAssignedChallenge(prisma, userId, 'DAILY', userZone, now);
        const weeklyAssign = await getAssignedChallenge(prisma, userId, 'WEEKLY', userZone, now);

        // Create notification for daily challenge
        if (dailyAssign && dailyAssign.challenge) {
          const todayKey = dateKeyInZone(now, userZone);
          
          // Check if we already sent a notification for this challenge today
          const existingDailyNotification = await prisma.notification.findFirst({
            where: {
              userId,
              type: 'DAILY_CHALLENGE',
              createdAt: {
                gte: DateTime.fromJSDate(now, { zone: userZone }).startOf('day').toUTC().toJSDate(),
                lte: DateTime.fromJSDate(now, { zone: userZone }).endOf('day').toUTC().toJSDate(),
              },
            },
          });

          if (!existingDailyNotification) {
            await prisma.notification.create({
              data: {
                userId,
                type: 'DAILY_CHALLENGE',
                title: 'New Daily Challenge Available! 🌟',
                description: `Your daily challenge is ready: "${dailyAssign.challenge.title}". Complete it to earn ${dailyAssign.challenge.points} points!`,
                isRead: false,
              },
            });
            
            dailyNotifications++;
            console.log(`✅ Daily challenge notification sent to user ${user.username} (${userId}): ${dailyAssign.challenge.title}`);
          } else {
            console.log(`⏭️  Daily notification already sent to user ${user.username} (${userId}) today`);
          }
        }

        // Check if it's the start of a new week (Sunday in US timezone)
        const dt = DateTime.fromJSDate(now, { zone: userZone });
        const isStartOfWeek = dt.weekday === 7; // Sunday = 7 in Luxon

        // Create notification for weekly challenge (only on Sundays)
        if (isStartOfWeek && weeklyAssign && weeklyAssign.challenge) {
          const weekKey = weekKeyInZone(now, userZone);
          
          // Check if we already sent a weekly notification this week
          const weekStart = dt.minus({ days: dt.weekday % 7 }).startOf('day');
          const weekEnd = weekStart.plus({ days: 6 }).endOf('day');
          
          const existingWeeklyNotification = await prisma.notification.findFirst({
            where: {
              userId,
              type: 'WEEKLY_CHALLENGE',
              createdAt: {
                gte: weekStart.toUTC().toJSDate(),
                lte: weekEnd.toUTC().toJSDate(),
              },
            },
          });

          if (!existingWeeklyNotification) {
            await prisma.notification.create({
              data: {
                userId,
                type: 'WEEKLY_CHALLENGE',
                title: 'New Weekly Challenge Available! 🏆',
                description: `Your weekly challenge is here: "${weeklyAssign.challenge.title}". Complete it to earn ${weeklyAssign.challenge.points} points!`,
                isRead: false,
              },
            });
            
            weeklyNotifications++;
            console.log(`✅ Weekly challenge notification sent to user ${user.username} (${userId}): ${weeklyAssign.challenge.title}`);
          } else {
            console.log(`⏭️  Weekly notification already sent to user ${user.username} (${userId}) this week`);
          }
        }

      } catch (userError) {
        console.error(`❌ Error processing user ${user.id}:`, userError);
      }
    }

    notificationCount = dailyNotifications + weeklyNotifications;
    
    console.log(`🎯 Midnight challenge notifications completed!`);
    console.log(`📊 Summary:`);
    console.log(`   • Daily notifications sent: ${dailyNotifications}`);
    console.log(`   • Weekly notifications sent: ${weeklyNotifications}`);
    console.log(`   • Total notifications sent: ${notificationCount}`);
    
    return {
      success: true,
      totalNotifications: notificationCount,
      dailyNotifications,
      weeklyNotifications,
      usersProcessed: users.length,
    };

  } catch (error) {
    console.error('❌ Error in midnight challenge notifications:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Test function to simulate midnight for a specific user
 */
async function testMidnightNotificationForUser(userId, simulatedTimezone = null) {
  try {
    console.log(`🧪 Testing midnight notification for user ${userId}...`);
    
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true },
    });

    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    const userZone = resolveZone(simulatedTimezone);
    const now = new Date();
    
    // Get assigned challenges
    const dailyAssign = await getAssignedChallenge(prisma, userId, 'DAILY', userZone, now);
    const weeklyAssign = await getAssignedChallenge(prisma, userId, 'WEEKLY', userZone, now);

    let notifications = [];

    // Create daily notification
    if (dailyAssign && dailyAssign.challenge) {
      const dailyNotification = await prisma.notification.create({
        data: {
          userId,
          type: 'DAILY_CHALLENGE',
          title: 'New Daily Challenge Available! 🌟',
          description: `Your daily challenge is ready: "${dailyAssign.challenge.title}". Complete it to earn ${dailyAssign.challenge.points} points!`,
          isRead: false,
        },
      });
      notifications.push({ type: 'daily', notification: dailyNotification, challenge: dailyAssign.challenge });
    }

    // Create weekly notification (simulate Sunday)
    if (weeklyAssign && weeklyAssign.challenge) {
      const weeklyNotification = await prisma.notification.create({
        data: {
          userId,
          type: 'WEEKLY_CHALLENGE',
          title: 'New Weekly Challenge Available! 🏆',
          description: `Your weekly challenge is here: "${weeklyAssign.challenge.title}". Complete it to earn ${weeklyAssign.challenge.points} points!`,
          isRead: false,
        },
      });
      notifications.push({ type: 'weekly', notification: weeklyNotification, challenge: weeklyAssign.challenge });
    }

    console.log(`✅ Test completed for user ${user.username}. Created ${notifications.length} notifications.`);
    
    return {
      success: true,
      user,
      notifications,
      timezone: userZone,
    };

  } catch (error) {
    console.error(`❌ Error testing midnight notification for user ${userId}:`, error);
    return {
      success: false,
      error: error.message,
    };
  }
}

module.exports = {
  notifyUsersAboutMidnightChallenges,
  testMidnightNotificationForUser,
};