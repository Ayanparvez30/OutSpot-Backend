/**
 * Point Bundle Purchase Test
 * Tests that purchasing point bundles correctly updates user.totalPoints
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
  console.log('=== Point Bundle Purchase Test ===\n');

  const ts = Date.now();
  const testEmail = `points_test_${ts}@test.com`;
  const testPassword = 'Test123!';
  let testUserId = null;
  let testToken = null;

  try {
    // 1. Create test user
    console.log('1. Creating test user...');
    const hash = await bcrypt.hash(testPassword, 10);
    const user = await prisma.user.create({
      data: {
        email: testEmail,
        username: `ptest_${ts}`,
        password: hash,
        firstName: 'Points',
        lastName: 'Test',
        totalPoints: 0,
        isVerified: true,
      },
    });
    testUserId = user.id;
    console.log(`   Created user id=${user.id}, totalPoints=${user.totalPoints}`);

    // 2. Login to get token
    console.log('\n2. Logging in...');
    const loginRes = await api('POST', '/login', {
      identifier: testEmail,
      password: testPassword,
    });
    // Token can be at data.token or data.data.token
    testToken = loginRes.data?.token || loginRes.data?.data?.token;
    if (!testToken) {
      console.log('   Login response:', JSON.stringify(loginRes, null, 2));
      throw new Error('Login failed - no token');
    }
    console.log('   Login successful, got token');

    // 3. Check initial points via profile
    console.log('\n3. Checking initial points via /profile...');
    const profileBefore = await api('GET', '/me/profile', null, testToken);
    console.log(`   Profile totalPoints: ${profileBefore.data?.data?.totalPoints}`);

    // 4. Get available point bundles
    console.log('\n4. Getting available point bundles...');
    const bundlesRes = await api('GET', '/shop/bundles', null, testToken);
    console.log(`   Found ${bundlesRes.data?.data?.length || 0} bundles`);

    if (!bundlesRes.data?.data?.length) {
      console.log('   No bundles found - creating a test bundle...');
      await prisma.pointBundleProduct.create({
        data: {
          productId: `test_bundle_${ts}`,
          points: 100,
          priceUsd: '0.99',
          isActive: true,
        },
      });
      console.log('   Created test bundle: 100 points');
    }

    const bundles = (await api('GET', '/shop/bundles', null, testToken)).data?.data || [];
    const testBundle = bundles[0];
    console.log(`   Using bundle: ${testBundle?.productId} (${testBundle?.points} points)`);

    // 5. Purchase point bundle
    console.log('\n5. Purchasing point bundle...');
    const purchaseRes = await api('POST', '/shop/bundles/purchase', {
      productId: testBundle.productId,
      receiptTxId: `test_receipt_${ts}`,
    }, testToken);

    console.log('   Purchase response:', JSON.stringify(purchaseRes.data, null, 2));

    // 6. Check points in DB directly
    console.log('\n6. Checking points in database directly...');
    const dbUser = await prisma.user.findUnique({
      where: { id: testUserId },
      select: { totalPoints: true },
    });
    console.log(`   DB totalPoints: ${dbUser?.totalPoints}`);

    // 7. Check points via profile API
    console.log('\n7. Checking points via /profile API...');
    const profileAfter = await api('GET', '/me/profile', null, testToken);
    console.log(`   API totalPoints: ${profileAfter.data?.data?.totalPoints}`);

    // 8. Check points ledger
    console.log('\n8. Checking PointsLedger...');
    const ledger = await prisma.pointsLedger.findMany({
      where: { userId: testUserId },
      orderBy: { createdAt: 'desc' },
    });
    console.log(`   Ledger entries: ${ledger.length}`);
    ledger.forEach((l, i) => {
      console.log(`   [${i}] reason=${l.reason}, basePoints=${l.basePoints}, finalPoints=${l.finalPoints}`);
    });

    // 9. Check PointBundlePurchase
    console.log('\n9. Checking PointBundlePurchase...');
    const purchases = await prisma.pointBundlePurchase.findMany({
      where: { userId: testUserId },
    });
    console.log(`   Purchase records: ${purchases.length}`);
    purchases.forEach((p, i) => {
      console.log(`   [${i}] productId=${p.productId}, points=${p.points}`);
    });

    // 10. Summary
    console.log('\n========================================');
    if (dbUser?.totalPoints > 0 && profileAfter.data?.data?.totalPoints > 0) {
      console.log('✓ POINTS PURCHASE WORKING');
      console.log(`  Points credited: ${dbUser.totalPoints}`);
    } else {
      console.log('✗ POINTS NOT CREDITED');
      console.log('  DB points:', dbUser?.totalPoints);
      console.log('  API points:', profileAfter.data?.data?.totalPoints);
    }
    console.log('========================================');

  } catch (error) {
    console.error('\n✗ TEST FAILED:', error.message);
    console.error(error.stack);
  } finally {
    // Cleanup
    if (testUserId) {
      console.log(`\nCleaning up test user id=${testUserId}...`);
      await prisma.pointBundlePurchase.deleteMany({ where: { userId: testUserId } });
      await prisma.pointsLedger.deleteMany({ where: { userId: testUserId } });
      await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

runTest();
