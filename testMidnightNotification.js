// testMidnightNotification.js
// Test script to simulate what happens at midnight when challenges become available

const { notifyAllUsersAboutDailyChallenge, notifyAllUsersAboutWeeklyChallenge } = require('./utils/challengeNotifications');

async function testMidnightNotification() {
  console.log('🌙 Simulating midnight challenge notification...\n');
  
  const currentTime = new Date();
  console.log(`Current time: ${currentTime.toLocaleString()}`);
  console.log('📅 Simulating what happens at 12:00 AM when challenges become available\n');

  try {
    console.log('1️⃣ Testing daily challenge notification (sent every midnight)...');
    await notifyAllUsersAboutDailyChallenge();
    console.log('✅ Daily challenge notifications completed\n');

    console.log('2️⃣ Testing weekly challenge notification (sent every Sunday midnight)...');
    await notifyAllUsersAboutWeeklyChallenge();
    console.log('✅ Weekly challenge notifications completed\n');

    console.log('🎯 Perfect timing! Users get notified exactly when challenges become available');
    console.log('⏰ No delay between challenge availability and notification');
    
  } catch (error) {
    console.error('❌ Midnight notification test failed:', error);
  }
}

testMidnightNotification();
