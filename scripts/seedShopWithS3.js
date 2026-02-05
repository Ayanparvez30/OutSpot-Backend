/**
 * Seed Shop Items with actual S3 URLs
 * This script replaces fake CDN URLs with real S3 bucket URLs
 */

const { PrismaClient } = require('@prisma/client');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
require('dotenv').config();

const prisma = new PrismaClient();
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET = process.env.S3_BUCKET_NAME;
const REGION = process.env.AWS_REGION;

// Item names for each slot
const SLOT_NAMES = {
  TOP: [
    'Hawaiian Floral Shirt', 'Vintage Baseball Tee', 'Graphic Print Top',
    'Classic Polo Shirt', 'Casual Button Down', 'Summer Tank Top',
    'Striped T-Shirt', 'Crew Neck Sweater', 'Denim Jacket',
    'Hoodie Pullover', 'Sports Jersey', 'Linen Beach Shirt',
    'Plaid Flannel', 'Silk Blouse', 'Crop Top', 'Cardigan',
    'Bomber Jacket', 'Turtleneck', 'Off-Shoulder Top', 'Blazer'
  ],
  BOTTOM: [
    'Classic Blue Jeans', 'Chino Pants', 'Cargo Shorts',
    'Pleated Skirt', 'Athletic Shorts', 'Jogger Pants',
    'Denim Shorts', 'Wide Leg Pants', 'Leggings',
    'Bermuda Shorts', 'Maxi Skirt', 'Capri Pants',
    'Sweatpants', 'Mini Skirt', 'Tailored Trousers'
  ],
  SHOES: [
    'White Sneakers', 'Running Shoes', 'Leather Loafers',
    'Canvas Slip-Ons', 'High Top Boots', 'Sandals',
    'Platform Heels', 'Oxford Shoes', 'Flip Flops',
    'Ankle Boots', 'Basketball Shoes', 'Espadrilles',
    'Chelsea Boots', 'Ballet Flats', 'Hiking Boots'
  ],
  GLASSES: [
    'Aviator Sunglasses', 'Round Wire Frames', 'Cat Eye Glasses',
    'Wayfarer Shades', 'Sport Goggles', 'Reading Glasses',
    'Oversized Frames', 'Retro Square', 'Polarized Lenses',
    'Clear Frames', 'Mirrored Sunglasses', 'Browline Glasses'
  ],
  ACCESSORY: [
    'Gold Chain Necklace', 'Leather Watch', 'Silver Bracelet',
    'Stud Earrings', 'Baseball Cap', 'Crossbody Bag',
    'Beanie Hat', 'Tote Bag', 'Pendant Necklace',
    'Digital Watch', 'Hoop Earrings', 'Backpack',
    'Bucket Hat', 'Clutch Purse', 'Charm Bracelet'
  ]
};

const BRANDS = [
  'Summer Collection', 'Urban Style', 'Classic Wear', 'Sport Pro',
  'Street Fashion', 'Luxury Line', 'Casual Basics', 'Trend Setter',
  'Active Wear', 'Designer Series'
];

async function getAllS3Keys() {
  let allKeys = [];
  let continuationToken = null;

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: 'shop-items/',
      ContinuationToken: continuationToken
    });
    const result = await s3.send(cmd);
    if (result.Contents) {
      allKeys = allKeys.concat(result.Contents.map(o => o.Key));
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : null;
  } while (continuationToken);

  return allKeys;
}

function getS3Url(key) {
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

async function main() {
  console.log('=== Seeding Shop Items with S3 URLs ===\n');

  // 1. Get all S3 keys
  const s3Keys = await getAllS3Keys();
  console.log(`Found ${s3Keys.length} images in S3 shop-items/`);

  // 2. Delete existing shop items (optional - comment out to keep existing)
  const deleteExisting = process.argv.includes('--replace');
  if (deleteExisting) {
    console.log('\nDeleting existing shop items...');
    // First delete inventory references
    await prisma.userInventory.deleteMany({});
    const deleted = await prisma.shopItem.deleteMany({});
    console.log(`Deleted ${deleted.count} existing items`);
  }

  // 3. Distribute images across slots
  const slots = Object.keys(SLOT_NAMES);
  const itemsPerSlot = Math.ceil(s3Keys.length / slots.length);

  let created = 0;
  let featured = 0;

  for (let i = 0; i < s3Keys.length; i++) {
    const key = s3Keys[i];
    const slotIndex = Math.floor(i / itemsPerSlot) % slots.length;
    const slot = slots[slotIndex];
    const names = SLOT_NAMES[slot];
    const nameIndex = i % names.length;
    const name = `${names[nameIndex]} ${Math.floor(i / names.length) + 1}`.trim();
    const brand = BRANDS[i % BRANDS.length];
    const isFeatured = i < 12; // First 12 items are featured

    try {
      await prisma.shopItem.create({
        data: {
          slot,
          name,
          brand,
          imageUrl: getS3Url(key),
          isFeatured,
        }
      });
      created++;
      if (isFeatured) featured++;

      if (created % 20 === 0) {
        console.log(`  Created ${created}/${s3Keys.length} items...`);
      }
    } catch (e) {
      if (e.code === 'P2002') {
        console.log(`  Skipped duplicate: ${name}`);
      } else {
        console.error(`  Error creating ${name}:`, e.message);
      }
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Created: ${created} items`);
  console.log(`Featured: ${featured} items`);

  // Show distribution
  const counts = await prisma.shopItem.groupBy({
    by: ['slot'],
    _count: true
  });
  console.log('\nDistribution by slot:');
  counts.forEach(c => console.log(`  ${c.slot}: ${c._count}`));

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
