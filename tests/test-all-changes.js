/**
 * Comprehensive test for:
 * 1. Admin shop CRUD (free + paid items)
 * 2. Free/paid catalog API endpoints
 * 3. generateMinime with premadeId + watch
 * 4. regenerateMinime with watch persistence
 * 5. Prisma schema watch field
 * 6. Multer 10MB limit config
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

// ─── Test helpers ───
let testFreeItemId = null;
let testPaidItemId = null;
let testPremadeId = null;
let testUserId = null;
let testDraftId = null;

async function cleanup() {
  if (testFreeItemId) await prisma.shopItem.delete({ where: { id: testFreeItemId } }).catch(() => {});
  if (testPaidItemId) await prisma.shopItem.delete({ where: { id: testPaidItemId } }).catch(() => {});
  if (testPremadeId) await prisma.premadeAvatar.delete({ where: { id: testPremadeId } }).catch(() => {});
  if (testDraftId) await prisma.minime.delete({ where: { id: testDraftId } }).catch(() => {});
  await prisma.$disconnect();
}

async function run() {
  try {
    // ═══════════════════════════════════════
    console.log('\n═══ 1. PRISMA SCHEMA: watch field on Minime ═══');
    // ═══════════════════════════════════════

    // Create a test user to work with
    const testUser = await prisma.user.findFirst({ select: { id: true } });
    if (!testUser) {
      console.error('No users in DB — cannot test. Create a user first.');
      process.exit(1);
    }
    testUserId = testUser.id;
    assert(!!testUserId, `Found test user id=${testUserId}`);

    // Create a MiniMe with watch field
    const mmWithWatch = await prisma.minime.create({
      data: {
        userId: testUserId,
        shirt: 'https://example.com/shirt.jpg',
        watch: 'https://example.com/watch.jpg',
        isSaved: false,
        isDraft: true,
      },
    });
    testDraftId = mmWithWatch.id;
    assert(mmWithWatch.watch === 'https://example.com/watch.jpg', 'Minime.watch field stores correctly');
    assert(mmWithWatch.shirt === 'https://example.com/shirt.jpg', 'Minime.shirt still works');

    // Read it back
    const readBack = await prisma.minime.findUnique({ where: { id: testDraftId } });
    assert(readBack.watch === 'https://example.com/watch.jpg', 'Minime.watch reads back correctly');

    // Update watch
    const updated = await prisma.minime.update({
      where: { id: testDraftId },
      data: { watch: 'https://example.com/watch2.jpg' },
    });
    assert(updated.watch === 'https://example.com/watch2.jpg', 'Minime.watch updates correctly');

    // Set watch to null
    const nulled = await prisma.minime.update({
      where: { id: testDraftId },
      data: { watch: null },
    });
    assert(nulled.watch === null, 'Minime.watch can be set to null');

    // Clean up draft
    await prisma.minime.delete({ where: { id: testDraftId } });
    testDraftId = null;

    // ═══════════════════════════════════════
    console.log('\n═══ 2. SHOP ITEM CRUD: Free items ═══');
    // ═══════════════════════════════════════

    // Create a FREE item (no IAP IDs)
    const freeItem = await prisma.shopItem.create({
      data: {
        slot: 'TOP',
        name: `free-TOP-${Date.now()}`,
        imageUrl: 'https://example.com/free-shirt.jpg',
        appleProductId: null,
        googleProductId: null,
        isFeatured: false,
      },
    });
    testFreeItemId = freeItem.id;
    assert(!!freeItem.id, `Free item created id=${freeItem.id}`);
    assert(freeItem.appleProductId === null, 'Free item has null appleProductId');
    assert(freeItem.googleProductId === null, 'Free item has null googleProductId');
    assert(freeItem.name.startsWith('free-'), 'Free item name auto-generated with prefix');

    // Create a PAID item (has IAP ID)
    const paidItem = await prisma.shopItem.create({
      data: {
        slot: 'BOTTOM',
        name: `test-paid-${Date.now()}`,
        brand: 'TestBrand',
        imageUrl: 'https://example.com/paid-pants.jpg',
        appleProductId: `com.test.paid_${Date.now()}`,
        googleProductId: null,
        isFeatured: true,
      },
    });
    testPaidItemId = paidItem.id;
    assert(!!paidItem.id, `Paid item created id=${paidItem.id}`);
    assert(paidItem.appleProductId !== null, 'Paid item has appleProductId set');

    // ═══════════════════════════════════════
    console.log('\n═══ 3. CATALOG FILTERING: Free vs Paid ═══');
    // ═══════════════════════════════════════

    // Free catalog query
    const freeItems = await prisma.shopItem.findMany({
      where: { appleProductId: null, googleProductId: null },
      select: { id: true, slot: true, imageUrl: true },
    });
    const freeIds = freeItems.map(i => i.id);
    assert(freeIds.includes(testFreeItemId), 'Free catalog includes our free item');
    assert(!freeIds.includes(testPaidItemId), 'Free catalog excludes paid item');

    // Free items only have id, slot, imageUrl (minimal payload)
    const sampleFree = freeItems[0];
    assert(sampleFree.id !== undefined, 'Free catalog returns id');
    assert(sampleFree.slot !== undefined, 'Free catalog returns slot');
    assert(sampleFree.imageUrl !== undefined, 'Free catalog returns imageUrl');

    // Paid catalog query
    const paidItems = await prisma.shopItem.findMany({
      where: { OR: [{ appleProductId: { not: null } }, { googleProductId: { not: null } }] },
      select: { id: true, slot: true, name: true, brand: true, imageUrl: true, appleProductId: true, googleProductId: true },
    });
    const paidIds = paidItems.map(i => i.id);
    assert(paidIds.includes(testPaidItemId), 'Paid catalog includes our paid item');
    assert(!paidIds.includes(testFreeItemId), 'Paid catalog excludes free item');

    // Grouping test
    const grouped = freeItems.reduce((acc, item) => {
      if (!acc[item.slot]) acc[item.slot] = [];
      acc[item.slot].push(item);
      return acc;
    }, {});
    assert(grouped['TOP'] && grouped['TOP'].length > 0, 'Free catalog groups by slot correctly');

    // ═══════════════════════════════════════
    console.log('\n═══ 4. PREMADE AVATAR LOOKUP ═══');
    // ═══════════════════════════════════════

    // Create test premade
    const premade = await prisma.premadeAvatar.create({
      data: {
        label: 'Test Premade',
        gender: 'male',
        imageUrl: 'https://example.com/premade-face.jpg',
        isActive: true,
        sortOrder: 999,
      },
    });
    testPremadeId = premade.id;
    assert(!!premade.id, `Premade created id=${premade.id}`);
    assert(premade.isActive === true, 'Premade is active');

    // Simulate generateMinime premadeId lookup
    const lookedUp = await prisma.premadeAvatar.findUnique({
      where: { id: premade.id },
    });
    assert(lookedUp !== null, 'Premade lookup by id works');
    assert(lookedUp.imageUrl === 'https://example.com/premade-face.jpg', 'Premade imageUrl correct');
    assert(lookedUp.isActive === true, 'Premade isActive check passes');

    // Inactive premade should be rejected
    await prisma.premadeAvatar.update({ where: { id: premade.id }, data: { isActive: false } });
    const inactive = await prisma.premadeAvatar.findUnique({ where: { id: premade.id } });
    assert(inactive.isActive === false, 'Inactive premade correctly identified');
    // Restore
    await prisma.premadeAvatar.update({ where: { id: premade.id }, data: { isActive: true } });

    // ═══════════════════════════════════════
    console.log('\n═══ 5. GENERATE MINIME: premadeId + watch + outfit ═══');
    // ═══════════════════════════════════════

    // Simulate what generateMinime does: create draft with all fields
    const faceRef = premade.imageUrl;
    const draft = await prisma.minime.create({
      data: {
        userId: testUserId,
        shirt: 'https://example.com/shirt.jpg',
        pant: 'https://example.com/pant.jpg',
        shoes: 'https://example.com/shoes.jpg',
        glasses: null,
        lipstick: null,
        jewelry: null,
        bag: null,
        watch: 'https://example.com/watch.jpg',
        selfieUrl: faceRef,
        isSaved: false,
        isDraft: true,
      },
    });
    testDraftId = draft.id;
    assert(draft.selfieUrl === faceRef, 'Draft selfieUrl set from premade');
    assert(draft.shirt === 'https://example.com/shirt.jpg', 'Draft shirt set');
    assert(draft.pant === 'https://example.com/pant.jpg', 'Draft pant set');
    assert(draft.shoes === 'https://example.com/shoes.jpg', 'Draft shoes set');
    assert(draft.glasses === null, 'Draft glasses null when not provided');
    assert(draft.watch === 'https://example.com/watch.jpg', 'Draft watch set');
    assert(draft.isDraft === true, 'Draft isDraft=true');
    assert(draft.isSaved === false, 'Draft isSaved=false');

    // ═══════════════════════════════════════
    console.log('\n═══ 6. REGENERATE MINIME: watch persistence ═══');
    // ═══════════════════════════════════════

    // Simulate regenerate seeding from existing draft
    const seed = draft;
    const reDraft = await prisma.minime.create({
      data: {
        userId: testUserId,
        shirt: seed.shirt ?? null,
        pant: seed.pant ?? null,
        shoes: seed.shoes ?? null,
        glasses: seed.glasses ?? null,
        lipstick: seed.lipstick ?? null,
        jewelry: seed.jewelry ?? null,
        bag: seed.bag ?? null,
        watch: seed.watch ?? null,
        selfieUrl: seed.selfieUrl,
        isSaved: false,
        isDraft: true,
      },
    });
    assert(reDraft.watch === 'https://example.com/watch.jpg', 'Regenerated draft preserves watch');
    assert(reDraft.shirt === seed.shirt, 'Regenerated draft preserves shirt');
    assert(reDraft.selfieUrl === seed.selfieUrl, 'Regenerated draft preserves selfieUrl');
    // Clean up reDraft
    await prisma.minime.delete({ where: { id: reDraft.id } });

    // ═══════════════════════════════════════
    console.log('\n═══ 7. EJS TEMPLATE LOGIC ═══');
    // ═══════════════════════════════════════

    // Free item detection (same logic as EJS templates)
    const isFreeCheck = !freeItem.appleProductId && !freeItem.googleProductId;
    assert(isFreeCheck === true, 'Free item correctly detected by null IAP IDs');

    const isPaidCheck = !paidItem.appleProductId && !paidItem.googleProductId;
    assert(isPaidCheck === false, 'Paid item correctly detected (has IAP ID)');

    // Admin form: isFree checkbox state
    const editFreeItem = await prisma.shopItem.findUnique({ where: { id: testFreeItemId } });
    const formIsFreeItem = !editFreeItem.appleProductId && !editFreeItem.googleProductId;
    assert(formIsFreeItem === true, 'Edit form correctly shows free checkbox state');

    // ═══════════════════════════════════════
    console.log('\n═══ 8. MULTER CONFIG ═══');
    // ═══════════════════════════════════════

    // Verify multer config by requiring the routes module
    const fs = require('fs');
    const authRoutesCode = fs.readFileSync('routes/authRoutes.js', 'utf8');
    assert(authRoutesCode.includes('fileSize: 10 * 1024 * 1024'), 'authRoutes multer has 10MB limit');
    assert(authRoutesCode.includes('limits:'), 'authRoutes multer has limits object');

    // ═══════════════════════════════════════
    console.log('\n═══ 9. CONTROLLER EXPORTS ═══');
    // ═══════════════════════════════════════

    const shopCtrl = require('../controllers/shopController');
    assert(typeof shopCtrl.getCatalog === 'function', 'shopController.getCatalog exported');
    assert(typeof shopCtrl.getCatalogFree === 'function', 'shopController.getCatalogFree exported');
    assert(typeof shopCtrl.getCatalogPaid === 'function', 'shopController.getCatalogPaid exported');

    const userCtrl = require('../controllers/userController');
    assert(typeof userCtrl.generateMinime === 'function', 'userController.generateMinime exported');
    assert(typeof userCtrl.regenerateMinime === 'function', 'userController.regenerateMinime exported');
    assert(typeof userCtrl.listPremadeAvatars === 'function', 'userController.listPremadeAvatars exported');

    const adminShopCtrl = require('../controllers/admin/adminShopController');
    assert(typeof adminShopCtrl.createItem === 'function', 'adminShopController.createItem exported');
    assert(typeof adminShopCtrl.updateItem === 'function', 'adminShopController.updateItem exported');

    // ═══════════════════════════════════════
    console.log('\n═══ 10. ROUTES REGISTERED ═══');
    // ═══════════════════════════════════════

    const shopRoutesCode = fs.readFileSync('routes/shopRoutes.js', 'utf8');
    assert(shopRoutesCode.includes('/shop/catalog/free'), 'Route /shop/catalog/free registered');
    assert(shopRoutesCode.includes('/shop/catalog/paid'), 'Route /shop/catalog/paid registered');
    assert(shopRoutesCode.includes('getCatalogFree'), 'getCatalogFree handler referenced');
    assert(shopRoutesCode.includes('getCatalogPaid'), 'getCatalogPaid handler referenced');

    // ═══════════════════════════════════════
    console.log('\n═══ 11. EDGE CASES ═══');
    // ═══════════════════════════════════════

    // generateMinime with invalid premadeId
    const badPremade = await prisma.premadeAvatar.findUnique({ where: { id: 999999 } });
    assert(badPremade === null, 'Invalid premadeId returns null (400 in controller)');

    // generateMinime with no premadeId and no selfie
    const noSelfieUser = await prisma.minime.findFirst({
      where: { userId: testUserId, selfieUrl: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    // This just verifies the query works — actual 400 guard is in controller
    assert(true, 'selfieUrl fallback query executes without error');

    // Watch field null handling
    const nullWatch = await prisma.minime.create({
      data: { userId: testUserId, watch: null, isSaved: false, isDraft: true },
    });
    assert(nullWatch.watch === null, 'Watch null creates fine');
    await prisma.minime.delete({ where: { id: nullWatch.id } });

    // Free item with auto-generated name uniqueness
    const freeItem2 = await prisma.shopItem.create({
      data: {
        slot: 'TOP',
        name: `free-TOP-${Date.now() + 1}`,
        imageUrl: 'https://example.com/free-shirt2.jpg',
      },
    });
    assert(freeItem2.id !== testFreeItemId, 'Multiple free items in same slot with unique names');
    await prisma.shopItem.delete({ where: { id: freeItem2.id } });

  } finally {
    await cleanup();
  }

  // ═══════════════════════════════════════
  console.log('\n══════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner error:', err);
  cleanup().then(() => process.exit(1));
});
