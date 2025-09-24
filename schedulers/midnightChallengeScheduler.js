// schedulers/midnightChallengeScheduler.js
// Production scheduler for midnight challenge notifications

const cron = require('node-cron');
const { notifyUsersAboutMidnightChallenges } = require('../utils/midnightChallengeNotifier');

/**
 * Production scheduler for midnight challenge notifications
 * This runs at midnight in different timezones to notify users about new challenges
 */
class MidnightChallengeScheduler {
  constructor() {
    this.scheduledJobs = new Map();
    this.isRunning = false;
  }

  /**
   * Start the scheduler with timezone-specific cron jobs
   */
  start() {
    if (this.isRunning) {
      console.log('⚠️  Midnight challenge scheduler is already running');
      return;
    }

    console.log('🌙 Starting midnight challenge notification scheduler...');

    // Define timezone schedules (midnight in each timezone)
    const timezoneSchedules = [
      {
        name: 'US Eastern Time',
        timezone: 'America/New_York',
        cron: '0 0 5 * * *', // 5 AM UTC = Midnight ET (UTC-5)
        description: 'Midnight ET (UTC-5)'
      },
      {
        name: 'US Central Time',
        timezone: 'America/Chicago',
        cron: '0 0 6 * * *', // 6 AM UTC = Midnight CT (UTC-6)
        description: 'Midnight CT (UTC-6)'
      },
      {
        name: 'US Mountain Time',
        timezone: 'America/Denver',
        cron: '0 0 7 * * *', // 7 AM UTC = Midnight MT (UTC-7)
        description: 'Midnight MT (UTC-7)'
      },
      {
        name: 'US Pacific Time',
        timezone: 'America/Los_Angeles',
        cron: '0 0 8 * * *', // 8 AM UTC = Midnight PT (UTC-8)
        description: 'Midnight PT (UTC-8)'
      },
      {
        name: 'UTC',
        timezone: 'UTC',
        cron: '0 0 0 * * *', // Midnight UTC
        description: 'Midnight UTC'
      }
    ];

    // Schedule each timezone
    timezoneSchedules.forEach(schedule => {
      const task = cron.schedule(schedule.cron, async () => {
        console.log(`\n🌙 [${new Date().toISOString()}] Running midnight notifications for ${schedule.name}`);
        
        try {
          const result = await notifyUsersAboutMidnightChallenges(schedule.timezone);
          
          if (result.success) {
            console.log(`✅ ${schedule.name} notifications completed:`);
            console.log(`   • Users processed: ${result.usersProcessed}`);
            console.log(`   • Daily notifications: ${result.dailyNotifications}`);
            console.log(`   • Weekly notifications: ${result.weeklyNotifications}`);
            console.log(`   • Total notifications: ${result.totalNotifications}`);
          } else {
            console.error(`❌ ${schedule.name} notifications failed:`, result.error);
          }
        } catch (error) {
          console.error(`❌ Error in ${schedule.name} midnight notifications:`, error);
        }
      }, {
        scheduled: false, // Don't start immediately
        timezone: 'UTC' // Run the cron job in UTC
      });

      this.scheduledJobs.set(schedule.timezone, {
        task,
        schedule,
        isActive: false
      });

      console.log(`📅 Scheduled ${schedule.name}: ${schedule.cron} (${schedule.description})`);
    });

    // Start all scheduled jobs
    this.scheduledJobs.forEach((job, timezone) => {
      job.task.start();
      job.isActive = true;
      console.log(`🟢 Started scheduler for ${timezone}`);
    });

    this.isRunning = true;
    console.log(`🎯 Midnight challenge scheduler started with ${this.scheduledJobs.size} timezone schedules\n`);

    // Log next execution times
    this.logNextExecutions();
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (!this.isRunning) {
      console.log('⚠️  Midnight challenge scheduler is not running');
      return;
    }

    console.log('🛑 Stopping midnight challenge scheduler...');

    this.scheduledJobs.forEach((job, timezone) => {
      if (job.isActive) {
        job.task.stop();
        job.isActive = false;
        console.log(`🔴 Stopped scheduler for ${timezone}`);
      }
    });

    this.isRunning = false;
    console.log('✅ Midnight challenge scheduler stopped');
  }

  /**
   * Get the status of all scheduled jobs
   */
  getStatus() {
    const status = {
      isRunning: this.isRunning,
      totalJobs: this.scheduledJobs.size,
      activeJobs: 0,
      schedules: []
    };

    this.scheduledJobs.forEach((job, timezone) => {
      if (job.isActive) status.activeJobs++;
      
      status.schedules.push({
        timezone,
        name: job.schedule.name,
        cron: job.schedule.cron,
        description: job.schedule.description,
        isActive: job.isActive
      });
    });

    return status;
  }

  /**
   * Log when the next executions will happen
   */
  logNextExecutions() {
    console.log('⏰ Next scheduled executions:');
    
    this.scheduledJobs.forEach((job, timezone) => {
      if (job.isActive && job.task.getTasks) {
        // Note: node-cron doesn't provide a direct way to get next execution time
        // This is a simplified display
        console.log(`   • ${job.schedule.name}: ${job.schedule.cron} (${job.schedule.description})`);
      }
    });
    console.log('');
  }

  /**
   * Manually trigger notifications for a specific timezone (for testing)
   */
  async triggerForTimezone(timezone) {
    console.log(`🧪 Manually triggering notifications for timezone: ${timezone}`);
    
    try {
      const result = await notifyUsersAboutMidnightChallenges(timezone);
      
      if (result.success) {
        console.log(`✅ Manual trigger completed for ${timezone}:`);
        console.log(`   • Users processed: ${result.usersProcessed}`);
        console.log(`   • Daily notifications: ${result.dailyNotifications}`);
        console.log(`   • Weekly notifications: ${result.weeklyNotifications}`);
        console.log(`   • Total notifications: ${result.totalNotifications}`);
      } else {
        console.error(`❌ Manual trigger failed for ${timezone}:`, result.error);
      }
      
      return result;
    } catch (error) {
      console.error(`❌ Error in manual trigger for ${timezone}:`, error);
      return { success: false, error: error.message };
    }
  }
}

// Export singleton instance
const midnightChallengeScheduler = new MidnightChallengeScheduler();

module.exports = {
  MidnightChallengeScheduler,
  midnightChallengeScheduler
};

// If running this file directly, start the scheduler
if (require.main === module) {
  console.log('🚀 Starting midnight challenge scheduler from command line...\n');
  
  midnightChallengeScheduler.start();
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    midnightChallengeScheduler.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    midnightChallengeScheduler.stop();
    process.exit(0);
  });
}