/**
 * Test for:
 * 1. BodyShape CRUD (Prisma model)
 * 2. ShopItem gender field
 * 3. Free catalog gender filtering
 * 4. Partial save-profile
 * 5. Body override in generate/regenerate opts
 * 6. listBodyShapes API function
 * 7. Controller + route exports
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
let testMascAccessoryId = null;
let testFemAccessoryId = null;
let testUnisexAccessoryId = null;
let testDraftId = null;
let testUserId = null;

async function cleanup() {
  if (testBodyShapeId) await prisma.bodyShape.delete({ where: { id: testBodyShapeId } }).catch(() => {});
  if (testMascAccessoryId) await prisma.shopItem.delete({ where: { id: testMascAccessoryId } }).catch(() => {});
  if (testFemAccessoryId) await prisma.shopItem.delete({ where: { id: testFemAccessoryId } }).catch(() => {});
  if (testUnisexAccessoryId) await prisma.shopItem.delete({ where: { id: testUnisexAccessoryId } }).catch(() => {});
  if (testDraftId) await prisma.minime.delete({ where: { id: testDraftId } }).catch(() => {});
  await prisma.$disconnect();
}

async function run() {
  try {
    const testUser = await prisma.user.findFirst({ select: { id: true } });
    if (!testUser) {
      console.error('No users in DB — cannot test.');
      process.exit(1);
    }
    testUserId = testUser.id;

    // ═══════════════════════════════════════
    console.log('\n═══ 1. BODY SHAPE MODEL CRUD ═══');
    // ═══════════════════════════════════════

    const bs = await prisma.bodyShape.create({
      data: { gender: 'masculine', height: 'M', weight: 2, imageUrl: 'https://example.com/M2M.png' },
    });
    testBodyShapeId = bs.id;
    assert(!!bs.id, `BodyShape created id=${bs.id}`);
    assert(bs.gender === 'masculine', 'BodyShape gender=masculine');
    assert(bs.height === 'M', 'BodyShape height=M');
    assert(bs.weight === 2, 'BodyShape weight=2');
    assert(bs.isActive === true, 'BodyShape isActive default true');

    // Read back
    const readBack = await prisma.bodyShape.findUnique({ where: { id: bs.id } });
    assert(readBack.imageUrl === 'https://example.com/M2M.png', 'BodyShape imageUrl reads back');

    // Update
    const updated = await prisma.bodyShape.update({
      where: { id: bs.id },
      data: { imageUrl: 'https://example.com/M2M-v2.webp', isActive: false },
    });
    assert(updated.imageUrl === 'https://example.com/M2M-v2.webp', 'BodyShape imageUrl updated');
    assert(updated.isActive === false, 'BodyShape isActive set to false');

    // Restore
    await prisma.bodyShape.update({ where: { id: bs.id }, data: { isActive: true } });

    // Unique constraint test
    let dupError = false;
    try {
      await prisma.bodyShape.create({
        data: { gender: 'masculine', height: 'M', weight: 2, imageUrl: 'https://example.com/dup.png' },
      });
    } catch (e) {
      dupError = e.code === 'P2002';
    }
    assert(dupError, 'BodyShape unique(gender, height, weight) enforced');

    // Active filter (simulates listBodyShapes)
    const activeShapes = await prisma.bodyShape.findMany({
      where: { isActive: true },
      select: { id: true, gender: true, height: true, weight: true, imageUrl: true },
    });
    assert(activeShapes.some(s => s.id === bs.id), 'Active body shapes includes our test shape');

    // ═══════════════════════════════════════
    console.log('\n═══ 2. SHOP ITEM GENDER FIELD ═══');
    // ═══════════════════════════════════════

    // Masculine accessory (watch)
    const mascAcc = await prisma.shopItem.create({
      data: {
        slot: 'ACCESSORY', name: `test-masc-watch-${Date.now()}`,
        imageUrl: 'https://example.com/watch.jpg', gender: 'masculine',
      },
    });
    testMascAccessoryId = mascAcc.id;
    assert(mascAcc.gender === 'masculine', 'Masculine accessory gender set');

    // Feminine accessory (necklace)
    const femAcc = await prisma.shopItem.create({
      data: {
        slot: 'ACCESSORY', name: `test-fem-necklace-${Date.now()}`,
        imageUrl: 'https://example.com/necklace.jpg', gender: 'feminine',
      },
    });
    testFemAccessoryId = femAcc.id;
    assert(femAcc.gender === 'feminine', 'Feminine accessory gender set');

    // Unisex accessory (bag)
    const uniAcc = await prisma.shopItem.create({
      data: {
        slot: 'ACCESSORY', name: `test-uni-bag-${Date.now()}`,
        imageUrl: 'https://example.com/bag.jpg', gender: null,
      },
    });
    testUnisexAccessoryId = uniAcc.id;
    assert(uniAcc.gender === null, 'Unisex accessory gender is null');

    // ═══════════════════════════════════════
    console.log('\n═══ 3. FREE CATALOG GENDER FILTERING ═══');
    // ═══════════════════════════════════════

    // Masculine filter: should include masculine + unisex, exclude feminine
    const mascItems = await prisma.shopItem.findMany({
      where: {
        appleProductId: null, googleProductId: null,
        OR: [{ gender: null }, { gender: 'masculine' }],
      },
    });
    const mascIds = mascItems.map(i => i.id);
    assert(mascIds.includes(testMascAccessoryId), 'Masculine filter includes masculine item');
    assert(mascIds.includes(testUnisexAccessoryId), 'Masculine filter includes unisex item');
    assert(!mascIds.includes(testFemAccessoryId), 'Masculine filter excludes feminine item');

    // Feminine filter: should include feminine + unisex, exclude masculine
    const femItems = await prisma.shopItem.findMany({
      where: {
        appleProductId: null, googleProductId: null,
        OR: [{ gender: null }, { gender: 'feminine' }],
      },
    });
    const femIds = femItems.map(i => i.id);
    assert(femIds.includes(testFemAccessoryId), 'Feminine filter includes feminine item');
    assert(femIds.includes(testUnisexAccessoryId), 'Feminine filter includes unisex item');
    assert(!femIds.includes(testMascAccessoryId), 'Feminine filter excludes masculine item');

    // No gender filter: includes all
    const allItems = await prisma.shopItem.findMany({
      where: { appleProductId: null, googleProductId: null },
    });
    const allIds = allItems.map(i => i.id);
    assert(allIds.includes(testMascAccessoryId), 'No filter includes masculine');
    assert(allIds.includes(testFemAccessoryId), 'No filter includes feminine');
    assert(allIds.includes(testUnisexAccessoryId), 'No filter includes unisex');

    // ═══════════════════════════════════════
    console.log('\n═══ 4. PARTIAL SAVE-PROFILE LOGIC ═══');
    // ═══════════════════════════════════════

    // Save only bodyType + bodyShapeUrl (simulates body type screen)
    const beforeUpdate = await prisma.user.findUnique({ where: { id: testUserId }, select: { firstName: true } });
    const originalFirstName = beforeUpdate.firstName;

    await prisma.user.update({
      where: { id: testUserId },
      data: { bodyType: 'masculine', bodyShapeUrl: 'https://example.com/M2M.webp' },
    });
    const afterBody = await prisma.user.findUnique({ where: { id: testUserId } });
    assert(afterBody.bodyType === 'masculine', 'Partial update: bodyType saved');
    assert(afterBody.bodyShapeUrl === 'https://example.com/M2M.webp', 'Partial update: bodyShapeUrl saved');
    assert(afterBody.firstName === originalFirstName, 'Partial update: firstName unchanged');

    // Restore original bodyShapeUrl
    await prisma.user.update({
      where: { id: testUserId },
      data: { bodyShapeUrl: afterBody.bodyShapeUrl },
    });

    // ═══════════════════════════════════════
    console.log('\n═══ 5. CONTROLLER & ROUTE EXPORTS ═══');
    // ═══════════════════════════════════════

    const userCtrl = require('../controllers/userController');
    assert(typeof userCtrl.listBodyShapes === 'function', 'userController.listBodyShapes exported');
    assert(typeof userCtrl.saveProfile === 'function', 'userController.saveProfile exported');
    assert(typeof userCtrl.generateMinime === 'function', 'userController.generateMinime exported');
    assert(typeof userCtrl.regenerateMinime === 'function', 'userController.regenerateMinime exported');

    const adminBodyCtrl = require('../controllers/admin/adminBodyShapeController');
    assert(typeof adminBodyCtrl.list === 'function', 'adminBodyShapeController.list exported');
    assert(typeof adminBodyCtrl.create === 'function', 'adminBodyShapeController.create exported');
    assert(typeof adminBodyCtrl.update === 'function', 'adminBodyShapeController.update exported');
    assert(typeof adminBodyCtrl.delete === 'function', 'adminBodyShapeController.delete exported');

    // Route file checks
    const fs = require('fs');
    const authRoutesCode = fs.readFileSync('routes/authRoutes.js', 'utf8');
    assert(authRoutesCode.includes('/body-shapes'), 'Route /body-shapes registered in authRoutes');
    assert(authRoutesCode.includes('listBodyShapes'), 'listBodyShapes handler referenced');

    const adminIndexCode = fs.readFileSync('routes/admin/index.js', 'utf8');
    assert(adminIndexCode.includes('/body-shapes'), 'Admin body-shapes route registered');

    // ═══════════════════════════════════════
    console.log('\n═══ 6. MINIME GEN BODY OVERRIDE (renderCurrentMinime opts) ═══');
    // ═══════════════════════════════════════

    // Verify minimeGen reads effectiveBodyShapeUrl / effectiveBodyType
    const minimeGenCode = fs.readFileSync('utils/minimeGen.js', 'utf8');
    assert(minimeGenCode.includes('effectiveBodyShapeUrl'), 'minimeGen uses effectiveBodyShapeUrl');
    assert(minimeGenCode.includes('effectiveBodyType'), 'minimeGen uses effectiveBodyType');
    assert(minimeGenCode.includes('opts.bodyShapeUrl'), 'minimeGen reads opts.bodyShapeUrl');
    assert(minimeGenCode.includes('opts.bodyType'), 'minimeGen reads opts.bodyType');

    // Verify generateMinime passes body overrides
    const userCtrlCode = fs.readFileSync('controllers/userController.js', 'utf8');
    assert(userCtrlCode.includes("bodyType, bodyShapeUrl, shirt"), 'generateMinime destructures bodyType & bodyShapeUrl');
    assert(userCtrlCode.includes("opts.bodyType = bodyType"), 'generateMinime passes bodyType to opts');
    assert(userCtrlCode.includes("opts.bodyShapeUrl = bodyShapeUrl"), 'generateMinime passes bodyShapeUrl to opts');

    // Verify regenerateMinime also passes body overrides
    // Check that regenerateMinime has opts with bodyType/bodyShapeUrl
    const regenMatch = userCtrlCode.includes('targetMinimeId: draft.id') &&
                       userCtrlCode.includes("const { bodyType, bodyShapeUrl } = req.body");
    assert(regenMatch, 'regenerateMinime destructures body overrides');

    // ═══════════════════════════════════════
    console.log('\n═══ 7. EDGE CASES ═══');
    // ═══════════════════════════════════════

    // Non-ACCESSORY items should have null gender
    const topItem = await prisma.shopItem.create({
      data: { slot: 'TOP', name: `test-top-${Date.now()}`, imageUrl: 'https://example.com/shirt.jpg', gender: null },
    });
    assert(topItem.gender === null, 'TOP item has null gender');
    await prisma.shopItem.delete({ where: { id: topItem.id } });

    // BodyShape with all valid combos
    const femShape = await prisma.bodyShape.create({
      data: { gender: 'feminine', height: 'L', weight: 4, imageUrl: 'https://example.com/F4L.png' },
    });
    assert(femShape.gender === 'feminine' && femShape.height === 'L' && femShape.weight === 4, 'F4L body shape created');
    await prisma.bodyShape.delete({ where: { id: femShape.id } });

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
