const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearDatabase() {
  try {
    console.log('🧹 Clearing database...');

    // Delete from relation tables first (to avoid foreign key constraint errors)
    await prisma.message.deleteMany();
    await prisma.userOnChat.deleteMany();
    await prisma.chat.deleteMany();
    await prisma.friendship.deleteMany();
    await prisma.block.deleteMany();
    await prisma.minime.deleteMany();
    await prisma.user.deleteMany();

    console.log('✅ Database cleared successfully.');
  } catch (error) {
    console.error('❌ Error while clearing database:', error);
  } finally {
    await prisma.$disconnect();
  }
  const remainingUsers = await prisma.user.count();
console.log(`👤 Remaining users in DB: ${remainingUsers}`);
}

clearDatabase();


