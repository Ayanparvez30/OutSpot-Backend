const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

async function main() {
  const username = process.argv[2] || 'admin';
  const email = process.argv[3] || 'admin@outspot.app';
  const password = process.argv[4] || 'Admin@outspot123';

  const hash = await bcrypt.hash(password, 12);

  const admin = await prisma.adminUser.upsert({
    where: { username },
    update: { password: hash },
    create: {
      username,
      email,
      password: hash,
      role: 'superadmin',
      isActive: true,
    },
  });

  console.log(`Admin user created/updated: ${admin.username} (${admin.email})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
