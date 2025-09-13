// scripts/challengeScheduler.js
// Advanced scheduler for challenge notifications with proper timezone handling
// This can be used with cron jobs or task schedulers

const cron = require('node-cron');
const { notifyAllUsersAboutDailyChallenge, notifyAllUsersAboutWeeklyChallenge } = require('../utils/challengeNotifications');

class ChallengeNotificationScheduler {
  constructor() {
    this.isRunning = false;
    this.dailyJob = null;
    this.weeklyJob = null;
  }

  start() {
    if (this.isRunning) {
      console.log('⚠️ Scheduler is already running');
      return;
    }

    console.log('🚀 Starting Challenge Notification Scheduler...');

    // Daily challenge notifications - every day at 12:00 AM (midnight)
    // Sent immediately when new challenges become available
    this.dailyJob = cron.schedule('0 0 * * *', async () => {
      console.log('📅 Daily challenge notification triggered');
      try {
        await notifyAllUsersAboutDailyChallenge();
      } catch (error) {
        console.error('❌ Daily notification job failed:', error);
      }
    }, {
      scheduled: true,
      timezone: process.env.APP_TIMEZONE || 'America/New_York'
    });

    // Weekly challenge notifications - every Sunday at 12:00 AM (midnight)
    // Sent immediately when new weekly challenges become available
    this.weeklyJob = cron.schedule('0 0 * * 0', async () => {
      console.log('📅 Weekly challenge notification triggered');
      try {
        await notifyAllUsersAboutWeeklyChallenge();
      } catch (error) {
        console.error('❌ Weekly notification job failed:', error);
      }
    }, {
      scheduled: true,
      timezone: process.env.APP_TIMEZONE || 'America/New_York'
    });

    this.isRunning = true;
    console.log('✅ Challenge notification scheduler started');
    console.log('   📱 Daily notifications: Every day at 12:00 AM (midnight)');
    console.log('   📱 Weekly notifications: Every Sunday at 12:00 AM (midnight)');
    console.log('   ⏰ Notifications sent immediately when challenges become available');
  }

  stop() {
    if (!this.isRunning) {
      console.log('⚠️ Scheduler is not running');
      return;
    }

    console.log('🛑 Stopping Challenge Notification Scheduler...');

    if (this.dailyJob) {
      this.dailyJob.stop();
      this.dailyJob = null;
    }

    if (this.weeklyJob) {
      this.weeklyJob.stop();
      this.weeklyJob = null;
    }

    this.isRunning = false;
    console.log('✅ Challenge notification scheduler stopped');
  }

  status() {
    console.log('📊 Challenge Notification Scheduler Status:');
    console.log(`   🔄 Running: ${this.isRunning ? 'Yes' : 'No'}`);
    console.log(`   📅 Daily Job: ${this.dailyJob ? 'Active' : 'Inactive'}`);
    console.log(`   📅 Weekly Job: ${this.weeklyJob ? 'Active' : 'Inactive'}`);
    console.log(`   🌍 Timezone: ${process.env.APP_TIMEZONE || 'America/New_York'}`);
  }

  // Manual trigger methods for testing
  async triggerDaily() {
    console.log('🧪 Manually triggering daily challenge notifications...');
    try {
      await notifyAllUsersAboutDailyChallenge();
      console.log('✅ Manual daily notification completed');
    } catch (error) {
      console.error('❌ Manual daily notification failed:', error);
    }
  }

  async triggerWeekly() {
    console.log('🧪 Manually triggering weekly challenge notifications...');
    try {
      await notifyAllUsersAboutWeeklyChallenge();
      console.log('✅ Manual weekly notification completed');
    } catch (error) {
      console.error('❌ Manual weekly notification failed:', error);
    }
  }
}

// If this file is run directly (not imported)
if (require.main === module) {
  const scheduler = new ChallengeNotificationScheduler();
  
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'start':
      scheduler.start();
      // Keep process alive
      process.on('SIGINT', () => {
        console.log('\n🛑 Received SIGINT, stopping scheduler...');
        scheduler.stop();
        process.exit(0);
      });
      break;

    case 'test-daily':
      scheduler.triggerDaily().then(() => process.exit(0));
      break;

    case 'test-weekly':
      scheduler.triggerWeekly().then(() => process.exit(0));
      break;

    case 'status':
      scheduler.status();
      process.exit(0);
      break;

    default:
      console.log('Usage: node scripts/challengeScheduler.js [command]');
      console.log('');
      console.log('Commands:');
      console.log('  start       Start the scheduler (runs continuously)');
      console.log('  test-daily  Manually trigger daily notifications');
      console.log('  test-weekly Manually trigger weekly notifications');
      console.log('  status      Show scheduler status');
      console.log('');
      console.log('Examples:');
      console.log('  node scripts/challengeScheduler.js start');
      console.log('  node scripts/challengeScheduler.js test-daily');
      process.exit(1);
  }
}

module.exports = ChallengeNotificationScheduler;
