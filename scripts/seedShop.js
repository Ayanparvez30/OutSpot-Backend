// scripts/seedShop.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ---- Hard-coded CDN base (no .env needed)
const CDN_BASE = 'https://cdn.outspot.app/shop';
const img = (p) => `${CDN_BASE}/${p}`;

// find by (slot,name) then update/create — safe for non-unique 'name'
async function upsertItem(it) {
  const existing = await prisma.shopItem.findFirst({
    where: { slot: it.slot, name: it.name }
  });
  if (existing) {
    return prisma.shopItem.update({ where: { id: existing.id }, data: it });
  }
  return prisma.shopItem.create({ data: it });
}

async function main() {
  // ---------- TOPS ----------
  const tops = [
    // Summer Looks
    { slot: 'TOP', brand: 'Summer Looks', name: 'Blue Hawaiian Shirt',  imageUrl: img('tops/blue-hawaiian.png'),  priceUsd: '3.00', payload: { shirt: 'Blue Hawaiian' },  isFeatured: true },
    { slot: 'TOP', brand: 'Summer Looks', name: 'Red Hawaiian Shirt',   imageUrl: img('tops/red-hawaiian.png'),   priceUsd: '3.00', payload: { shirt: 'Red Hawaiian'  },  isFeatured: true },
    { slot: 'TOP', brand: 'Summer Looks', name: 'Green Hawaiian Shirt', imageUrl: img('tops/green-hawaiian.png'), priceUsd: '3.00', payload: { shirt: 'Green Hawaiian'}, isFeatured: true },
    { slot: 'TOP', brand: 'Summer Looks', name: 'Plaid Short Sleeve',   imageUrl: img('tops/plaid-short.png'),    priceUsd: '3.00', payload: { shirt: 'Plaid Short Sleeve' } },
    { slot: 'TOP', brand: 'Summer Looks', name: 'Anchor Tee',           imageUrl: img('tops/anchor-tee.png'),     priceUsd: '3.00', payload: { shirt: 'Anchor Tee' } },
    { slot: 'TOP', brand: 'Summer Looks', name: 'Octopus Tee',          imageUrl: img('tops/octopus-tee.png'),    priceUsd: '5.00', payload: { shirt: 'Octopus Tee' } },

    // Sports Fashion
    { slot: 'TOP', brand: 'Sports Fashion', name: 'Blue/Orange Jersey', imageUrl: img('tops/jersey-blue-orange.png'), priceUsd: '3.00', payload: { shirt: 'Blue/Orange Jersey' } },
    { slot: 'TOP', brand: 'Sports Fashion', name: 'Yellow Jersey',      imageUrl: img('tops/jersey-yellow.png'),       priceUsd: '3.00', payload: { shirt: 'Yellow Jersey' } },
    { slot: 'TOP', brand: 'Sports Fashion', name: 'Red Jersey',         imageUrl: img('tops/jersey-red.png'),          priceUsd: '3.00', payload: { shirt: 'Red Jersey' } },
    { slot: 'TOP', brand: 'Sports Fashion', name: 'Red Tank',           imageUrl: img('tops/tank-red.png'),            priceUsd: '3.00', payload: { shirt: 'Red Tank' } },
    { slot: 'TOP', brand: 'Sports Fashion', name: 'Grey Hoodie',        imageUrl: img('tops/hoodie-grey.png'),         priceUsd: '3.00', payload: { shirt: 'Grey Hoodie' } },
    { slot: 'TOP', brand: 'Sports Fashion', name: 'Navy Hoodie',        imageUrl: img('tops/hoodie-navy.png'),         priceUsd: '3.00', payload: { shirt: 'Navy Hoodie' } },
    { slot: 'TOP', brand: 'Sports Fashion', name: 'Referee Stripes',    imageUrl: img('tops/referee-stripes.png'),     priceUsd: '3.00', payload: { shirt: 'Referee Stripes' } },

    // Luxury Styles
    { slot: 'TOP', brand: 'Luxury Styles', name: 'Gold Tee',            imageUrl: img('tops/gold-tee.png'),             priceUsd: '5.00', payload: { shirt: 'Gold Tee' }, isFeatured: true },
    { slot: 'TOP', brand: 'Luxury Styles', name: 'Black/Gold Tee',      imageUrl: img('tops/black-gold-tee.png'),       priceUsd: '5.00', payload: { shirt: 'Black/Gold Tee' } },
    { slot: 'TOP', brand: 'Luxury Styles', name: 'Blue Pattern Shirt',  imageUrl: img('tops/blue-pattern-shirt.png'),   priceUsd: '3.00', payload: { shirt: 'Blue Pattern Shirt' } },
    { slot: 'TOP', brand: 'Luxury Styles', name: 'White Dress Shirt',   imageUrl: img('tops/white-dress-shirt.png'),    priceUsd: '5.00', payload: { shirt: 'White Dress Shirt' } },
    { slot: 'TOP', brand: 'Luxury Styles', name: 'Black Vest Shirt',    imageUrl: img('tops/black-vest-shirt.png'),     priceUsd: '5.00', payload: { shirt: 'Black Vest Shirt' } },

    // Classics
    { slot: 'TOP', brand: 'Classics', name: 'Grey Graphic Tee',     imageUrl: img('tops/grey-graphic.png'),        priceUsd: '3.00', payload: { shirt: 'Grey Graphic Tee' } },
    { slot: 'TOP', brand: 'Classics', name: 'Oversize Grey Tee',    imageUrl: img('tops/oversize-grey.png'),       priceUsd: '3.00', payload: { shirt: 'Oversize Grey Tee' } },
    { slot: 'TOP', brand: 'Classics', name: 'Red Xmas Sweater',     imageUrl: img('tops/red-xmas-sweater.png'),    priceUsd: '3.00', payload: { shirt: 'Red Xmas Sweater' } },
    { slot: 'TOP', brand: 'Classics', name: 'Black Graphic Tee',    imageUrl: img('tops/black-graphic.png'),       priceUsd: '3.00', payload: { shirt: 'Black Graphic Tee' } },
    { slot: 'TOP', brand: 'Classics', name: 'Grey Raglan',          imageUrl: img('tops/grey-raglan.png'),         priceUsd: '3.00', payload: { shirt: 'Grey Raglan' } },
    { slot: 'TOP', brand: 'Classics', name: 'Beige Tee',            imageUrl: img('tops/beige-tee.png'),           priceUsd: '3.00', payload: { shirt: 'Beige Tee' } },
    { slot: 'TOP', brand: 'Classics', name: 'Camo Tee',             imageUrl: img('tops/camo-tee.png'),            priceUsd: '3.00', payload: { shirt: 'Camo Tee' } },
    { slot: 'TOP', brand: 'Classics', name: 'Vintage White/Blue',   imageUrl: img('tops/vintage-white-blue.png'),  priceUsd: '3.00', payload: { shirt: 'Vintage White/Blue' } },
    { slot: 'TOP', brand: 'Classics', name: 'Photo Tee',            imageUrl: img('tops/photo-tee.png'),           priceUsd: '3.00', payload: { shirt: 'Photo Tee' } },
  ];

  // ---------- BOTTOMS ----------
  const bottoms = [
    // Summer Looks (shorts)
    { slot: 'BOTTOM', brand: 'Summer Looks', name: 'Rainbow Shorts',     imageUrl: img('bottoms/rainbow-shorts.png'),  priceUsd: '3.00', payload: { pant: 'Rainbow Shorts' }, isFeatured: true },
    { slot: 'BOTTOM', brand: 'Summer Looks', name: 'Neon Swirl Shorts',  imageUrl: img('bottoms/neon-swirl.png'),      priceUsd: '3.00', payload: { pant: 'Neon Swirl Shorts' } },
    { slot: 'BOTTOM', brand: 'Summer Looks', name: 'Tropical Shorts',    imageUrl: img('bottoms/tropical-shorts.png'), priceUsd: '3.00', payload: { pant: 'Tropical Shorts' } },
    { slot: 'BOTTOM', brand: 'Summer Looks', name: 'Maze Shorts',        imageUrl: img('bottoms/maze-shorts.png'),     priceUsd: '5.00', payload: { pant: 'Maze Shorts' } },

    // Sports Fashion
    { slot: 'BOTTOM', brand: 'Sports Fashion', name: 'Black Gym Shorts', imageUrl: img('bottoms/black-gym.png'),       priceUsd: '3.00', payload: { pant: 'Black Gym Shorts' } },
    { slot: 'BOTTOM', brand: 'Sports Fashion', name: 'Half Grey Shorts', imageUrl: img('bottoms/half-grey.png'),       priceUsd: '3.00', payload: { pant: 'Half Grey Shorts' } },
    { slot: 'BOTTOM', brand: 'Sports Fashion', name: 'Red Basketball',   imageUrl: img('bottoms/red-basket.png'),      priceUsd: '3.00', payload: { pant: 'Red Basketball Shorts' } },

    // Luxury Styles (pants)
    { slot: 'BOTTOM', brand: 'Luxury Styles', name: 'Gold Pants',     imageUrl: img('bottoms/gold-pants.png'),     priceUsd: '5.00', payload: { pant: 'Gold Pants' }, isFeatured: true },
    { slot: 'BOTTOM', brand: 'Luxury Styles', name: 'Beige Chinos',   imageUrl: img('bottoms/beige-chinos.png'),   priceUsd: '5.00', payload: { pant: 'Beige Chinos' } },
    { slot: 'BOTTOM', brand: 'Luxury Styles', name: 'Brown Trousers', imageUrl: img('bottoms/brown-trousers.png'), priceUsd: '3.00', payload: { pant: 'Brown Trousers' } },
    { slot: 'BOTTOM', brand: 'Luxury Styles', name: 'Plaid Pants',    imageUrl: img('bottoms/plaid-pants.png'),    priceUsd: '5.00', payload: { pant: 'Plaid Pants' } },

    // Classics
    { slot: 'BOTTOM', brand: 'Classics', name: 'Denim Shorts',        imageUrl: img('bottoms/denim-shorts.png'),  priceUsd: '3.00', payload: { pant: 'Denim Shorts' } },
    { slot: 'BOTTOM', brand: 'Classics', name: 'Green Cargo Short',   imageUrl: img('bottoms/green-cargo-short.png'), priceUsd: '3.00', payload: { pant: 'Green Cargo Short' } },
    { slot: 'BOTTOM', brand: 'Classics', name: 'Washed Jeans',        imageUrl: img('bottoms/washed-jeans.png'),  priceUsd: '3.00', payload: { pant: 'Washed Jeans' } },
    { slot: 'BOTTOM', brand: 'Classics', name: 'Olive Cargo',         imageUrl: img('bottoms/olive-cargo.png'),   priceUsd: '3.00', payload: { pant: 'Olive Cargo' } },
    { slot: 'BOTTOM', brand: 'Classics', name: 'Green Cargo',         imageUrl: img('bottoms/green-cargo.png'),   priceUsd: '3.00', payload: { pant: 'Green Cargo' } },
    { slot: 'BOTTOM', brand: 'Classics', name: 'Camo Pants',          imageUrl: img('bottoms/camo-pants.png'),    priceUsd: '3.00', payload: { pant: 'Camo Pants' } },
    { slot: 'BOTTOM', brand: 'Classics', name: 'Grey Joggers',        imageUrl: img('bottoms/grey-joggers.png'),  priceUsd: '3.00', payload: { pant: 'Grey Joggers' } },
    { slot: 'BOTTOM', brand: 'Classics', name: 'Black Joggers',       imageUrl: img('bottoms/black-joggers.png'), priceUsd: '3.00', payload: { pant: 'Black Joggers' } },
    { slot: 'BOTTOM', brand: 'Classics', name: 'Sand Pants',          imageUrl: img('bottoms/sand-pants.png'),    priceUsd: '3.00', payload: { pant: 'Sand Pants' } },
  ];

  // ---------- SHOES ----------
  const shoes = [
    // Classics - boots
    { slot: 'SHOES', brand: 'Classics', name: 'Work Boots Tan',   imageUrl: img('shoes/boots-tan.png'),   priceUsd: '3.00', payload: { shoes: 'Work Boots Tan' },   isFeatured: true },
    { slot: 'SHOES', brand: 'Classics', name: 'Work Boots Brown', imageUrl: img('shoes/boots-brown.png'), priceUsd: '3.00', payload: { shoes: 'Work Boots Brown' } },
    { slot: 'SHOES', brand: 'Classics', name: 'Work Boots Dark',  imageUrl: img('shoes/boots-dark.png'),  priceUsd: '3.00', payload: { shoes: 'Work Boots Dark' } },

    // Summer Looks - clogs/flipflops
    { slot: 'SHOES', brand: 'Summer Looks', name: 'Flipflop Blue',   imageUrl: img('shoes/flip-blue.png'),   priceUsd: '3.00', payload: { shoes: 'Flipflop Blue' } },
    { slot: 'SHOES', brand: 'Summer Looks', name: 'Flipflop Yellow', imageUrl: img('shoes/flip-yellow.png'), priceUsd: '3.00', payload: { shoes: 'Flipflop Yellow' } },
    { slot: 'SHOES', brand: 'Summer Looks', name: 'Flipflop Green',  imageUrl: img('shoes/flip-green.png'),  priceUsd: '3.00', payload: { shoes: 'Flipflop Green' } },
    { slot: 'SHOES', brand: 'Summer Looks', name: 'Camo Slip-on',    imageUrl: img('shoes/slip-camo.png'),   priceUsd: '3.00', payload: { shoes: 'Camo Slip-on' } },

    // Sports Fashion - sneakers
    { slot: 'SHOES', brand: 'Sports Fashion', name: 'Converse Red',     imageUrl: img('shoes/converse-red.png'),       priceUsd: '3.00', payload: { shoes: 'Converse Red' } },
    { slot: 'SHOES', brand: 'Sports Fashion', name: 'Converse Blue',    imageUrl: img('shoes/converse-blue.png'),      priceUsd: '3.00', payload: { shoes: 'Converse Blue' } },
    { slot: 'SHOES', brand: 'Sports Fashion', name: 'Converse Orange',  imageUrl: img('shoes/converse-orange.png'),    priceUsd: '3.00', payload: { shoes: 'Converse Orange' } },
    { slot: 'SHOES', brand: 'Sports Fashion', name: 'Black Runners',    imageUrl: img('shoes/runner-black.png'),       priceUsd: '3.00', payload: { shoes: 'Black Runners' } },
    { slot: 'SHOES', brand: 'Sports Fashion', name: 'Red/Black Runners',imageUrl: img('shoes/runner-red-black.png'),   priceUsd: '3.00', payload: { shoes: 'Red/Black Runners' } },

    // Luxury Styles
    { slot: 'SHOES', brand: 'Luxury Styles', name: 'Brown Derby',   imageUrl: img('shoes/derby-brown.png'),  priceUsd: '5.00', payload: { shoes: 'Brown Derby' },  isFeatured: true },
    { slot: 'SHOES', brand: 'Luxury Styles', name: 'Gold Loafers',  imageUrl: img('shoes/loafers-gold.png'), priceUsd: '5.00', payload: { shoes: 'Gold Loafers' } },
    { slot: 'SHOES', brand: 'Luxury Styles', name: 'Black Oxford',  imageUrl: img('shoes/oxford-black.png'), priceUsd: '5.00', payload: { shoes: 'Black Oxford' } },
  ];

  // ---------- GLASSES ----------
  const glasses = [
    // Summer Looks – sport shades
    { slot: 'GLASSES', brand: 'Summer Looks', name: 'Sport Shade Blue',  imageUrl: img('glasses/sport-blue.png'),  priceUsd: '3.00', payload: { glasses: 'blue sport sunglasses' },  isFeatured: true },
    { slot: 'GLASSES', brand: 'Summer Looks', name: 'Sport Shade Red',   imageUrl: img('glasses/sport-red.png'),   priceUsd: '3.00', payload: { glasses: 'red sport sunglasses' } },
    { slot: 'GLASSES', brand: 'Summer Looks', name: 'Sport Shade Green', imageUrl: img('glasses/sport-green.png'), priceUsd: '3.00', payload: { glasses: 'green sport sunglasses' } },
    { slot: 'GLASSES', brand: 'Summer Looks', name: 'Aviator Red',       imageUrl: img('glasses/aviator-red.png'), priceUsd: '3.00', payload: { glasses: 'thin red aviators' } },
    { slot: 'GLASSES', brand: 'Summer Looks', name: 'Aviator Gold',      imageUrl: img('glasses/aviator-gold.png'),priceUsd: '3.00', payload: { glasses: 'thin gold aviators' } },
    { slot: 'GLASSES', brand: 'Summer Looks', name: 'Blue Wayfarer',     imageUrl: img('glasses/wayfarer-blue.png'),priceUsd: '3.00', payload: { glasses: 'blue wayfarer' } },

    // Sports Fashion – ski style
    { slot: 'GLASSES', brand: 'Sports Fashion', name: 'Ski Purple', imageUrl: img('glasses/ski-purple.png'), priceUsd: '3.00', payload: { glasses: 'purple ski goggle' } },
    { slot: 'GLASSES', brand: 'Sports Fashion', name: 'Ski Duo',    imageUrl: img('glasses/ski-duo.png'),    priceUsd: '3.00', payload: { glasses: 'dual-color ski goggle' } },
    { slot: 'GLASSES', brand: 'Sports Fashion', name: 'Ski Black',  imageUrl: img('glasses/ski-black.png'),  priceUsd: '3.00', payload: { glasses: 'black ski goggle' } },

    // Luxury Styles
    { slot: 'GLASSES', brand: 'Luxury Styles', name: 'Round Gold',    imageUrl: img('glasses/round-gold.png'),   priceUsd: '5.00', payload: { glasses: 'round gold frames' }, isFeatured: true },
    { slot: 'GLASSES', brand: 'Luxury Styles', name: 'Gold Shield',   imageUrl: img('glasses/gold-shield.png'),  priceUsd: '5.00', payload: { glasses: 'gold shield sunglasses' } },
    { slot: 'GLASSES', brand: 'Luxury Styles', name: 'Cat Eye Beige', imageUrl: img('glasses/cat-eye-beige.png'),priceUsd: '3.00', payload: { glasses: 'beige cat eye' } },
    { slot: 'GLASSES', brand: 'Luxury Styles', name: 'Tortoise Round',imageUrl: img('glasses/tortoise-round.png'),priceUsd: '5.00', payload: { glasses: 'tortoiseshell round' } },
    { slot: 'GLASSES', brand: 'Luxury Styles', name: 'Green Round',   imageUrl: img('glasses/green-round.png'), priceUsd: '5.00', payload: { glasses: 'green round sunglasses' } },

    // Classics / fun
    { slot: 'GLASSES', brand: 'Classics', name: 'Pixel Black',  imageUrl: img('glasses/pixel-black.png'),  priceUsd: '3.00', payload: { glasses: 'pixel meme glasses' } },
    { slot: 'GLASSES', brand: 'Classics', name: 'Pixel Red',    imageUrl: img('glasses/pixel-red.png'),    priceUsd: '3.00', payload: { glasses: 'pixel red glasses' } },
    { slot: 'GLASSES', brand: 'Classics', name: '3D Retro',     imageUrl: img('glasses/3d-retro.png'),     priceUsd: '3.00', payload: { glasses: 'retro 3D glasses' } },
    { slot: 'GLASSES', brand: 'Classics', name: 'Frame Red',    imageUrl: img('glasses/frame-red.png'),    priceUsd: '3.00', payload: { glasses: 'red rectangular frames' } },
    { slot: 'GLASSES', brand: 'Classics', name: 'Frame Blue',   imageUrl: img('glasses/frame-blue.png'),   priceUsd: '3.00', payload: { glasses: 'blue rectangular frames' } },
    { slot: 'GLASSES', brand: 'Classics', name: 'Star Pink',    imageUrl: img('glasses/star-pink.png'),    priceUsd: '3.00', payload: { glasses: 'pink star glasses' } },
    { slot: 'GLASSES', brand: 'Classics', name: 'Star Blue',    imageUrl: img('glasses/star-blue.png'),    priceUsd: '3.00', payload: { glasses: 'blue star glasses' } },
    { slot: 'GLASSES', brand: 'Classics', name: 'Round Black',  imageUrl: img('glasses/round-black.png'),  priceUsd: '3.00', payload: { glasses: 'round black frames' } },
    { slot: 'GLASSES', brand: 'Classics', name: 'Round Teal',   imageUrl: img('glasses/round-teal.png'),   priceUsd: '3.00', payload: { glasses: 'round teal sunglasses' } },
  ];

  // ---------- WATCHES (ACCESSORY slot; payload.watch) ----------
  const watches = [
    // Summer Looks – colorful straps
    { slot: 'ACCESSORY', brand: 'Summer Looks', name: 'Red Strap Watch',  imageUrl: img('watches/red-strap.png'),   priceUsd: '3.00', payload: { watch: 'red strap watch' },  isFeatured: true },
    { slot: 'ACCESSORY', brand: 'Summer Looks', name: 'Blue Strap Watch', imageUrl: img('watches/blue-strap.png'),  priceUsd: '3.00', payload: { watch: 'blue strap watch' } },
    { slot: 'ACCESSORY', brand: 'Summer Looks', name: 'Lime Strap Watch', imageUrl: img('watches/lime-strap.png'),  priceUsd: '3.00', payload: { watch: 'lime strap watch' } },

    // Sports Fashion
    { slot: 'ACCESSORY', brand: 'Sports Fashion', name: 'Black Square Smart', imageUrl: img('watches/smart-black.png'),    priceUsd: '3.00', payload: { watch: 'black smart watch' } },
    { slot: 'ACCESSORY', brand: 'Sports Fashion', name: 'Rugged Digital',     imageUrl: img('watches/rugged-digital.png'), priceUsd: '3.00', payload: { watch: 'rugged digital watch' } },
    { slot: 'ACCESSORY', brand: 'Sports Fashion', name: 'Silver Casio',       imageUrl: img('watches/casio-silver.png'),    priceUsd: '3.00', payload: { watch: 'silver casio' } },

    // Luxury Styles
    { slot: 'ACCESSORY', brand: 'Luxury Styles', name: 'Gold Skeleton', imageUrl: img('watches/gold-skeleton.png'), priceUsd: '3.00', payload: { watch: 'gold skeleton watch' }, isFeatured: true },
    { slot: 'ACCESSORY', brand: 'Luxury Styles', name: 'Rose Gold',     imageUrl: img('watches/rose-gold.png'),     priceUsd: '3.00', payload: { watch: 'rose gold watch' } },
    { slot: 'ACCESSORY', brand: 'Luxury Styles', name: 'Black Dress',   imageUrl: img('watches/black-dress.png'),   priceUsd: '3.00', payload: { watch: 'black dress watch' } },

    // Classics
    { slot: 'ACCESSORY', brand: 'Classics', name: 'Classic Smart',     imageUrl: img('watches/classic-smart.png'), priceUsd: '3.00', payload: { watch: 'classic smart watch' } },
    { slot: 'ACCESSORY', brand: 'Classics', name: 'Chronograph Blue',  imageUrl: img('watches/chrono-blue.png'),   priceUsd: '3.00', payload: { watch: 'chronograph blue' } },
    { slot: 'ACCESSORY', brand: 'Classics', name: 'Calculator Watch',  imageUrl: img('watches/calculator.png'),    priceUsd: '3.00', payload: { watch: 'calculator watch' } },
  ];

  // ---------- MULTIPLIERS ----------
  const products = [
    { productId: 'mult_1h_x1_5',  factor: 1.5, hours: 1,  priceUsd: '1.00' },
    { productId: 'mult_1h_x2',    factor: 2.0, hours: 1,  priceUsd: '3.00' },
    { productId: 'mult_1h_x2_5',  factor: 2.5, hours: 1,  priceUsd: '4.00' },
    { productId: 'mult_12h_x1_5', factor: 1.5, hours: 12, priceUsd: '1.00' },
    { productId: 'mult_12h_x2',   factor: 2.0, hours: 12, priceUsd: '3.00' },
    { productId: 'mult_12h_x2_5', factor: 2.5, hours: 12, priceUsd: '4.00' },
  ];

  const all = [...tops, ...bottoms, ...shoes, ...glasses, ...watches];

  let created = 0, updated = 0;
  for (const it of all) {
    const before = await prisma.shopItem.findFirst({ where: { slot: it.slot, name: it.name } });
    if (before) { await prisma.shopItem.update({ where: { id: before.id }, data: it }); updated++; }
    else { await prisma.shopItem.create({ data: it }); created++; }
  }

  for (const p of products) {
    await prisma.multiplierProduct.upsert({
      where: { productId: p.productId },
      update: p,
      create: p
    });
  }
  // ---------- POINT BUNDLES ----------
  const bundles = [
    { productId: 'bundle_10',  points: 10,  priceUsd: '2.00' },
    { productId: 'bundle_50',  points: 50,  priceUsd: '3.00' },
    { productId: 'bundle_100', points: 100, priceUsd: '5.00' },
  ];

  for (const b of bundles) {
    await prisma.pointBundleProduct.upsert({
      where: { productId: b.productId },
      update: { points: b.points, priceUsd: b.priceUsd, isActive: true },
      create: b
    });
  }

   console.log(`✅ Shop seeded. Items: +${created} created, ~${updated} updated. Multipliers: ${products.length} upserted. Bundles: ${bundles.length} upserted.`);

}

main().finally(() => prisma.$disconnect());
