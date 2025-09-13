// scripts/setupTestData.js
// Script to set up test data for challenge notifications

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function setupTestData() {
  console.log('🛠️ Setting up test data for challenge notifications...\n');

  try {
    // 1. Create a test user if none exists
    console.log('1️⃣ Checking for existing users...');
    let testUser = await prisma.user.findFirst();
    
    if (!testUser) {
      console.log('   Creating test user...');
      testUser = await prisma.user.create({
        data: {
          username: 'testuser',
          email: 'test@example.com',
          password: 'hashedpassword123',
          fcmToken: 'test_fcm_token_12345',
          isVerified: true
        }
      });
      console.log(`✅ Created test user: ${testUser.username} (ID: ${testUser.id})`);
    } else {
      console.log(`✅ Found existing user: ${testUser.username} (ID: ${testUser.id})`);
      
      // Add FCM token if not present
      if (!testUser.fcmToken) {
        console.log('   Adding FCM token to existing user...');
        testUser = await prisma.user.update({
          where: { id: testUser.id },
          data: { fcmToken: 'test_fcm_token_12345' }
        });
        console.log('✅ FCM token added');
      } else {
        console.log('✅ User already has FCM token');
      }
    }

    // 2. Create test challenges if none exist
    console.log('\n2️⃣ Checking for challenges...');
    
    const dailyChallenges = await prisma.challenge.findMany({
      where: { frequency: 'DAILY' }
    });
    
    const weeklyChallenges = await prisma.challenge.findMany({
      where: { frequency: 'WEEKLY' }
    });

    if (dailyChallenges.length === 0) {
      console.log('   Creating daily challenges...');
      const dailyChallenge = await prisma.challenge.create({
        data: {
          title: 'Daily Step Challenge',
          description: 'Take 10,000 steps today and share a photo of your activity!',
          frequency: 'DAILY',
          tier: 'SILVER',
          points: 10,
          requiredPhotos: 1
        }
      });
      console.log(`✅ Created daily challenge: ${dailyChallenge.title}`);
    } else {
      console.log(`✅ Found ${dailyChallenges.length} daily challenge(s)`);
    }

    if (weeklyChallenges.length === 0) {
      console.log('   Creating weekly challenges...');
      const weeklyChallenge = await prisma.challenge.create({
        data: {
          title: 'Weekly Fitness Journey',
          description: 'Complete 5 workout sessions this week and document your progress!',
          frequency: 'WEEKLY',
          tier: 'GOLD',
          points: 50,
          requiredPhotos: 5
        }
      });
      console.log(`✅ Created weekly challenge: ${weeklyChallenge.title}`);
    } else {
      console.log(`✅ Found ${weeklyChallenges.length} weekly challenge(s)`);
    }

    console.log('\n✅ Test data setup completed successfully!');
    console.log('\n📋 Summary:');
    console.log(`   👤 User: ${testUser.username} (ID: ${testUser.id})`);
    console.log(`   📱 FCM Token: ${testUser.fcmToken ? 'Set' : 'Not set'}`);
    console.log(`   📅 Daily challenges: ${dailyChallenges.length > 0 ? dailyChallenges.length : 1}`);
    console.log(`   📅 Weekly challenges: ${weeklyChallenges.length > 0 ? weeklyChallenges.length : 1}`);

    console.log('\n🧪 Now you can run the test:');
    console.log('   node testChallengeNotifications.js');

  } catch (error) {
    console.error('❌ Failed to setup test data:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// If this file is run directly
if (require.main === module) {
  setupTestData();
}

module.exports = { setupTestData };
