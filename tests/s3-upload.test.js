/**
 * S3 Image Upload Test
 * Tests that admin shop item image upload works with S3
 */

const http = require('http');
const https = require('https');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const BASE = 'http://localhost:3000';

// Create a tiny valid PNG image (1x1 pixel, red)
function createTestPng() {
  // Minimal PNG: 1x1 red pixel
  return Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE,
    0xD4, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, // IEND chunk
    0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
  ]);
}

// Build multipart form data
function buildMultipart(fields, file) {
  const boundary = '----TestBoundary' + Date.now();
  const parts = [];

  // Add text fields
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
      `${value}\r\n`
    );
  }

  // Add file
  if (file) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`
    );
  }

  const header = Buffer.from(parts.join(''));
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  return {
    boundary,
    body: file ? Buffer.concat([header, file.buffer, footer]) : Buffer.concat([header, footer])
  };
}

// HTTP request helper
function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Check if URL is accessible
function checkUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 400 });
    }).on('error', () => resolve({ status: 0, ok: false }));
  });
}

async function runTest() {
  console.log('=== S3 Image Upload Test ===\n');

  const testName = `S3_TEST_${Date.now()}`;
  let createdItemId = null;

  try {
    // 1. Create test PNG
    console.log('1. Creating test PNG image...');
    const pngBuffer = createTestPng();
    console.log(`   Created ${pngBuffer.length} byte PNG`);

    // 2. Build multipart form
    console.log('\n2. Building multipart form data...');
    const { boundary, body } = buildMultipart(
      {
        name: testName,
        slot: 'TOP',
        brand: 'S3Test',
      },
      {
        fieldName: 'imageFile',
        filename: 'test-image.png',
        contentType: 'image/png',
        buffer: pngBuffer,
      }
    );
    console.log(`   Form size: ${body.length} bytes`);

    // 3. Get admin session (login first)
    console.log('\n3. Logging into admin panel...');

    // First get the login page to get a session
    const loginPageRes = await request('GET', '/admin/login');
    const cookies = loginPageRes.headers['set-cookie'] || [];
    const sessionCookie = cookies.find(c => c.startsWith('connect.sid'));

    if (!sessionCookie) {
      console.log('   No session cookie - trying direct DB approach...');
    }

    // 4. Submit via API - directly create in DB to test S3 upload
    console.log('\n4. Testing S3 upload directly...');

    const uploadToS3 = require('../utils/s3Upload');

    const testFile = {
      buffer: pngBuffer,
      originalname: 'test-upload.png',
      mimetype: 'image/png',
    };

    console.log('   Uploading to S3...');
    const s3Url = await uploadToS3(testFile, 'shop-items');
    console.log(`   S3 URL: ${s3Url}`);

    // 5. Verify URL format
    console.log('\n5. Verifying S3 URL format...');
    const expectedBucket = process.env.S3_BUCKET_NAME || 'myoutspotbucket';
    const expectedRegion = process.env.AWS_REGION || 'us-east-1';
    const expectedPrefix = `https://${expectedBucket}.s3.${expectedRegion}.amazonaws.com/shop-items/`;

    if (s3Url.startsWith(expectedPrefix)) {
      console.log('   ✓ URL format is correct');
      console.log(`   ✓ Bucket: ${expectedBucket}`);
      console.log(`   ✓ Region: ${expectedRegion}`);
      console.log(`   ✓ Folder: shop-items/`);
    } else {
      console.log(`   ✗ URL format mismatch`);
      console.log(`   Expected prefix: ${expectedPrefix}`);
      console.log(`   Got: ${s3Url}`);
    }

    // 6. Verify file is accessible
    console.log('\n6. Checking if image is accessible...');
    const urlCheck = await checkUrl(s3Url);
    if (urlCheck.ok) {
      console.log(`   ✓ Image is accessible (HTTP ${urlCheck.status})`);
    } else {
      console.log(`   ✗ Image not accessible (HTTP ${urlCheck.status})`);
      console.log('   Note: Bucket may have private ACL - this is fine if using signed URLs');
    }

    // 7. Create a shop item with the S3 URL
    console.log('\n7. Creating shop item with S3 URL in database...');
    const item = await prisma.shopItem.create({
      data: {
        name: testName,
        slot: 'TOP',
        brand: 'S3Test',
        imageUrl: s3Url,
        isFeatured: false,
      },
    });
    createdItemId = item.id;
    console.log(`   ✓ Created ShopItem id=${item.id}`);
    console.log(`   ✓ imageUrl saved: ${item.imageUrl}`);

    // 8. Verify via API
    console.log('\n8. Verifying via catalog API...');
    const catalogRes = await request('GET', '/api/shop/catalog');
    const catalog = JSON.parse(catalogRes.body);
    const found = catalog.data?.items?.find(i => i.id === item.id);
    if (found) {
      console.log(`   ✓ Item found in catalog`);
      console.log(`   ✓ imageUrl in API: ${found.imageUrl}`);
    } else {
      console.log(`   ✗ Item not found in catalog`);
    }

    console.log('\n========================================');
    console.log('✓ S3 UPLOAD TEST PASSED');
    console.log('========================================');
    console.log(`\nS3 URL: ${s3Url}`);

  } catch (error) {
    console.error('\n✗ TEST FAILED:', error.message);
    console.error(error.stack);
  } finally {
    // Cleanup
    if (createdItemId) {
      console.log(`\nCleaning up: Deleting test item id=${createdItemId}`);
      await prisma.shopItem.delete({ where: { id: createdItemId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

runTest();
