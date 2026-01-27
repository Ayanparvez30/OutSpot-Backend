#!/usr/bin/env node
/**
 * Standalone test script for new Shop & Points features.
 *
 * Usage:
 *   1. Start the server:  node server.js
 *   2. Run tests:         node tests/shop-features.test.js
 *
 * What it tests:
 *   - GET  /api/shop/catalog           (new endpoint)
 *   - GET  /api/shop/bundles           (appleProductId / googleProductId in response)
 *   - GET  /api/shop/multipliers       (appleProductId / googleProductId in response)
 *   - POST /api/shop/iap/confirm       (platform-specific multiplier lookup)
 *   - POST /api/shop/bundles/purchase  (platform-specific bundle lookup)
 *   - GET  /api/shop/wardrobe          (inventory check after purchase)
 *   - POST /api/shop/iap/confirm       (item purchase with applyNow)
 *
 * The script creates its own test data via Prisma, runs assertions,
 * and cleans up afterwards — no existing data is modified.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BASE = `http://localhost:${process.env.PORT || 3000}/api`;
const TEST_PREFIX = '__TEST_SHOP__';

// ── Helpers ──────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
  }
}

async function api(method, path, body, token) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(`    [WARN] Non-JSON response (${res.status}): ${text.slice(0, 120)}`);
    return { status: res.status, success: false, message: text.slice(0, 200) };
  }
  return { status: res.status, ...json };
}

// ── Test Data ────────────────────────────────────────────

let testUser = null;
let testToken = `${TEST_PREFIX}_token_${Date.now()}`;
let testShopItem = null;
let testMultiplier = null;
let testBundle = null;
const cleanupIds = { users: [], shopItems: [], multipliers: [], bundles: [], inventory: [], activeMultipliers: [], bundlePurchases: [], ledger: [] };

async function setupTestData() {
  console.log('\n🔧 Setting up test data...');

  // 1. Test user
  testUser = await prisma.user.create({
    data: {
      username: `${TEST_PREFIX}_user_${Date.now()}`,
      email: `${TEST_PREFIX}_${Date.now()}@test.com`,
      password: 'hashed_not_real',
      authorization: testToken,
      isVerified: true,
    },
  });
  cleanupIds.users.push(testUser.id);
  console.log(`  Created test user id=${testUser.id}`);

  // 2. Shop item with platform product IDs
  testShopItem = await prisma.shopItem.create({
    data: {
      slot: 'TOP',
      name: `${TEST_PREFIX}_Blue_Hoodie_${Date.now()}`,
      brand: 'TestBrand',
      imageUrl: 'https://example.com/test-hoodie.png',
      priceUsd: 4.99,
      isFeatured: true,
      payload: { shirt: 'test_blue_hoodie' },
      appleProductId: `${TEST_PREFIX}.apple.hoodie.${Date.now()}`,
      googleProductId: `${TEST_PREFIX}.google.hoodie.${Date.now()}`,
    },
  });
  cleanupIds.shopItems.push(testShopItem.id);
  console.log(`  Created test shop item id=${testShopItem.id}`);

  // 3. Multiplier with platform product IDs
  testMultiplier = await prisma.multiplierProduct.create({
    data: {
      productId: `${TEST_PREFIX}_mult_2x_1h_${Date.now()}`,
      factor: 2.0,
      hours: 1,
      priceUsd: 1.99,
      appleProductId: `${TEST_PREFIX}.apple.mult.${Date.now()}`,
      googleProductId: `${TEST_PREFIX}.google.mult.${Date.now()}`,
    },
  });
  cleanupIds.multipliers.push(testMultiplier.id);
  console.log(`  Created test multiplier id=${testMultiplier.id}`);

  // 4. Point bundle with platform product IDs
  testBundle = await prisma.pointBundleProduct.create({
    data: {
      productId: `${TEST_PREFIX}_bundle_100_${Date.now()}`,
      points: 100,
      priceUsd: 0.99,
      isActive: true,
      appleProductId: `${TEST_PREFIX}.apple.bundle.${Date.now()}`,
      googleProductId: `${TEST_PREFIX}.google.bundle.${Date.now()}`,
    },
  });
  cleanupIds.bundles.push(testBundle.id);
  console.log(`  Created test bundle id=${testBundle.id}`);
}

async function cleanup() {
  console.log('\n🧹 Cleaning up test data...');
  try {
    // Order matters — foreign keys
    if (cleanupIds.ledger.length) await prisma.pointsLedger.deleteMany({ where: { id: { in: cleanupIds.ledger } } });
    if (cleanupIds.bundlePurchases.length) await prisma.pointBundlePurchase.deleteMany({ where: { id: { in: cleanupIds.bundlePurchases } } });
    if (cleanupIds.activeMultipliers.length) await prisma.activeMultiplier.deleteMany({ where: { id: { in: cleanupIds.activeMultipliers } } });
    if (cleanupIds.inventory.length) await prisma.userInventory.deleteMany({ where: { id: { in: cleanupIds.inventory } } });

    // Also clean any inventory/multipliers/purchases tied to test user (safety net)
    if (testUser) {
      await prisma.pointsLedger.deleteMany({ where: { userId: testUser.id } });
      await prisma.pointBundlePurchase.deleteMany({ where: { userId: testUser.id } });
      await prisma.activeMultiplier.deleteMany({ where: { userId: testUser.id } });
      await prisma.userInventory.deleteMany({ where: { userId: testUser.id } });
      await prisma.minime.deleteMany({ where: { userId: testUser.id } });
    }

    if (cleanupIds.shopItems.length) await prisma.shopItem.deleteMany({ where: { id: { in: cleanupIds.shopItems } } });
    if (cleanupIds.multipliers.length) await prisma.multiplierProduct.deleteMany({ where: { id: { in: cleanupIds.multipliers } } });
    if (cleanupIds.bundles.length) await prisma.pointBundleProduct.deleteMany({ where: { id: { in: cleanupIds.bundles } } });
    if (cleanupIds.users.length) await prisma.user.deleteMany({ where: { id: { in: cleanupIds.users } } });

    console.log('  Done.');
  } catch (e) {
    console.error('  Cleanup error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

// ── Tests ────────────────────────────────────────────────

async function testCatalog() {
  console.log('\n── GET /api/shop/catalog ──');
  const res = await api('GET', '/shop/catalog', null, testToken);

  assert(res.success === true, 'Response success=true');
  assert(Array.isArray(res.data?.items), 'data.items is an array');
  assert(typeof res.data?.grouped === 'object', 'data.grouped is an object');
  assert(typeof res.data?.total === 'number', 'data.total is a number');

  const ourItem = res.data.items.find(i => i.id === testShopItem.id);
  assert(!!ourItem, 'Test item found in catalog');
  assert(ourItem?.appleProductId === testShopItem.appleProductId, 'appleProductId returned correctly');
  assert(ourItem?.googleProductId === testShopItem.googleProductId, 'googleProductId returned correctly');
  assert(ourItem?.slot === 'TOP', 'Slot is correct');
  assert(ourItem?.isFeatured === true, 'isFeatured is correct');
  assert(ourItem?.payload?.shirt === 'test_blue_hoodie', 'Payload returned correctly');

  // Check grouped
  const topItems = res.data.grouped?.TOP;
  assert(Array.isArray(topItems), 'grouped.TOP is an array');
  const inGrouped = topItems?.find(i => i.id === testShopItem.id);
  assert(!!inGrouped, 'Test item found in grouped.TOP');
}

async function testListBundles() {
  console.log('\n── GET /api/shop/bundles ──');
  const res = await api('GET', '/shop/bundles', null, testToken);

  assert(res.success === true, 'Response success=true');
  assert(Array.isArray(res.data), 'data is an array');

  const ourBundle = res.data.find(b => b.productId === testBundle.productId);
  assert(!!ourBundle, 'Test bundle found in list');
  assert(ourBundle?.appleProductId === testBundle.appleProductId, 'Bundle appleProductId returned');
  assert(ourBundle?.googleProductId === testBundle.googleProductId, 'Bundle googleProductId returned');
  assert(ourBundle?.points === 100, 'Bundle points correct');
}

async function testListMultipliers() {
  console.log('\n── GET /api/shop/multipliers ──');
  const res = await api('GET', '/shop/multipliers', null, testToken);

  assert(res.success === true, 'Response success=true');
  assert(Array.isArray(res.data), 'data is an array');

  const ourMult = res.data.find(m => m.id === testMultiplier.id);
  assert(!!ourMult, 'Test multiplier found in list');
  assert(ourMult?.appleProductId === testMultiplier.appleProductId, 'Multiplier appleProductId returned');
  assert(ourMult?.googleProductId === testMultiplier.googleProductId, 'Multiplier googleProductId returned');
  assert(ourMult?.factor === 2.0, 'Multiplier factor correct');
  assert(ourMult?.hours === 1, 'Multiplier hours correct');
}

async function testIAPConfirmMultiplier_AppleLookup() {
  console.log('\n── POST /api/shop/iap/confirm (multiplier via appleProductId) ──');
  const res = await api('POST', '/shop/iap/confirm', {
    platform: 'apple',
    productId: testMultiplier.appleProductId,
    receipt: 'fake-apple-receipt-mult-001',
    type: 'multiplier',
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.factor === 2.0, 'Multiplier factor=2.0 granted');
  assert(!!res.data?.endsAt, 'endsAt is set');
  assert(res.data?.source === 'IAP', 'source=IAP');

  if (res.data?.id) cleanupIds.activeMultipliers.push(res.data.id);

  // Verify idempotency — same receipt should return "Already granted"
  const res2 = await api('POST', '/shop/iap/confirm', {
    platform: 'apple',
    productId: testMultiplier.appleProductId,
    receipt: 'fake-apple-receipt-mult-001',
    type: 'multiplier',
  }, testToken);
  assert(res2.success === true, 'Idempotent: second call still success=true');
  assert(res2.message === 'Already granted', 'Idempotent: message="Already granted"');
}

async function testIAPConfirmMultiplier_GoogleLookup() {
  console.log('\n── POST /api/shop/iap/confirm (multiplier via googleProductId) ──');
  const res = await api('POST', '/shop/iap/confirm', {
    platform: 'google',
    productId: testMultiplier.googleProductId,
    receipt: 'fake-google-receipt-mult-002',
    type: 'multiplier',
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.factor === 2.0, 'Multiplier factor=2.0 granted via Google lookup');

  if (res.data?.id) cleanupIds.activeMultipliers.push(res.data.id);
}

async function testIAPConfirmMultiplier_LegacyFallback() {
  console.log('\n── POST /api/shop/iap/confirm (multiplier via legacy productId fallback) ──');
  const res = await api('POST', '/shop/iap/confirm', {
    platform: 'apple',
    productId: testMultiplier.productId, // legacy field
    receipt: 'fake-apple-receipt-mult-003-legacy',
    type: 'multiplier',
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.factor === 2.0, 'Multiplier granted via legacy productId fallback');

  if (res.data?.id) cleanupIds.activeMultipliers.push(res.data.id);
}

async function testIAPConfirmItem() {
  console.log('\n── POST /api/shop/iap/confirm (item purchase with applyNow) ──');
  const res = await api('POST', '/shop/iap/confirm', {
    platform: 'apple',
    productId: testShopItem.appleProductId,
    receipt: 'fake-apple-receipt-item-001',
    type: 'item',
    itemId: testShopItem.id,
    slot: 'TOP',
    applyNow: true,
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.message === 'Item granted', 'message="Item granted"');
  assert(res.data?.item?.id === testShopItem.id, 'Correct item returned');
  assert(res.data?.inventory?.itemId === testShopItem.id, 'Inventory record created');
  assert(typeof res.data?.wardrobeCount === 'number', 'wardrobeCount returned');
  assert(Array.isArray(res.data?.wardrobe), 'wardrobe array returned');

  if (res.data?.inventory?.id) cleanupIds.inventory.push(res.data.inventory.id);
}

async function testWardrobe() {
  console.log('\n── GET /api/shop/wardrobe (after item purchase) ──');
  const res = await api('GET', '/shop/wardrobe', null, testToken);

  assert(res.success === true, 'Response success=true');
  assert(typeof res.data?.totalOwned === 'number', 'totalOwned is a number');
  assert(typeof res.data?.grouped === 'object', 'grouped is an object');
  assert(typeof res.data?.equippedBySlot === 'object', 'equippedBySlot is an object');

  const flat = res.data?.flat || [];
  const ourInv = flat.find(r => r.itemId === testShopItem.id);
  assert(!!ourInv, 'Test item found in wardrobe');
  assert(ourInv?.equipped === true, 'Item is equipped (applyNow was true)');
  assert(ourInv?.slot === 'TOP', 'Slot is TOP');
}

async function testBundlePurchase_AppleLookup() {
  console.log('\n── POST /api/shop/bundles/purchase (via appleProductId) ──');

  const userBefore = await prisma.user.findUnique({ where: { id: testUser.id }, select: { totalPoints: true } });

  const res = await api('POST', '/shop/bundles/purchase', {
    platform: 'apple',
    productId: testBundle.appleProductId,
    receiptTxId: `${TEST_PREFIX}_receipt_apple_${Date.now()}`,
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.pointsCredited === 100, 'pointsCredited=100');
  assert(res.data?.totalPoints === (userBefore.totalPoints + 100), 'totalPoints incremented by 100');

  // Track for cleanup
  const purchase = await prisma.pointBundlePurchase.findFirst({
    where: { userId: testUser.id },
    orderBy: { createdAt: 'desc' },
  });
  if (purchase) cleanupIds.bundlePurchases.push(purchase.id);
  const ledger = await prisma.pointsLedger.findFirst({
    where: { userId: testUser.id },
    orderBy: { createdAt: 'desc' },
  });
  if (ledger) cleanupIds.ledger.push(ledger.id);
}

async function testBundlePurchase_GoogleLookup() {
  console.log('\n── POST /api/shop/bundles/purchase (via googleProductId) ──');

  const userBefore = await prisma.user.findUnique({ where: { id: testUser.id }, select: { totalPoints: true } });

  const res = await api('POST', '/shop/bundles/purchase', {
    platform: 'google',
    productId: testBundle.googleProductId,
    receiptTxId: `${TEST_PREFIX}_receipt_google_${Date.now()}`,
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.pointsCredited === 100, 'pointsCredited=100 via Google lookup');
  assert(res.data?.totalPoints === (userBefore.totalPoints + 100), 'totalPoints incremented');

  const purchase = await prisma.pointBundlePurchase.findFirst({
    where: { userId: testUser.id },
    orderBy: { createdAt: 'desc' },
  });
  if (purchase) cleanupIds.bundlePurchases.push(purchase.id);
  const ledger = await prisma.pointsLedger.findFirst({
    where: { userId: testUser.id },
    orderBy: { createdAt: 'desc' },
  });
  if (ledger) cleanupIds.ledger.push(ledger.id);
}

async function testBundlePurchase_LegacyFallback() {
  console.log('\n── POST /api/shop/bundles/purchase (legacy productId fallback) ──');

  const res = await api('POST', '/shop/bundles/purchase', {
    productId: testBundle.productId, // legacy, no platform
    receiptTxId: `${TEST_PREFIX}_receipt_legacy_${Date.now()}`,
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.pointsCredited === 100, 'pointsCredited=100 via legacy fallback');

  const purchase = await prisma.pointBundlePurchase.findFirst({
    where: { userId: testUser.id },
    orderBy: { createdAt: 'desc' },
  });
  if (purchase) cleanupIds.bundlePurchases.push(purchase.id);
  const ledger = await prisma.pointsLedger.findFirst({
    where: { userId: testUser.id },
    orderBy: { createdAt: 'desc' },
  });
  if (ledger) cleanupIds.ledger.push(ledger.id);
}

async function testBundlePurchase_IdempotentReceipt() {
  console.log('\n── POST /api/shop/bundles/purchase (duplicate receipt idempotency) ──');

  const receiptId = `${TEST_PREFIX}_receipt_dup_${Date.now()}`;

  // First call
  const res1 = await api('POST', '/shop/bundles/purchase', {
    productId: testBundle.productId,
    receiptTxId: receiptId,
  }, testToken);
  assert(res1.success === true, 'First purchase succeeds');

  const purchase = await prisma.pointBundlePurchase.findFirst({
    where: { userId: testUser.id },
    orderBy: { createdAt: 'desc' },
  });
  if (purchase) cleanupIds.bundlePurchases.push(purchase.id);
  const ledger = await prisma.pointsLedger.findFirst({
    where: { userId: testUser.id },
    orderBy: { createdAt: 'desc' },
  });
  if (ledger) cleanupIds.ledger.push(ledger.id);

  // Second call with same receipt — should not double-grant
  const res2 = await api('POST', '/shop/bundles/purchase', {
    productId: testBundle.productId,
    receiptTxId: receiptId,
  }, testToken);
  assert(res2.success === true, 'Duplicate receipt still returns success=true');
  assert(res2.message?.includes('Already processed'), 'Message indicates already processed');
}

async function testAuthRequired() {
  console.log('\n── Auth required (no token) ──');
  const res = await api('GET', '/shop/catalog', null, null);
  assert(res.status === 401 || res.message?.includes('Authorization'), 'Catalog returns 401 without token');

  const res2 = await api('POST', '/shop/iap/confirm', { platform: 'apple', productId: 'x', receipt: 'x', type: 'multiplier' }, null);
  assert(res2.status === 401 || res2.message?.includes('Authorization'), 'IAP confirm returns 401 without token');
}

async function testIAPValidation() {
  console.log('\n── POST /api/shop/iap/confirm (validation errors) ──');

  // Missing fields
  const res1 = await api('POST', '/shop/iap/confirm', {}, testToken);
  assert(res1.success === false, 'Missing all fields → success=false');

  // Unknown product
  const res2 = await api('POST', '/shop/iap/confirm', {
    platform: 'apple',
    productId: 'nonexistent_product_id_xyz',
    receipt: 'fake-receipt',
    type: 'multiplier',
  }, testToken);
  assert(res2.success === false, 'Unknown product → success=false');
  assert(res2.status === 404 || res2.message === 'Product not found', 'Returns "Product not found"');

  // Item purchase without itemId
  const res3 = await api('POST', '/shop/iap/confirm', {
    platform: 'apple',
    productId: testShopItem.appleProductId,
    receipt: 'fake-receipt-no-itemid',
    type: 'item',
  }, testToken);
  assert(res3.success === false, 'Item without itemId → success=false');
}

async function testActiveMultiplier() {
  console.log('\n── GET /api/shop/multiplier/active ──');
  const res = await api('GET', '/shop/multiplier/active', null, testToken);

  assert(res.success === true, 'Response success=true');
  // We created multipliers earlier, so there should be at least one active
  assert(res.data !== null, 'Active multiplier found (from earlier IAP tests)');
  assert(res.data?.factor === 2.0, 'Active multiplier factor=2.0');
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Shop & Points Features — Test Script       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Target: ${BASE}`);

  // Verify server is reachable
  try {
    const health = await fetch(`http://localhost:${process.env.PORT || 3000}/health`);
    const hj = await health.json();
    if (!hj.ok) throw new Error('Health check failed');
    console.log('Server is running. ✅\n');
  } catch (e) {
    console.error('\n❌ Cannot reach server. Make sure it is running:');
    console.error('   node server.js\n');
    process.exit(1);
  }

  try {
    await setupTestData();

    await testAuthRequired();
    await testCatalog();
    await testListBundles();
    await testListMultipliers();
    await testIAPValidation();
    await testIAPConfirmMultiplier_AppleLookup();
    await testIAPConfirmMultiplier_GoogleLookup();
    await testIAPConfirmMultiplier_LegacyFallback();
    await testActiveMultiplier();
    await testIAPConfirmItem();
    await testWardrobe();
    await testBundlePurchase_AppleLookup();
    await testBundlePurchase_GoogleLookup();
    await testBundlePurchase_LegacyFallback();
    await testBundlePurchase_IdempotentReceipt();
  } catch (e) {
    console.error('\n💥 Unexpected error:', e);
    failed++;
  } finally {
    await cleanup();
  }

  // Summary
  console.log('\n══════════════════════════════════════════════');
  console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\n  Failed tests:');
    failures.forEach(f => console.log(`    ❌ ${f}`));
  }
  console.log('══════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
