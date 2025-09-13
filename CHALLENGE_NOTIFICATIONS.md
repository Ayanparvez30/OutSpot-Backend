# Challenge Notifications System

This implementation adds automatic push notifications for daily and weekly challenges using Firebase FCM tokens.

## Features

- 🔔 **Automatic Notifications**: Users receive push notifications when new challenges become available
- 📱 **Firebase Integration**: Uses existing FCM token system for push notifications
- ⏰ **Timezone Support**: Respects user timezones for proper challenge timing
- 🗄️ **Database Storage**: All notifications are saved in the database
- 🔄 **Scheduled Delivery**: Automated scheduling with cron jobs
- 🧪 **Testing Support**: Manual trigger endpoints for testing

## New Notification Types

- `DAILY_CHALLENGE`: Sent when a new daily challenge becomes available
- `WEEKLY_CHALLENGE`: Sent when a new weekly challenge becomes available

## API Endpoints

### Get Challenge Notifications
```
GET /notifications/challenges
GET /notifications/challenges/unread
```

### Manual Testing (Admin/Testing)
```
POST /challenges/notify/all
Body: { "type": "daily" | "weekly" }

POST /challenges/notify/me
Body: { "frequency": "DAILY" | "WEEKLY" }
```

## Scheduling

### Automatic Scheduler
```bash
# Start the automatic scheduler (runs continuously)
node scripts/challengeScheduler.js start

# Test manual triggers
node scripts/challengeScheduler.js test-daily
node scripts/challengeScheduler.js test-weekly
```

### Manual Scripts
```bash
# Send notifications to all users
node scripts/sendChallengeNotifications.js daily
node scripts/sendChallengeNotifications.js weekly
```

### Cron Schedule
- **Daily challenges**: Every day at 12:00 AM (midnight) - immediately when challenges become available
- **Weekly challenges**: Every Sunday at 12:00 AM (midnight) - immediately when new week starts

## How It Works

1. **Challenge Assignment**: When a user requests challenge cards, they get assigned challenges based on seeded randomization
2. **Notification Check**: Before sending notifications, the system checks if the user has already been notified for the current window
3. **FCM Delivery**: Notifications are sent to users who have FCM tokens registered
4. **Database Storage**: All notifications are stored in the `Notification` table with proper metadata

## Testing

Run the test script to verify everything works:
```bash
node testChallengeNotifications.js
```

This will:
- Find users with FCM tokens
- Send test notifications
- Verify database storage
- Check Firebase delivery

## Configuration

### Environment Variables
- `APP_TIMEZONE`: Default timezone for scheduling (default: 'America/New_York')
- Firebase configuration variables (existing)

### Database Migration
The system adds new notification types to the existing enum:
```sql
-- New notification types added:
DAILY_CHALLENGE
WEEKLY_CHALLENGE
```

## Integration Points

### Challenge Controller
- Uses `notifyNewChallenge()` helper function
- Integrates with existing challenge assignment logic

### Notification Controller
- Handles filtering for challenge notification types
- Provides specific endpoints for challenge notifications

### Utilities
- `challengeNotifications.js`: Core notification logic
- `challengeScheduler.js`: Automated scheduling system
- Integration with existing `notificationService.js`

## Production Setup

1. **Deploy the updated code** with new notification types
2. **Run database migration** to add new enum values
3. **Set up cron jobs** or use the built-in scheduler:
   ```bash
   # Option 1: Use built-in scheduler
   pm2 start "node scripts/challengeScheduler.js start" --name challenge-scheduler
   
   # Option 2: System cron jobs
   # Add to crontab:
   0 0 * * * cd /path/to/project && node scripts/sendChallengeNotifications.js daily
   0 0 * * 0 cd /path/to/project && node scripts/sendChallengeNotifications.js weekly
   ```
4. **Monitor logs** for notification delivery status

## Error Handling

- Graceful handling of users without FCM tokens
- Prevents duplicate notifications within the same time window
- Comprehensive error logging and fallback behavior
- Individual user failures don't stop batch operations

## Future Enhancements

- [ ] Notification preferences per user
- [ ] Different notification times based on user preferences
- [ ] Rich push notification content with images
- [ ] Analytics and delivery tracking
- [ ] A/B testing for notification content
