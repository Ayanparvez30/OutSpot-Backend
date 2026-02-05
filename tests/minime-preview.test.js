/**
 * MiniMe Preview Test
 * Tests that clothing preview with image references works correctly
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const http = require('http');

const prisma = new PrismaClient();
const BASE = 'http://localhost:3000';

function api(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api' + path, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTest() {
  console.log('=== MiniMe Preview Test ===\n');

  const ts = Date.now();
  const testEmail = `minime_test_${ts}@test.com`;
  const testPassword = 'Test123!';
  let testUserId = null;
  let testToken = null;

  try {
    // 1. Create test user with bodyShapeUrl (required for minime)
    console.log('1. Creating test user with body shape...');
    const hash = await bcrypt.hash(testPassword, 10);
    const user = await prisma.user.create({
      data: {
        email: testEmail,
        username: `mtest_${ts}`,
        password: hash,
        firstName: 'MiniMe',
        lastName: 'Test',
        isVerified: true,
        bodyType: 'masculine',
        bodyShapeUrl: 'https://myoutspotbucket.s3.us-east-1.amazonaws.com/body-shapes/masculine-default.png',
      },
    });
    testUserId = user.id;
    console.log(`   Created user id=${user.id}`);

    // 2. Create a draft minime with selfieUrl
    console.log('\n2. Creating draft minime with face reference...');
    const minime = await prisma.minime.create({
      data: {
        userId: testUserId,
        selfieUrl: 'https://myoutspotbucket.s3.us-east-1.amazonaws.com/avatars/test-face.png',
        isDraft: true,
        isSaved: false,
      },
    });
    console.log(`   Created minime id=${minime.id}`);

    // 3. Login
    console.log('\n3. Logging in...');
    const loginRes = await api('POST', '/login', {
      identifier: testEmail,
      password: testPassword,
    });
    testToken = loginRes.data?.token || loginRes.data?.data?.token;
    if (!testToken) {
      console.log('   Login response:', JSON.stringify(loginRes, null, 2));
      throw new Error('Login failed');
    }
    console.log('   Login successful');

    // 4. Get catalog to find a shop item with imageUrl
    console.log('\n4. Getting catalog...');
    const catalogRes = await api('GET', '/shop/catalog', null, testToken);
    const items = catalogRes.data?.data?.items || [];
    console.log(`   Found ${items.length} items`);

    // Find a TOP item with imageUrl
    const topItem = items.find(i => i.slot === 'TOP' && i.imageUrl);
    if (!topItem) {
      console.log('   No TOP item with imageUrl found in catalog');
      console.log('   Creating a test shop item...');
      const testItem = await prisma.shopItem.create({
        data: {
          slot: 'TOP',
          name: 'Test Hawaiian Shirt',
          brand: 'Test Brand',
          imageUrl: 'https://myoutspotbucket.s3.us-east-1.amazonaws.com/shop-items/test-shirt.png',
          isFeatured: false,
        },
      });
      console.log(`   Created test item id=${testItem.id}`);
    }

    const testShopItem = topItem || (await prisma.shopItem.findFirst({ where: { slot: 'TOP' } }));
    console.log(`   Using item: ${testShopItem?.name} (${testShopItem?.imageUrl?.substring(0, 50)}...)`);

    // 5. Test preview endpoint
    console.log('\n5. Testing /shop/custom/preview endpoint...');
    console.log(`   Sending: slot=TOP, imageUrl=${testShopItem?.imageUrl?.substring(0, 50)}...`);

    const previewRes = await api('POST', '/shop/custom/preview', {
      slot: 'TOP',
      imageUrl: testShopItem?.imageUrl,
      name: testShopItem?.name,
    }, testToken);

    console.log(`   Response status: ${previewRes.status}`);
    console.log(`   Response success: ${previewRes.data?.success}`);
    console.log(`   Response message: ${previewRes.data?.message}`);

    if (previewRes.data?.error) {
      console.log(`   Error: ${previewRes.data?.error}`);
    }

    if (previewRes.data?.data?.minime) {
      const mm = previewRes.data.data.minime;
      console.log(`   MiniMe shirt: ${mm.shirt?.substring(0, 60)}...`);
      console.log(`   MiniMe avatarUrl: ${mm.avatarUrl ? 'Generated' : 'Not generated'}`);
    }

    // 6. Check minime in DB
    console.log('\n6. Checking minime in database...');
    const dbMinime = await prisma.minime.findFirst({
      where: { userId: testUserId },
      orderBy: { createdAt: 'desc' },
    });
    console.log(`   DB shirt value: ${dbMinime?.shirt?.substring(0, 60) || 'null'}...`);
    console.log(`   Is HTTP URL: ${dbMinime?.shirt?.startsWith('http') ? 'YES' : 'NO'}`);

    // Summary
    console.log('\n========================================');
    if (previewRes.data?.success) {
      console.log('✓ PREVIEW ENDPOINT WORKING');
      if (dbMinime?.shirt?.startsWith('http')) {
        console.log('✓ Image URL stored correctly for AI reference');
      }
    } else {
      console.log('✗ PREVIEW FAILED');
      console.log('  Check server logs for details');
    }
    console.log('========================================');

  } catch (error) {
    console.error('\n✗ TEST FAILED:', error.message);
    console.error(error.stack);
  } finally {
    // Cleanup
    if (testUserId) {
      console.log(`\nCleaning up test user id=${testUserId}...`);
      await prisma.minime.deleteMany({ where: { userId: testUserId } });
      await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

runTest();
