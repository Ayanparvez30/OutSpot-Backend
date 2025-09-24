// testMidnightChallengeNotifications.js
// Test script to simulate midnight challenge notifications

const { testMidnightNotificationForUser, notifyUsersAboutMidnightChallenges } = require('./utils/midnightChallengeNotifier');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testMidnightChallengeNotifications() {
  console.log('🌙 Testing Midnight Challenge Notifications\n');
  console.log('=' .repeat(60));
  
  try {
    // Get a test user
    const testUser = await prisma.user.findFirst({
      select: { id: true, username: true },
    });

    if (!testUser) {
      console.log('❌ No users found in database. Please create a user first.');
      return;
    }

    console.log(`🧪 Test 1: Single User Notification Test`);
    console.log(`   Using user: ${testUser.username} (ID: ${testUser.id})\n`);

    // Test individual user notification
    const singleUserResult = await testMidnightNotificationForUser(testUser.id, 'America/New_York');
    
    if (singleUserResult.success) {
      console.log(`✅ Single user test successful!`);
      console.log(`   Timezone: ${singleUserResult.timezone}`);
      console.log(`   Notifications created: ${singleUserResult.notifications.length}`);
      
      singleUserResult.notifications.forEach((notif, index) => {
        console.log(`   ${index + 1}. ${notif.type.toUpperCase()}: ${notif.challenge.title}`);
        console.log(`      Points: ${notif.challenge.points} | Notification ID: ${notif.notification.id}`);
      });
    } else {
      console.log(`❌ Single user test failed: ${singleUserResult.error}`);
    }

    console.log('\n' + '=' .repeat(60));
    console.log(`🧪 Test 2: All Users Notification Test\n`);

    // Test all users notification
    const allUsersResult = await notifyUsersAboutMidnightChallenges('America/New_York');
    
    if (allUsersResult.success) {
      console.log(`✅ All users test successful!`);
      console.log(`   Users processed: ${allUsersResult.usersProcessed}`);
      console.log(`   Daily notifications: ${allUsersResult.dailyNotifications}`);
      console.log(`   Weekly notifications: ${allUsersResult.weeklyNotifications}`);
      console.log(`   Total notifications: ${allUsersResult.totalNotifications}`);
    } else {
      console.log(`❌ All users test failed: ${allUsersResult.error}`);
    }

    console.log('\n' + '=' .repeat(60));
    console.log(`📊 Verification: Check Database\n`);

    // Verify notifications were created
    const recentNotifications = await prisma.notification.findMany({
      where: {
        type: { in: ['DAILY_CHALLENGE', 'WEEKLY_CHALLENGE'] },
        createdAt: {
          gte: new Date(Date.now() - 5 * 60 * 1000), // Last 5 minutes
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        user: {
          select: { username: true },
        },
      },
    });

    console.log(`📋 Recent challenge notifications (last 5 minutes):`);
    if (recentNotifications.length === 0) {
      console.log('   No recent notifications found.');
    } else {
      recentNotifications.forEach((notif, index) => {
        console.log(`   ${index + 1}. ${notif.type} for ${notif.user.username}`);
        console.log(`      Title: ${notif.title}`);
        console.log(`      Description: ${notif.description}`);
        console.log(`      Created: ${notif.createdAt.toLocaleString()}`);
        console.log(`      Read: ${notif.isRead ? 'Yes' : 'No'}`);
        console.log('');
      });
    }

    console.log('🎯 Midnight challenge notification test completed!');
    console.log('\n💡 Integration Notes:');
    console.log('   • In production, schedule notifyUsersAboutMidnightChallenges() to run at midnight');
    console.log('   • Use node-cron or similar to handle timezone-specific scheduling');
    console.log('   • Consider batching users by timezone for optimal performance');
    console.log('   • Add FCM push notifications using the stored fcmToken');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Add some helper functions for production scheduling
function createCronExpressions() {
  console.log('\n📅 Sample Cron Expressions for Production:');
  console.log('   Midnight ET (UTC-5):  "0 0 5 * * *"   // 5 AM UTC');
  console.log('   Midnight PT (UTC-8):  "0 0 8 * * *"   // 8 AM UTC');
  console.log('   Midnight UTC:         "0 0 0 * * *"   // 12 AM UTC');
  console.log('\n📝 Example Node-Cron Implementation:');
  console.log(`
const cron = require('node-cron');
const { notifyUsersAboutMidnightChallenges } = require('./utils/midnightChallengeNotifier');

// Run at midnight ET (5 AM UTC)
cron.schedule('0 0 5 * * *', () => {
  notifyUsersAboutMidnightChallenges('America/New_York');
});

// Run at midnight PT (8 AM UTC)  
cron.schedule('0 0 8 * * *', () => {
  notifyUsersAboutMidnightChallenges('America/Los_Angeles');
});
  `);
}

// Run the test
testMidnightChallengeNotifications().then(() => {
  createCronExpressions();
});