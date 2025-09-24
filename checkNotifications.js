// checkNotifications.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkNotifications() {
  try {
    const notifications = await prisma.notification.findMany({
      where: {
        type: { in: ['DAILY_CHALLENGE', 'WEEKLY_CHALLENGE'] }
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        user: {
          select: { username: true }
        }
      }
    });

    console.log('🔍 Recent Challenge Notifications:');
    console.log('=' .repeat(50));
    
    if (notifications.length === 0) {
      console.log('No challenge notifications found.');
    } else {
      notifications.forEach((notif, index) => {
        console.log(`${index + 1}. ${notif.type} for ${notif.user.username}`);
        console.log(`   Title: ${notif.title}`);
        console.log(`   Description: ${notif.description}`);
        console.log(`   Created: ${notif.createdAt.toLocaleString()}`);
        console.log(`   Read: ${notif.isRead ? 'Yes' : 'No'}`);
        console.log('');
      });
    }
    
    console.log(`✅ Total challenge notifications found: ${notifications.length}`);
    
  } catch (error) {
    console.error('❌ Error checking notifications:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkNotifications();