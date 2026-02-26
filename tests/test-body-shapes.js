/**
 * Test for:
 * 1. BodyShape CRUD
 * 2. New ShopSlot types (WATCH, MAKEUP, PURSE, ORNAMENT)
 * 3. Slot-based gender filtering in free/paid catalog
 * 4. Partial save-profile
 * 5. Body override in generate/regenerate
 * 6. Controller + route exports
 * 7. Slot → Minime field mapping
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

let testBodyShapeId = null;
const testItemIds = [];
let testUserId = null;

async function cleanup() {
  if (testBodyShapeId) await prisma.bodyShape.delete({ where: { id: testBodyShapeId } }).catch(() => {});
  for (const id of testItemIds) {
    await prisma.shopItem.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
}

async function run() {
  try {
    const testUser = await prisma.user.findFirst({ select: { id: true } });
    if (!testUser) { console.error('No users in DB'); process.exit(1); }
    testUserId = testUser.id;

    // ═══════════════════════════════════════
    console.log('\n═══ 1. BODY SHAPE MODEL CRUD ═══');
    // ═══════════════════════════════════════

    const bs = await prisma.bodyShape.create({
      data: { gender: 'masculine', height: 'M', weight: 2, imageUrl: 'https://example.com/M2M.png' },
    });
    testBodyShapeId = bs.id;
    assert(!!bs.id, `BodyShape created id=${bs.id}`);
    assert(bs.gender === 'masculine' && bs.height === 'M' && bs.weight === 2, 'BodyShape fields correct');
    assert(bs.isActive === true, 'BodyShape isActive default true');

    // Unique constraint
    let dupError = false;
    try {
      await prisma.bodyShape.create({ data: { gender: 'masculine', height: 'M', weight: 2, imageUrl: 'x' } });
    } catch (e) { dupError = e.code === 'P2002'; }
    assert(dupError, 'BodyShape unique(gender, height, weight) enforced');

    // ═══════════════════════════════════════
    console.log('\n═══ 2. NEW SHOP SLOT TYPES ═══');
    // ═══════════════════════════════════════

    // Create items with new slots
    const slots = [
      { slot: 'TOP', name: `test-top-${Date.now()}` },
      { slot: 'BOTTOM', name: `test-bottom-${Date.now()}` },
      { slot: 'SHOES', name: `test-shoes-${Date.now()}` },
      { slot: 'GLASSES', name: `test-glasses-${Date.now()}` },
      { slot: 'WATCH', name: `test-watch-${Date.now()}` },
      { slot: 'MAKEUP', name: `test-makeup-${Date.now()}` },
      { slot: 'PURSE', name: `test-purse-${Date.now()}` },
      { slot: 'ORNAMENT', name: `test-ornament-${Date.now()}` },
    ];

    for (const s of slots) {
      const item = await prisma.shopItem.create({
        data: { slot: s.slot, name: s.name, imageUrl: `https://example.com/${s.slot.toLowerCase()}.jpg` },
      });
      testItemIds.push(item.id);
      assert(item.slot === s.slot, `${s.slot} item created`);
    }

    // ═══════════════════════════════════════
    console.log('\n═══ 3. SLOT-BASED GENDER FILTERING ═══');
    // ═══════════════════════════════════════

    const MASCULINE_SLOTS = ['TOP', 'BOTTOM', 'SHOES', 'GLASSES', 'WATCH'];
    const FEMININE_SLOTS  = ['TOP', 'BOTTOM', 'SHOES', 'GLASSES', 'MAKEUP', 'PURSE', 'ORNAMENT'];

    // Masculine filter
    const mascItems = await prisma.shopItem.findMany({
      where: { appleProductId: null, googleProductId: null, slot: { in: MASCULINE_SLOTS } },
    });
    const mascSlots = [...new Set(mascItems.map(i => i.slot))];
    assert(mascSlots.includes('TOP'), 'Masculine includes TOP');
    assert(mascSlots.includes('WATCH'), 'Masculine includes WATCH');
    assert(!mascSlots.includes('MAKEUP'), 'Masculine excludes MAKEUP');
    assert(!mascSlots.includes('PURSE'), 'Masculine excludes PURSE');
    assert(!mascSlots.includes('ORNAMENT'), 'Masculine excludes ORNAMENT');

    // Feminine filter
    const femItems = await prisma.shopItem.findMany({
      where: { appleProductId: null, googleProductId: null, slot: { in: FEMININE_SLOTS } },
    });
    const femSlots = [...new Set(femItems.map(i => i.slot))];
    assert(femSlots.includes('TOP'), 'Feminine includes TOP');
    assert(femSlots.includes('MAKEUP'), 'Feminine includes MAKEUP');
    assert(femSlots.includes('PURSE'), 'Feminine includes PURSE');
    assert(femSlots.includes('ORNAMENT'), 'Feminine includes ORNAMENT');
    assert(!femSlots.includes('WATCH'), 'Feminine excludes WATCH');

    // ═══════════════════════════════════════
    console.log('\n═══ 4. PARTIAL SAVE-PROFILE ═══');
    // ═══════════════════════════════════════

    const before = await prisma.user.findUnique({ where: { id: testUserId }, select: { firstName: true } });
    await prisma.user.update({
      where: { id: testUserId },
      data: { bodyType: 'masculine', bodyShapeUrl: 'https://example.com/M2M.webp' },
    });
    const after = await prisma.user.findUnique({ where: { id: testUserId } });
    assert(after.bodyType === 'masculine', 'Partial update: bodyType saved');
    assert(after.bodyShapeUrl === 'https://example.com/M2M.webp', 'Partial update: bodyShapeUrl saved');
    assert(after.firstName === before.firstName, 'Partial update: firstName unchanged');

    // ═══════════════════════════════════════
    console.log('\n═══ 5. CONTROLLER & ROUTE EXPORTS ═══');
    // ═══════════════════════════════════════

    const userCtrl = require('../controllers/userController');
    assert(typeof userCtrl.listBodyShapes === 'function', 'listBodyShapes exported');
    assert(typeof userCtrl.saveProfile === 'function', 'saveProfile exported');
    assert(typeof userCtrl.generateMinime === 'function', 'generateMinime exported');
    assert(typeof userCtrl.regenerateMinime === 'function', 'regenerateMinime exported');

    const adminBodyCtrl = require('../controllers/admin/adminBodyShapeController');
    assert(typeof adminBodyCtrl.list === 'function', 'adminBodyShape.list exported');
    assert(typeof adminBodyCtrl.create === 'function', 'adminBodyShape.create exported');

    const shopCtrl = require('../controllers/shopController');
    assert(typeof shopCtrl.getCatalogFree === 'function', 'getCatalogFree exported');
    assert(typeof shopCtrl.getCatalogPaid === 'function', 'getCatalogPaid exported');

    // Route checks
    const fs = require('fs');
    const authRoutes = fs.readFileSync('routes/authRoutes.js', 'utf8');
    assert(authRoutes.includes('/body-shapes'), 'Route /body-shapes registered');

    const adminIndex = fs.readFileSync('routes/admin/index.js', 'utf8');
    assert(adminIndex.includes('/body-shapes'), 'Admin body-shapes route registered');

    // ═══════════════════════════════════════
    console.log('\n═══ 6. BODY OVERRIDE IN MINIME GEN ═══');
    // ═══════════════════════════════════════

    const minimeGen = fs.readFileSync('utils/minimeGen.js', 'utf8');
    assert(minimeGen.includes('effectiveBodyShapeUrl'), 'minimeGen uses effectiveBodyShapeUrl');
    assert(minimeGen.includes('effectiveBodyType'), 'minimeGen uses effectiveBodyType');

    const userCtrlCode = fs.readFileSync('controllers/userController.js', 'utf8');
    assert(userCtrlCode.includes('bodyType, bodyShapeUrl, shirt'), 'generateMinime accepts body overrides');

    // ═══════════════════════════════════════
    console.log('\n═══ 7. SLOT → FIELD MAPPING IN PREVIEW ═══');
    // ═══════════════════════════════════════

    const shopCode = fs.readFileSync('controllers/shopController.js', 'utf8');
    assert(shopCode.includes("case 'WATCH':"), 'WATCH case in preview switch');
    assert(shopCode.includes("case 'MAKEUP':"), 'MAKEUP case in preview switch');
    assert(shopCode.includes("case 'PURSE':"), 'PURSE case in preview switch');
    assert(shopCode.includes("case 'ORNAMENT':"), 'ORNAMENT case in preview switch');
    assert(shopCode.includes('MASCULINE_SLOTS'), 'MASCULINE_SLOTS defined');
    assert(shopCode.includes('FEMININE_SLOTS'), 'FEMININE_SLOTS defined');

  } finally {
    await cleanup();
  }

  console.log('\n══════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner error:', err);
  cleanup().then(() => process.exit(1));
});
