const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function upsert(p) {
  return prisma.storeProduct.upsert({
    where: { productId: p.productId },
    update: p,
    create: p,
  });
}

async function main() {
  await upsert({
    productId: "top_blue_floral_299",
    isActive: true,
    slot: "TOP",
    name: "Blue Floral Shirt",
    brand: "PlayStore",
    imageUrl: "https://yourcdn.com/images/BlueFloralShirt.png",
    priceUsd: "2.99",
    payload: { shirt: "Blue Floral" },
  });

  // ✅ add all playstore productIds like this
  console.log("✅ StoreProduct catalog seeded");
}

main().finally(() => prisma.$disconnect());
