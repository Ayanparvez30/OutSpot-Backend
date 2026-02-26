// utils/minimeLoadout.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Apply a purchased/equipped item to the user's current (latest) Minime.
 * Creates a draft if none exists yet.
 */
exports.applyClothingToCurrentMinime = async (userId, item) => {
  let mm = await prisma.minime.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' }
  });
  if (!mm) {
    // Carry over selfieUrl from any previous MiniMe so face reference is never lost
    const prev = await prisma.minime.findFirst({
      where: { userId, selfieUrl: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { selfieUrl: true },
    });
    mm = await prisma.minime.create({
      data: { userId, selfieUrl: prev?.selfieUrl || null, isSaved: false, isDraft: true }
    });
  }

  const data = {};
  // Map ShopSlot -> Minime field
  switch (item.slot) {
    case 'TOP':
      data.shirt = item.payload?.shirt || item.imageUrl || item.name;
      break;
    case 'BOTTOM':
      data.pant = item.payload?.pant || item.imageUrl || item.name;
      break;
    case 'SHOES':
      data.shoes = item.payload?.shoes || item.imageUrl || item.name;
      break;
    case 'GLASSES':
      data.glasses = item.payload?.glasses || item.imageUrl || item.name;
      break;


case 'ACCESSORY':
  if (item.payload?.bag) {
    data.bag = item.payload.bag;
  } 
  else if (item.payload?.watch) {
   
    data.watch = item.payload.watch;
  } 
  else if (item.payload?.jewelry) {
    data.jewelry = item.payload.jewelry;
  } 
  else {
    data.jewelry = item.imageUrl || item.name;
  }
  break;

  }

  await prisma.minime.update({ where: { id: mm.id }, data });
  return true;
};
