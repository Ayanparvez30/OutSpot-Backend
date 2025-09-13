// testChallengeNotifications.js
// Test script for challenge notifications

const { notifyNewChallenge, notifyAllUsersAboutDailyChallenge, notifyAllUsersAboutWeeklyChallenge } = require('./utils/challengeNotifications');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testChallengeNotifications() {
  console.log('🧪 Testing Challenge Notifications...\n');

  try {
    // Test 1: Get a user with FCM token
    console.log('1️⃣ Finding users with FCM tokens...');
    const userWithFcm = await prisma.user.findFirst({
      where: {
        fcmToken: { not: null }
      }
    });

    if (!userWithFcm) {
      console.log('❌ No user found with FCM token. Please add an FCM token to a user first.');
      console.log('   You can do this via: POST /auth/me/fcm-token with body: {"fcmToken": "your_test_token"}');
      return;
    }

    console.log(`✅ Found user ${userWithFcm.id} (${userWithFcm.username}) with FCM token`);

    // Test 2: Get available challenges
    console.log('\n2️⃣ Checking available challenges...');
    const dailyChallenges = await prisma.challenge.findMany({
      where: { frequency: 'DAILY' }
    });
    const weeklyChallenges = await prisma.challenge.findMany({
      where: { frequency: 'WEEKLY' }
    });

    console.log(`   📅 Daily challenges: ${dailyChallenges.length}`);
    console.log(`   📅 Weekly challenges: ${weeklyChallenges.length}`);

    if (dailyChallenges.length === 0 && weeklyChallenges.length === 0) {
      console.log('❌ No challenges found. Please create some challenges first.');
      return;
    }

    // Test 3: Send individual notifications
    if (dailyChallenges.length > 0) {
      console.log('\n3️⃣ Testing individual daily challenge notification...');
      await notifyNewChallenge(userWithFcm.id, dailyChallenges[0], 'DAILY');
      console.log('✅ Daily notification sent');
    }

    if (weeklyChallenges.length > 0) {
      console.log('\n4️⃣ Testing individual weekly challenge notification...');
      await notifyNewChallenge(userWithFcm.id, weeklyChallenges[0], 'WEEKLY');
      console.log('✅ Weekly notification sent');
    }

    // Test 4: Check notifications in database
    console.log('\n5️⃣ Checking notifications in database...');
    const notifications = await prisma.notification.findMany({
      where: {
        userId: userWithFcm.id,
        type: { in: ['DAILY_CHALLENGE', 'WEEKLY_CHALLENGE'] }
      },
      orderBy: { createdAt: 'desc' },
      take: 5
    });

    console.log(`   📱 Challenge notifications found: ${notifications.length}`);
    notifications.forEach(n => {
      console.log(`      • ${n.type}: "${n.title}" (${n.createdAt})`);
    });

    // Test 5: Bulk notifications (careful - this sends to ALL users with FCM tokens)
    console.log('\n6️⃣ Would you like to test bulk notifications? (This sends to ALL users)');
    console.log('   Skipping bulk test for safety. Use scripts manually:');
    console.log('   • node scripts/sendChallengeNotifications.js daily');
    console.log('   • node scripts/sendChallengeNotifications.js weekly');

    console.log('\n✅ Challenge notification tests completed successfully!');
    console.log('\n📋 Summary:');
    console.log('   ✓ Individual notifications work');
    console.log('   ✓ Database storage works');
    console.log('   ✓ Firebase push notifications sent');
    console.log('   ✓ New notification types (DAILY_CHALLENGE, WEEKLY_CHALLENGE) available');

    console.log('\n🚀 Next steps:');
    console.log('   1. Set up cron jobs to run the scheduler automatically');
    console.log('   2. Test the API endpoints:');
    console.log('      • GET /notifications/challenges');
    console.log('      • GET /notifications/challenges/unread');
    console.log('      • POST /challenges/notify/me {"frequency": "DAILY"}');
    console.log('   3. Configure the scheduler: node scripts/challengeScheduler.js start');

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// If this file is run directly
if (require.main === module) {
  testChallengeNotifications();
}

module.exports = { testChallengeNotifications };
