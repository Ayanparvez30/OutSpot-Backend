const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Apply a purchased/equipped item to the user's current (latest) Minime.
 * Creates a draft if none exists yet.
 */
exports.applyClothingToCurrentMinime = async (userId, item) => {
  let mm = await prisma.minime.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  if (!mm) {
    mm = await prisma.minime.create({ data: { userId, isSaved: false, isDraft: true } });
  }

  const data = {};
  // Map ShopSlot -> Minime field
  switch (item.slot) {
    case 'TOP':
      data.shirt = item.payload?.shirt || item.name;
      break;
    case 'BOTTOM':
      data.pant = item.payload?.pant || item.name;
      break;
    case 'SHOES':
      data.shoes = item.payload?.shoes || item.name;
      break;
    case 'GLASSES':
      data.glasses = item.payload?.glasses || item.name;
      break;
  
case 'ACCESSORY': {
  if (item.payload?.bag)       data.bag = item.payload.bag;
  else if (item.payload?.watch) data.jewelry = item.payload.watch; // show as wrist jewelry
  else if (item.payload?.jewelry) data.jewelry = item.payload.jewelry;
  break;
}

  }

  await prisma.minime.update({ where: { id: mm.id }, data });
  return true;
};
