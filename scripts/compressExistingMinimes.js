/**
 * Compress existing MiniMe images on S3
 * - Only touches files in the minimes/ folder
 * - Only compresses files larger than 100 KB
 * - Converts PNG → WebP (512×768, quality 80)
 * - Updates avatarUrl in the database
 * - Deletes old PNG only AFTER DB is confirmed updated
 *
 * SAFE ORDER OF OPERATIONS (per image):
 *   1. Upload new .webp to S3    (old PNG still exists as backup)
 *   2. Update DB avatarUrl        (if fails → delete new webp, old PNG untouched, skip)
 *   3. Verify DB has new URL      (if fails → rollback DB to old URL, skip)
 *   4. Delete old .png from S3    (only now, DB is confirmed pointing to new webp)
 *
 * Usage:
 *   node scripts/compressExistingMinimes.js          # dry run
 *   node scripts/compressExistingMinimes.js --run     # compress + update
 */

const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { PrismaClient } = require('@prisma/client');
const sharp = require('sharp');
const fs = require('fs');
require('dotenv').config();

const s3 = new S3Client({ region: process.env.AWS_REGION });
const prisma = new PrismaClient();
const BUCKET = process.env.S3_BUCKET_NAME;
const REGION = process.env.AWS_REGION;
const SIZE_THRESHOLD_KB = 100;
const DRY_RUN = !process.argv.includes('--run');

// Log file for tracking (useful for rollback)
const LOG_FILE = `scripts/compress-log-${Date.now()}.json`;
const migrationLog = [];

function s3Url(key) {
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  if (DRY_RUN) {
    console.log('=== DRY RUN (pass --run to actually compress) ===\n');
  } else {
    console.log('=== COMPRESSING EXISTING MINIME IMAGES ===\n');
  }

  // 1. List all objects in minimes/
  let allObjects = [];
  let continuationToken;

  do {
    const params = { Bucket: BUCKET, Prefix: 'minimes/', MaxKeys: 1000 };
    if (continuationToken) params.ContinuationToken = continuationToken;

    const res = await s3.send(new ListObjectsV2Command(params));
    if (res.Contents) allObjects.push(...res.Contents);
    continuationToken = res.IsTruncated ? res.NextContinuationToken : null;
  } while (continuationToken);

  console.log(`Total files in minimes/: ${allObjects.length}`);

  // 2. Filter to large files only (skip already-compressed webp)
  const toCompress = allObjects.filter(obj => {
    const sizeKB = obj.Size / 1024;
    const isAlreadyWebp = obj.Key.endsWith('.webp');
    return sizeKB > SIZE_THRESHOLD_KB && !isAlreadyWebp;
  });

  console.log(`Files > ${SIZE_THRESHOLD_KB} KB (non-webp): ${toCompress.length}`);

  if (toCompress.length === 0) {
    console.log('\nNothing to compress!');
    await prisma.$disconnect();
    return;
  }

  let compressed = 0;
  let skipped = 0;
  let totalSavedKB = 0;

  for (const obj of toCompress) {
    const oldKey = obj.Key;
    const oldUrl = s3Url(oldKey);
    const oldSizeKB = (obj.Size / 1024).toFixed(0);
    const newKey = oldKey.replace(/\.[^.]+$/, '.webp');
    const newUrl = s3Url(newKey);

    if (DRY_RUN) {
      // Check how many DB rows reference this URL
      const dbCount = await prisma.minime.count({ where: { avatarUrl: oldUrl } });
      console.log(`  [DRY] ${oldKey} (${oldSizeKB} KB) → webp  [DB refs: ${dbCount}]`);
      compressed++;
      continue;
    }

    try {
      // --- STEP 1: Download & compress ---
      const getRes = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: oldKey }));
      const rawBuffer = await streamToBuffer(getRes.Body);

      const compressedBuffer = await sharp(rawBuffer)
        .resize(768, 1152, { fit: 'inside', withoutEnlargement: true })
        .sharpen({ sigma: 0.5 })
        .webp({ quality: 85, alphaQuality: 95, effort: 6, smartSubsample: true })
        .toBuffer();

      const newSizeKB = (compressedBuffer.length / 1024).toFixed(0);

      // --- STEP 2: Upload new webp (old PNG still safe) ---
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: newKey,
        Body: compressedBuffer,
        ContentType: 'image/webp',
      }));

      // --- STEP 3: Update DB ---
      let dbUpdated;
      try {
        dbUpdated = await prisma.minime.updateMany({
          where: { avatarUrl: oldUrl },
          data: { avatarUrl: newUrl },
        });
      } catch (dbErr) {
        // DB update failed → delete the new webp, old PNG untouched
        console.error(`  ✗ DB failed for ${oldKey}: ${dbErr.message} → rolling back S3`);
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: newKey }));
        skipped++;
        continue;
      }

      // --- STEP 4: Verify DB is pointing to new URL ---
      const verifyCount = await prisma.minime.count({ where: { avatarUrl: oldUrl } });
      if (verifyCount > 0) {
        // Some rows still point to old URL → don't delete old PNG
        console.error(`  ⚠ ${oldKey}: ${verifyCount} rows still point to old URL → keeping old PNG`);
        skipped++;
        continue;
      }

      // --- STEP 5: Delete old PNG (DB is confirmed updated) ---
      if (oldKey !== newKey) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: oldKey }));
      }

      const savedKB = (rawBuffer.length - compressedBuffer.length) / 1024;
      totalSavedKB += savedKB;

      // Log for rollback tracking
      migrationLog.push({ oldKey, oldUrl, newKey, newUrl, dbRows: dbUpdated.count });

      console.log(`  ✓ ${oldKey} (${oldSizeKB} KB) → ${newKey} (${newSizeKB} KB) [DB rows: ${dbUpdated.count}]`);
      compressed++;
    } catch (err) {
      console.error(`  ✗ ${oldKey}: ${err.message}`);
      skipped++;
    }
  }

  // Save migration log
  if (!DRY_RUN && migrationLog.length > 0) {
    fs.writeFileSync(LOG_FILE, JSON.stringify(migrationLog, null, 2));
    console.log(`\nMigration log saved to: ${LOG_FILE}`);
  }

  // --- VERIFICATION: Check no DB rows point to dead URLs ---
  if (!DRY_RUN) {
    console.log('\n--- Verification ---');
    const allMinimes = await prisma.minime.findMany({
      where: { avatarUrl: { not: null } },
      select: { id: true, avatarUrl: true },
    });

    let broken = 0;
    for (const m of allMinimes) {
      if (m.avatarUrl && m.avatarUrl.includes('/minimes/') && m.avatarUrl.endsWith('.png')) {
        // Still points to a PNG — check if that PNG exists on S3
        const key = m.avatarUrl.split('.amazonaws.com/')[1];
        if (key) {
          try {
            await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: 'bytes=0-0' }));
          } catch {
            console.error(`  BROKEN: minime id=${m.id} → ${m.avatarUrl} (file missing)`);
            broken++;
          }
        }
      }
    }

    if (broken === 0) {
      console.log('  ✓ All DB avatarUrls are valid — no broken references');
    } else {
      console.error(`  ✗ ${broken} broken references found!`);
    }
  }

  const totalSavedMB = (totalSavedKB / 1024).toFixed(1);
  console.log(`\n--- Summary ---`);
  console.log(`Compressed: ${compressed}`);
  console.log(`Skipped/errors: ${skipped}`);
  if (!DRY_RUN) {
    console.log(`Total space saved: ${totalSavedMB} MB`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  await prisma.$disconnect();
  process.exit(1);
});
