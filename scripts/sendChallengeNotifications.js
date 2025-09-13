// scripts/sendChallengeNotifications.js
// This script can be run manually or scheduled via cron jobs

const { notifyAllUsersAboutDailyChallenge, notifyAllUsersAboutWeeklyChallenge } = require('../utils/challengeNotifications');

async function main() {
  const args = process.argv.slice(2);
  const type = args[0]; // 'daily' or 'weekly'

  if (!type) {
    console.log('Usage: node scripts/sendChallengeNotifications.js [daily|weekly]');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/sendChallengeNotifications.js daily   # Send daily challenge notifications');
    console.log('  node scripts/sendChallengeNotifications.js weekly  # Send weekly challenge notifications');
    process.exit(1);
  }

  try {
    if (type === 'daily') {
      console.log('🔔 Sending daily challenge notifications...');
      await notifyAllUsersAboutDailyChallenge();
    } else if (type === 'weekly') {
      console.log('🔔 Sending weekly challenge notifications...');
      await notifyAllUsersAboutWeeklyChallenge();
    } else {
      console.error('❌ Invalid type. Use "daily" or "weekly"');
      process.exit(1);
    }
    
    console.log('✅ Challenge notifications completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to send challenge notifications:', error);
    process.exit(1);
  }
}

main();
