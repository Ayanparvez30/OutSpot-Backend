/**
 * MiniMe Multi-Item Test
 * Tests MiniMe generation with multiple clothing items (shirt, pant, shoes, glasses)
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const http = require('http');

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL || 'http://localhost:3001';

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
      timeout: 120000, // 2 min timeout for image generation
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

    req.setTimeout(120000);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTest() {
  console.log('=== MiniMe Multi-Item Test ===\n');

  const ts = Date.now();
  const testEmail = `multi_item_test_${ts}@test.com`;
  const testPassword = 'Test123!';
  let testUserId = null;
  let testToken = null;

  try {
    // 1. Get shop items for multiple slots
    console.log('1. Getting shop items for multiple slots...');
    const topItem = await prisma.shopItem.findFirst({ where: { slot: 'TOP' } });
    const bottomItem = await prisma.shopItem.findFirst({ where: { slot: 'BOTTOM' } });
    const shoesItem = await prisma.shopItem.findFirst({ where: { slot: 'SHOES' } });
    const glassesItem = await prisma.shopItem.findFirst({ where: { slot: 'GLASSES' } });

    console.log(`   TOP: ${topItem?.name} - ${topItem?.imageUrl?.substring(0, 60)}...`);
    console.log(`   BOTTOM: ${bottomItem?.name} - ${bottomItem?.imageUrl?.substring(0, 60)}...`);
    console.log(`   SHOES: ${shoesItem?.name} - ${shoesItem?.imageUrl?.substring(0, 60)}...`);
    console.log(`   GLASSES: ${glassesItem?.name} - ${glassesItem?.imageUrl?.substring(0, 60)}...`);

    // 2. Create test user with bodyShapeUrl
    console.log('\n2. Creating test user with body shape...');
    const hash = await bcrypt.hash(testPassword, 10);
    const user = await prisma.user.create({
      data: {
        email: testEmail,
        username: `multitest_${ts}`,
        password: hash,
        firstName: 'MultiItem',
        lastName: 'Test',
        isVerified: true,
        bodyType: 'masculine',
        bodyShapeUrl: 'https://myoutspotbucket.s3.us-east-1.amazonaws.com/body-shapes/masculine-default.png',
      },
    });
    testUserId = user.id;
    console.log(`   Created user id=${user.id}`);

    // 3. Create a draft minime with selfieUrl
    console.log('\n3. Creating draft minime with face reference...');
    const minime = await prisma.minime.create({
      data: {
        userId: testUserId,
        selfieUrl: 'https://myoutspotbucket.s3.us-east-1.amazonaws.com/avatars/test-face.png',
        isDraft: true,
        isSaved: false,
      },
    });
    console.log(`   Created minime id=${minime.id}`);

    // 4. Login
    console.log('\n4. Logging in...');
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

    // 5. Update minime with all outfit items via direct DB update
    console.log('\n5. Setting outfit items on minime...');
    await prisma.minime.update({
      where: { id: minime.id },
      data: {
        shirt: topItem?.imageUrl,
        pant: bottomItem?.imageUrl,
        shoes: shoesItem?.imageUrl,
        glasses: glassesItem?.imageUrl,
      },
    });
    console.log('   Outfit items set (shirt, pant, shoes, glasses)');

    // 6. Call renderCurrentMinime via API or direct call
    console.log('\n6. Generating MiniMe with multiple items...');
    console.log('   (This may take 30-60 seconds for AI image generation)');
    console.log('   Check server logs for INPUT/OUTPUT URL logging...\n');

    // Import and call renderCurrentMinime directly for better logging visibility
    const { renderCurrentMinime } = require('../utils/minimeGen');

    const startTime = Date.now();
    const result = await renderCurrentMinime(testUserId);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n7. Generation complete in ${duration}s`);
    console.log(`   MiniMe ID: ${result.id}`);
    console.log(`   Avatar URL: ${result.avatarUrl}`);
    console.log(`   Shirt: ${result.shirt?.substring(0, 60)}...`);
    console.log(`   Pant: ${result.pant?.substring(0, 60)}...`);
    console.log(`   Shoes: ${result.shoes?.substring(0, 60)}...`);
    console.log(`   Glasses: ${result.glasses?.substring(0, 60)}...`);

    // Summary
    console.log('\n========================================');
    if (result.avatarUrl) {
      console.log('✓ MULTI-ITEM MINIME GENERATED SUCCESSFULLY');
      console.log(`✓ Output URL: ${result.avatarUrl}`);
    } else {
      console.log('✗ GENERATION FAILED - No avatar URL');
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
