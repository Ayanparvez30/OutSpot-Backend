#!/usr/bin/env node
/**
 * Standalone test script for Shop & Points features.
 *
 * Usage:
 *   1. Start the server:  node server.js
 *   2. Run tests:         node tests/shop-features.test.js
 *
 * Creates a test user via Prisma, logs in via the API to get a real token,
 * tests all endpoints, and cleans up afterwards.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

const BASE = `http://localhost:${process.env.PORT || 3000}/api`;
const TEST_PREFIX = '__TEST_SHOP__';
const TEST_PASSWORD = 'TestPass123!';

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
let testToken = null;
let testShopItem = null;
let testShopItem2 = null;
let testMultiplier = null;
let testBundle = null;
let testInactiveBundle = null;
const ts = Date.now();
const cleanupIds = { users: [], shopItems: [], multipliers: [], bundles: [], inventory: [], activeMultipliers: [], bundlePurchases: [], ledger: [] };

async function setupTestData() {
  console.log('\n--- Setting up test data...');

  // 1. Test user with hashed password
  const hashed = await bcrypt.hash(TEST_PASSWORD, 10);
  testUser = await prisma.user.create({
    data: {
      username: `${TEST_PREFIX}_user_${ts}`,
      email: `${TEST_PREFIX}_${ts}@test.com`,
      password: hashed,
      isVerified: true,
    },
  });
  cleanupIds.users.push(testUser.id);
  console.log(`  Created test user id=${testUser.id}`);

  // 2. Shop items
  testShopItem = await prisma.shopItem.create({
    data: {
      slot: 'TOP',
      name: `${TEST_PREFIX}_Blue_Hoodie_${ts}`,
      brand: 'TestBrand',
      imageUrl: 'https://example.com/test-hoodie.png',
      priceUsd: 4.99,
      isFeatured: true,
      payload: { shirt: 'test_blue_hoodie' },
      appleProductId: `${TEST_PREFIX}.apple.hoodie.${ts}`,
      googleProductId: `${TEST_PREFIX}.google.hoodie.${ts}`,
    },
  });
  cleanupIds.shopItems.push(testShopItem.id);

  testShopItem2 = await prisma.shopItem.create({
    data: {
      slot: 'SHOES',
      name: `${TEST_PREFIX}_Red_Sneakers_${ts}`,
      brand: 'TestShoes',
      imageUrl: 'https://example.com/test-sneakers.png',
      priceUsd: 6.99,
      isFeatured: false,
      payload: { shoes: 'test_red_sneakers' },
      appleProductId: `${TEST_PREFIX}.apple.sneakers.${ts}`,
      googleProductId: `${TEST_PREFIX}.google.sneakers.${ts}`,
    },
  });
  cleanupIds.shopItems.push(testShopItem2.id);
  console.log(`  Created test shop items id=${testShopItem.id}, ${testShopItem2.id}`);

  // 3. Multiplier
  testMultiplier = await prisma.multiplierProduct.create({
    data: {
      productId: `${TEST_PREFIX}_mult_2x_1h_${ts}`,
      factor: 2.0,
      hours: 1,
      priceUsd: 1.99,
      appleProductId: `${TEST_PREFIX}.apple.mult.${ts}`,
      googleProductId: `${TEST_PREFIX}.google.mult.${ts}`,
    },
  });
  cleanupIds.multipliers.push(testMultiplier.id);
  console.log(`  Created test multiplier id=${testMultiplier.id}`);

  // 4. Active bundle
  testBundle = await prisma.pointBundleProduct.create({
    data: {
      productId: `${TEST_PREFIX}_bundle_100_${ts}`,
      points: 100,
      priceUsd: 0,
      isActive: true,
      appleProductId: `${TEST_PREFIX}.apple.bundle.${ts}`,
      googleProductId: `${TEST_PREFIX}.google.bundle.${ts}`,
    },
  });
  cleanupIds.bundles.push(testBundle.id);

  // 5. Inactive bundle (should not appear in list)
  testInactiveBundle = await prisma.pointBundleProduct.create({
    data: {
      productId: `${TEST_PREFIX}_bundle_inactive_${ts}`,
      points: 999,
      priceUsd: 0,
      isActive: false,
    },
  });
  cleanupIds.bundles.push(testInactiveBundle.id);
  console.log(`  Created test bundles id=${testBundle.id} (active), ${testInactiveBundle.id} (inactive)`);
}

async function loginTestUser() {
  console.log('\n--- Logging in via POST /api/login...');
  const res = await api('POST', '/login', {
    identifier: `${TEST_PREFIX}_${ts}@test.com`,
    password: TEST_PASSWORD,
  });
  assert(res.status === true || res.status === 200, 'Login response status ok');
  assert(!!res.data?.token, 'Login returned a token');
  testToken = res.data?.token;
  console.log(`  Token acquired: ${testToken ? testToken.slice(0, 10) + '...' : 'NONE'}`);
}

async function cleanup() {
  console.log('\n--- Cleaning up test data...');
  try {
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

async function testAuthRequired() {
  console.log('\n== Auth required (no token) ==');
  const res = await api('GET', '/shop/catalog', null, null);
  assert(res.status === 401, 'GET /shop/catalog returns 401 without token');

  const res2 = await api('POST', '/shop/iap/confirm', { platform: 'apple', productId: 'x', receipt: 'x', type: 'multiplier' }, null);
  assert(res2.status === 401, 'POST /shop/iap/confirm returns 401 without token');

  const res3 = await api('GET', '/shop/bundles', null, null);
  assert(res3.status === 401, 'GET /shop/bundles returns 401 without token');

  const res4 = await api('POST', '/shop/bundles/purchase', { productId: 'x' }, null);
  assert(res4.status === 401, 'POST /shop/bundles/purchase returns 401 without token');

  const res5 = await api('GET', '/shop/wardrobe', null, null);
  assert(res5.status === 401, 'GET /shop/wardrobe returns 401 without token');

  const res6 = await api('GET', '/shop/multipliers', null, null);
  assert(res6.status === 401, 'GET /shop/multipliers returns 401 without token');
}

async function testCatalog() {
  console.log('\n== GET /api/shop/catalog ==');
  const res = await api('GET', '/shop/catalog', null, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.status === 200, 'Status 200');
  assert(Array.isArray(res.data?.items), 'data.items is an array');
  assert(typeof res.data?.grouped === 'object', 'data.grouped is an object');
  assert(typeof res.data?.total === 'number', 'data.total is a number');
  assert(res.data?.total > 0, 'data.total > 0');

  // Verify test item is present
  const ourItem = res.data.items.find(i => i.id === testShopItem.id);
  assert(!!ourItem, 'Test item found in catalog');
  assert(ourItem?.appleProductId === testShopItem.appleProductId, 'appleProductId correct');
  assert(ourItem?.googleProductId === testShopItem.googleProductId, 'googleProductId correct');
  assert(ourItem?.slot === 'TOP', 'Slot is TOP');
  assert(ourItem?.name === testShopItem.name, 'Name is correct');
  assert(ourItem?.brand === 'TestBrand', 'Brand is correct');
  assert(ourItem?.isFeatured === true, 'isFeatured is true');
  assert(typeof ourItem?.imageUrl === 'string', 'imageUrl is a string');

  // Verify priceUsd and payload are NOT in response
  assert(ourItem?.priceUsd === undefined, 'priceUsd is NOT in catalog response');
  assert(ourItem?.payload === undefined, 'payload is NOT in catalog response');

  // Verify grouped structure
  const topItems = res.data.grouped?.TOP;
  assert(Array.isArray(topItems), 'grouped.TOP is an array');
  const inGrouped = topItems?.find(i => i.id === testShopItem.id);
  assert(!!inGrouped, 'Test item found in grouped.TOP');

  // Verify second item in different slot
  const shoesItems = res.data.grouped?.SHOES;
  assert(Array.isArray(shoesItems), 'grouped.SHOES is an array');
  const item2 = shoesItems?.find(i => i.id === testShopItem2.id);
  assert(!!item2, 'Second test item found in grouped.SHOES');
  assert(item2?.isFeatured === false, 'Second item isFeatured=false');
}

async function testClothingList() {
  console.log('\n== GET /api/shop/clothing (paginated + filtered) ==');

  // Basic list
  const res = await api('GET', '/shop/clothing', null, testToken);
  assert(res.success === true, 'Clothing list success=true');
  assert(Array.isArray(res.data?.items), 'data.items is an array');
  assert(typeof res.data?.total === 'number', 'data.total is a number');

  // Filter by slot
  const res2 = await api('GET', `/shop/clothing?slot=TOP&q=${encodeURIComponent(TEST_PREFIX)}`, null, testToken);
  assert(res2.success === true, 'Filtered by slot+query success=true');
  const found = res2.data?.items?.find(i => i.id === testShopItem.id);
  assert(!!found, 'Test item found when filtering by TOP + search');

  // Filter by different slot should not find our TOP item
  const res3 = await api('GET', `/shop/clothing?slot=BOTTOM&q=${encodeURIComponent(TEST_PREFIX)}`, null, testToken);
  const notFound = res3.data?.items?.find(i => i.id === testShopItem.id);
  assert(!notFound, 'TOP item not found when filtering by BOTTOM');
}

async function testFeatured() {
  console.log('\n== GET /api/shop/clothing/featured ==');
  const res = await api('GET', '/shop/clothing/featured', null, testToken);
  assert(res.success === true, 'Featured list success=true');
  assert(Array.isArray(res.data), 'data is an array');
  // Featured endpoint returns max 12 items; our test item may not appear if DB has many
  const allFeatured = res.data?.every(i => i.isFeatured === true);
  assert(allFeatured, 'All returned items are featured');
  assert(res.data?.length <= 12, 'Returns at most 12 items');
  const notFeatured = res.data?.find(i => i.id === testShopItem2.id);
  assert(!notFeatured, 'Non-featured item NOT in featured list');
}

async function testListBundles() {
  console.log('\n== GET /api/shop/bundles ==');
  const res = await api('GET', '/shop/bundles', null, testToken);

  assert(res.success === true, 'Response success=true');
  assert(Array.isArray(res.data), 'data is an array');

  const ourBundle = res.data.find(b => b.productId === testBundle.productId);
  assert(!!ourBundle, 'Test bundle found in list');
  assert(ourBundle?.appleProductId === testBundle.appleProductId, 'Bundle appleProductId returned');
  assert(ourBundle?.googleProductId === testBundle.googleProductId, 'Bundle googleProductId returned');
  assert(ourBundle?.points === 100, 'Bundle points correct');

  // priceUsd NOT in response
  assert(ourBundle?.priceUsd === undefined, 'priceUsd is NOT in bundles response');

  // Inactive bundle should NOT appear
  const inactive = res.data.find(b => b.productId === testInactiveBundle.productId);
  assert(!inactive, 'Inactive bundle NOT in list');
}

async function testListMultipliers() {
  console.log('\n== GET /api/shop/multipliers ==');
  const res = await api('GET', '/shop/multipliers', null, testToken);

  assert(res.success === true, 'Response success=true');
  assert(Array.isArray(res.data), 'data is an array');

  const ourMult = res.data.find(m => m.id === testMultiplier.id);
  assert(!!ourMult, 'Test multiplier found in list');
  assert(ourMult?.appleProductId === testMultiplier.appleProductId, 'Multiplier appleProductId returned');
  assert(ourMult?.googleProductId === testMultiplier.googleProductId, 'Multiplier googleProductId returned');
  assert(ourMult?.factor === 2.0, 'Multiplier factor=2.0');
  assert(ourMult?.hours === 1, 'Multiplier hours=1');
}

async function testIAPValidation() {
  console.log('\n== POST /api/shop/iap/confirm (validation) ==');

  // Missing all required fields
  const res1 = await api('POST', '/shop/iap/confirm', {}, testToken);
  assert(res1.success === false, 'Missing all fields -> fail');

  // Invalid platform
  const res2 = await api('POST', '/shop/iap/confirm', {
    platform: 'xbox', productId: 'x', receipt: 'x', type: 'multiplier',
  }, testToken);
  assert(res2.success === false, 'Invalid platform -> fail');

  // Unknown multiplier product
  const res3 = await api('POST', '/shop/iap/confirm', {
    platform: 'apple', productId: 'nonexistent_xyz', receipt: 'fake', type: 'multiplier',
  }, testToken);
  assert(res3.success === false, 'Unknown multiplier -> fail');
  assert(res3.message === 'Product not found', 'Message = "Product not found"');

  // Item purchase without itemId
  const res4 = await api('POST', '/shop/iap/confirm', {
    platform: 'apple', productId: testShopItem.appleProductId, receipt: 'fake', type: 'item',
  }, testToken);
  assert(res4.success === false, 'Item without itemId -> fail');

  // Item purchase with wrong itemId
  const res5 = await api('POST', '/shop/iap/confirm', {
    platform: 'apple', productId: testShopItem.appleProductId, receipt: 'fake', type: 'item', itemId: 999999,
  }, testToken);
  assert(res5.success === false, 'Item with nonexistent itemId -> fail');

  // Invalid slot mismatch
  const res6 = await api('POST', '/shop/iap/confirm', {
    platform: 'apple', productId: testShopItem.appleProductId, receipt: 'fake-slot-mismatch',
    type: 'item', itemId: testShopItem.id, slot: 'BOTTOM',
  }, testToken);
  assert(res6.success === false, 'Slot mismatch -> fail');

  // Unknown type
  const res7 = await api('POST', '/shop/iap/confirm', {
    platform: 'apple', productId: 'x', receipt: 'fake', type: 'subscription',
  }, testToken);
  assert(res7.success === false, 'Unknown type -> fail');

  // Missing receipt
  const res8 = await api('POST', '/shop/iap/confirm', {
    platform: 'apple', productId: testMultiplier.appleProductId, type: 'multiplier',
  }, testToken);
  assert(res8.success === false, 'Missing receipt -> fail');
}

async function testIAPMultiplier_Apple() {
  console.log('\n== POST /api/shop/iap/confirm (multiplier via appleProductId) ==');
  const res = await api('POST', '/shop/iap/confirm', {
    platform: 'apple',
    productId: testMultiplier.appleProductId,
    receipt: 'apple-receipt-mult-001',
    type: 'multiplier',
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.factor === 2.0, 'factor=2.0');
  assert(!!res.data?.endsAt, 'endsAt is set');
  assert(res.data?.source === 'IAP', 'source=IAP');

  // Idempotency: same receipt
  const res2 = await api('POST', '/shop/iap/confirm', {
    platform: 'apple',
    productId: testMultiplier.appleProductId,
    receipt: 'apple-receipt-mult-001',
    type: 'multiplier',
  }, testToken);
  assert(res2.success === true, 'Idempotent: still success=true');
  assert(res2.message === 'Already granted', 'Idempotent: "Already granted"');
}

async function testIAPMultiplier_Google() {
  console.log('\n== POST /api/shop/iap/confirm (multiplier via googleProductId) ==');
  const res = await api('POST', '/shop/iap/confirm', {
    platform: 'google',
    productId: testMultiplier.googleProductId,
    receipt: 'google-receipt-mult-002',
    type: 'multiplier',
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.factor === 2.0, 'factor=2.0 via Google lookup');
}

async function testIAPMultiplier_LegacyFallback() {
  console.log('\n== POST /api/shop/iap/confirm (multiplier via legacy productId) ==');
  const res = await api('POST', '/shop/iap/confirm', {
    platform: 'apple',
    productId: testMultiplier.productId,
    receipt: 'apple-receipt-mult-003-legacy',
    type: 'multiplier',
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.factor === 2.0, 'factor=2.0 via legacy fallback');
}

async function testActiveMultiplier() {
  console.log('\n== GET /api/shop/multiplier/active ==');
  const res = await api('GET', '/shop/multiplier/active', null, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data !== null, 'Active multiplier found');
  assert(res.data?.factor === 2.0, 'Active multiplier factor=2.0');
  assert(!!res.data?.endsAt, 'endsAt is present');
}

async function testIAPItem() {
  console.log('\n== POST /api/shop/iap/confirm (item purchase + applyNow) ==');
  const res = await api('POST', '/shop/iap/confirm', {
    platform: 'apple',
    productId: testShopItem.appleProductId,
    receipt: 'apple-receipt-item-001',
    type: 'item',
    itemId: testShopItem.id,
    slot: 'TOP',
    applyNow: true,
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.message === 'Item granted', 'message="Item granted"');
  assert(res.data?.item?.id === testShopItem.id, 'Correct item returned');
  assert(res.data?.item?.slot === 'TOP', 'Item slot correct');
  assert(res.data?.inventory?.itemId === testShopItem.id, 'Inventory created');
  assert(typeof res.data?.wardrobeCount === 'number', 'wardrobeCount returned');
  assert(Array.isArray(res.data?.wardrobe), 'wardrobe array returned');
}

async function testIAPItem_SecondItem() {
  console.log('\n== POST /api/shop/iap/confirm (second item, SHOES slot) ==');
  const res = await api('POST', '/shop/iap/confirm', {
    platform: 'google',
    productId: testShopItem2.googleProductId,
    receipt: 'google-receipt-item-002',
    type: 'item',
    itemId: testShopItem2.id,
    applyNow: false,
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.item?.slot === 'SHOES', 'Second item slot=SHOES');
  assert(res.data?.wardrobeCount >= 2, 'wardrobeCount >= 2 after two purchases');
}

async function testEquipItem() {
  console.log('\n== POST /api/shop/equip ==');
  // Equip the second item (shoes)
  const res = await api('POST', '/shop/equip', {
    itemId: testShopItem2.id,
  }, testToken);

  assert(res.success === true, 'Equip success=true');
  assert(res.data?.slot === 'SHOES', 'Equipped slot=SHOES');
  assert(res.data?.itemId === testShopItem2.id, 'Correct itemId equipped');

  // Try equipping non-owned item
  const res2 = await api('POST', '/shop/equip', {
    itemId: 999999,
  }, testToken);
  assert(res2.success === false, 'Equip non-owned item -> fail');
}

async function testWardrobe() {
  console.log('\n== GET /api/shop/wardrobe ==');
  const res = await api('GET', '/shop/wardrobe', null, testToken);

  assert(res.success === true, 'Response success=true');
  assert(typeof res.data?.totalOwned === 'number', 'totalOwned is a number');
  assert(res.data?.totalOwned >= 2, 'totalOwned >= 2');
  assert(typeof res.data?.grouped === 'object', 'grouped is an object');
  assert(typeof res.data?.equippedBySlot === 'object', 'equippedBySlot is an object');
  assert(Array.isArray(res.data?.flat), 'flat is an array');

  // Check first item (TOP, equipped via applyNow)
  const topInv = res.data?.flat?.find(r => r.itemId === testShopItem.id);
  assert(!!topInv, 'TOP item found in wardrobe');
  assert(topInv?.slot === 'TOP', 'TOP item slot correct');
  assert(topInv?.equipped === true, 'TOP item is equipped (applyNow)');

  // Check second item (SHOES, equipped via /equip)
  const shoesInv = res.data?.flat?.find(r => r.itemId === testShopItem2.id);
  assert(!!shoesInv, 'SHOES item found in wardrobe');
  assert(shoesInv?.equipped === true, 'SHOES item is equipped');
}

async function testInventory() {
  console.log('\n== GET /api/shop/inventory ==');
  const res = await api('GET', '/shop/inventory', null, testToken);

  assert(res.success === true, 'Response success=true');
  assert(Array.isArray(res.data), 'data is an array');
  assert(res.data?.length >= 2, 'At least 2 items in inventory');

  const hasItem = res.data?.some(r => r.itemId === testShopItem.id);
  assert(!!hasItem, 'Test item found in inventory');
}

async function testBundlePurchase_Apple() {
  console.log('\n== POST /api/shop/bundles/purchase (via appleProductId) ==');
  const userBefore = await prisma.user.findUnique({ where: { id: testUser.id }, select: { totalPoints: true } });

  const res = await api('POST', '/shop/bundles/purchase', {
    platform: 'apple',
    productId: testBundle.appleProductId,
    receiptTxId: `${TEST_PREFIX}_rcpt_apple_${ts}`,
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.pointsCredited === 100, 'pointsCredited=100');
  assert(res.data?.totalPoints === (userBefore.totalPoints + 100), 'totalPoints incremented by 100');
}

async function testBundlePurchase_Google() {
  console.log('\n== POST /api/shop/bundles/purchase (via googleProductId) ==');
  const userBefore = await prisma.user.findUnique({ where: { id: testUser.id }, select: { totalPoints: true } });

  const res = await api('POST', '/shop/bundles/purchase', {
    platform: 'google',
    productId: testBundle.googleProductId,
    receiptTxId: `${TEST_PREFIX}_rcpt_google_${ts}`,
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.pointsCredited === 100, 'pointsCredited=100 via Google');
  assert(res.data?.totalPoints === (userBefore.totalPoints + 100), 'totalPoints incremented');
}

async function testBundlePurchase_LegacyFallback() {
  console.log('\n== POST /api/shop/bundles/purchase (legacy productId) ==');
  const res = await api('POST', '/shop/bundles/purchase', {
    productId: testBundle.productId,
    receiptTxId: `${TEST_PREFIX}_rcpt_legacy_${ts}`,
  }, testToken);

  assert(res.success === true, 'Response success=true');
  assert(res.data?.pointsCredited === 100, 'pointsCredited=100 via legacy');
}

async function testBundlePurchase_Idempotent() {
  console.log('\n== POST /api/shop/bundles/purchase (idempotency) ==');
  const receiptId = `${TEST_PREFIX}_rcpt_dup_${ts}`;

  const res1 = await api('POST', '/shop/bundles/purchase', {
    productId: testBundle.productId,
    receiptTxId: receiptId,
  }, testToken);
  assert(res1.success === true, 'First purchase succeeds');

  const pointsAfterFirst = res1.data?.totalPoints;

  const res2 = await api('POST', '/shop/bundles/purchase', {
    productId: testBundle.productId,
    receiptTxId: receiptId,
  }, testToken);
  assert(res2.success === true, 'Duplicate receipt still success=true');
  assert(res2.message?.includes('Already processed'), 'Message = "Already processed"');

  // Verify points were NOT double-credited
  const userAfter = await prisma.user.findUnique({ where: { id: testUser.id }, select: { totalPoints: true } });
  assert(userAfter.totalPoints === pointsAfterFirst, 'Points not double-credited');
}

async function testBundlePurchase_InactiveBundle() {
  console.log('\n== POST /api/shop/bundles/purchase (inactive bundle) ==');
  const res = await api('POST', '/shop/bundles/purchase', {
    productId: testInactiveBundle.productId,
    receiptTxId: `${TEST_PREFIX}_rcpt_inactive_${ts}`,
  }, testToken);

  assert(res.success === false, 'Inactive bundle -> fail');
  assert(res.message === 'Bundle not found', 'Message = "Bundle not found"');
}

async function testBundlePurchase_Validation() {
  console.log('\n== POST /api/shop/bundles/purchase (validation) ==');
  // Missing productId
  const res = await api('POST', '/shop/bundles/purchase', {}, testToken);
  assert(res.success === false, 'Missing productId -> fail');

  // Unknown productId
  const res2 = await api('POST', '/shop/bundles/purchase', {
    productId: 'nonexistent_bundle_xyz',
  }, testToken);
  assert(res2.success === false, 'Unknown productId -> fail');
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log('============================================');
  console.log('   Shop & Points Features - Test Script');
  console.log('============================================');
  console.log(`Target: ${BASE}`);

  // Health check
  try {
    const health = await fetch(`http://localhost:${process.env.PORT || 3000}/health`);
    const hj = await health.json();
    if (!hj.ok) throw new Error('Health check failed');
    console.log('Server is running.\n');
  } catch (e) {
    console.error('\nCannot reach server. Make sure it is running:');
    console.error('   node server.js\n');
    process.exit(1);
  }

  try {
    await setupTestData();
    await loginTestUser();

    if (!testToken) {
      console.error('\nLogin failed - cannot continue without auth token.');
      await cleanup();
      process.exit(1);
    }

    // Auth
    await testAuthRequired();

    // Catalog & listing
    await testCatalog();
    await testClothingList();
    await testFeatured();
    await testListBundles();
    await testListMultipliers();

    // IAP validation
    await testIAPValidation();

    // Multiplier purchases (all 3 lookup modes)
    await testIAPMultiplier_Apple();
    await testIAPMultiplier_Google();
    await testIAPMultiplier_LegacyFallback();
    await testActiveMultiplier();

    // Item purchases
    await testIAPItem();
    await testIAPItem_SecondItem();
    await testEquipItem();
    await testWardrobe();
    await testInventory();

    // Bundle purchases
    await testBundlePurchase_Validation();
    await testBundlePurchase_Apple();
    await testBundlePurchase_Google();
    await testBundlePurchase_LegacyFallback();
    await testBundlePurchase_Idempotent();
    await testBundlePurchase_InactiveBundle();
  } catch (e) {
    console.error('\nUnexpected error:', e);
    failed++;
  } finally {
    await cleanup();
  }

  // Summary
  console.log('\n============================================');
  console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\n  Failed:');
    failures.forEach(f => console.log(`    - ${f}`));
  }
  console.log('============================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
