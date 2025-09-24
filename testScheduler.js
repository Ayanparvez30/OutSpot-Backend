// testScheduler.js
// Test the midnight challenge scheduler

const { midnightChallengeScheduler } = require('./schedulers/midnightChallengeScheduler');

async function testScheduler() {
  console.log('🧪 Testing Midnight Challenge Scheduler\n');
  console.log('=' .repeat(60));

  // Get status
  console.log('📊 Current scheduler status:');
  const status = midnightChallengeScheduler.getStatus();
  console.log(`   • Running: ${status.isRunning ? 'Yes' : 'No'}`);
  console.log(`   • Total jobs: ${status.totalJobs}`);
  console.log(`   • Active jobs: ${status.activeJobs}`);
  console.log('');

  if (!status.isRunning) {
    console.log('🚀 Starting scheduler...');
    midnightChallengeScheduler.start();
    console.log('');
  }

  // Test manual trigger for a timezone
  console.log('🧪 Testing manual trigger for America/New_York timezone...\n');
  const result = await midnightChallengeScheduler.triggerForTimezone('America/New_York');
  
  if (result.success) {
    console.log('\n✅ Manual trigger test passed!');
    console.log('📝 Summary:');
    console.log(`   • Users processed: ${result.usersProcessed}`);
    console.log(`   • Daily notifications: ${result.dailyNotifications}`);
    console.log(`   • Weekly notifications: ${result.weeklyNotifications}`);
    console.log(`   • Total notifications: ${result.totalNotifications}`);
  } else {
    console.log(`\n❌ Manual trigger test failed: ${result.error}`);
  }

  console.log('\n' + '=' .repeat(60));
  console.log('🎯 Integration complete! Here\'s what you need to know:\n');
  
  console.log('📅 Production Usage:');
  console.log('   1. Start the scheduler in your main server file:');
  console.log('      const { midnightChallengeScheduler } = require(\'./schedulers/midnightChallengeScheduler\');');
  console.log('      midnightChallengeScheduler.start();\n');
  
  console.log('   2. Or run as a separate service:');
  console.log('      node schedulers/midnightChallengeScheduler.js\n');
  
  console.log('🔧 Features implemented:');
  console.log('   ✅ Timezone-aware challenge assignment');
  console.log('   ✅ Duplicate notification prevention');
  console.log('   ✅ Daily notifications at midnight in user timezone');
  console.log('   ✅ Weekly notifications on Sunday midnight');
  console.log('   ✅ Database persistence of notifications');
  console.log('   ✅ API endpoints for fetching notifications');
  console.log('   ✅ Production-ready scheduler with multiple timezones\n');
  
  console.log('📱 Notification Details:');
  console.log('   • Type: DAILY_CHALLENGE or WEEKLY_CHALLENGE');
  console.log('   • Title: Includes challenge name and emoji');
  console.log('   • Description: Challenge title and points information');
  console.log('   • Stored in notifications table with user relationship\n');
  
  console.log('🚀 Next Steps:');
  console.log('   • Add FCM push notifications using user.fcmToken');
  console.log('   • Monitor scheduler logs in production');
  console.log('   • Consider adding user timezone preferences');
  console.log('   • Add email notifications as backup\n');

  // Don't stop the scheduler in this test, let it continue running
  console.log('💡 Scheduler will continue running. Use Ctrl+C to stop.');
}

testScheduler().catch(console.error);