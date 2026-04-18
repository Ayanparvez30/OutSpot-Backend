#!/usr/bin/env node
/**
 * Test for shop gender separation.
 * - Validates admin controller GENDER_SLOTS mapping
 * - Creates masculine/feminine items via Prisma
 * - Calls catalog controllers directly with mocked req/res
 * - Asserts only matching gender items returned
 * - Wardrobe returns purchased items regardless of gender
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const shop = require('../controllers/shopController');
const prisma = new PrismaClient();

const TS = Date.now();
const TAG = `__TEST_GENDER_${TS}`;
let passed = 0, failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const created = { items: [], users: [], inv: [] };

async function setup() {
  console.log('\n--- Setup: creating test items ---');
  const items = [
    { slot: 'TOP',      gender: 'masculine', name: `${TAG}_m_top_free`,    iap: false },
    { slot: 'WATCH',    gender: 'masculine', name: `${TAG}_m_watch_paid`,  iap: true  },
    { slot: 'TOP',      gender: 'feminine',  name: `${TAG}_f_top_free`,    iap: false },
    { slot: 'PURSE',    gender: 'feminine',  name: `${TAG}_f_bag_paid`,    iap: true  },
    { slot: 'ORNAMENT', gender: 'feminine',  name: `${TAG}_f_necklace`,    iap: false },
    { slot: 'MAKEUP',   gender: 'feminine',  name: `${TAG}_f_lipstick`,    iap: true  },
  ];
  for (const it of items) {
    const row = await prisma.shopItem.create({
      data: {
        slot: it.slot,
        gender: it.gender,
        name: it.name,
        brand: 'TestBrand',
        imageUrl: 'https://example.com/x.png',
        priceUsd: 1.99,
        isFeatured: false,
        appleProductId: it.iap ? `${TAG}.a.${it.name}` : null,
        googleProductId: it.iap ? `${TAG}.g.${it.name}` : null,
      },
    });
    created.items.push(row);
  }
  console.log(`  Created ${created.items.length} shop items`);
}

async function cleanup() {
  console.log('\n--- Cleanup ---');
  try {
    if (created.inv.length) {
      await prisma.userInventory.deleteMany({ where: { id: { in: created.inv } } });
    }
    if (created.items.length) {
      await prisma.shopItem.deleteMany({ where: { id: { in: created.items.map(i => i.id) } } });
    }
    if (created.users.length) {
      await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    }
    console.log('  Done.');
  } catch (e) {
    console.error('  Cleanup error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

async function testCatalogRequiresGender() {
  console.log('\n== getCatalog / getCatalogFree / getCatalogPaid require gender ==');
  for (const fn of [shop.getCatalog, shop.getCatalogFree, shop.getCatalogPaid]) {
    const res = mockRes();
    await fn({ query: {} }, res);
    assert(res.statusCode === 400, `${fn.name}: 400 when gender missing`);
    assert(res.body?.success === false, `${fn.name}: success=false`);

    const res2 = mockRes();
    await fn({ query: { gender: 'other' } }, res2);
    assert(res2.statusCode === 400, `${fn.name}: 400 when gender invalid`);
  }
}

async function testCatalogFreeMasculine() {
  console.log('\n== getCatalogFree ?gender=masculine ==');
  const res = mockRes();
  await shop.getCatalogFree({ query: { gender: 'masculine' } }, res);
  assert(res.body?.success === true, 'success=true');

  const grouped = res.body?.data?.grouped || {};
  const allFlat = Object.values(grouped).flat();
  const tagRows = allFlat.filter(i => created.items.find(c => c.id === i.id));
  assert(tagRows.length === 1, `Exactly 1 test masculine free item (got ${tagRows.length})`);
  assert(tagRows[0]?.slot === 'TOP', 'Returned item slot=TOP');
  assert(tagRows[0]?.gender === 'masculine', 'Returned item gender=masculine');
  // No feminine items in masculine response
  const feminineLeak = tagRows.some(i => {
    const src = created.items.find(c => c.id === i.id);
    return src?.gender === 'feminine';
  });
  assert(!feminineLeak, 'No feminine items leak into masculine catalog');
}

async function testCatalogFreeFeminine() {
  console.log('\n== getCatalogFree ?gender=feminine ==');
  const res = mockRes();
  await shop.getCatalogFree({ query: { gender: 'feminine' } }, res);
  assert(res.body?.success === true, 'success=true');

  const grouped = res.body?.data?.grouped || {};
  const allFlat = Object.values(grouped).flat();
  const tagRows = allFlat.filter(i => created.items.find(c => c.id === i.id));
  // Feminine free items: f_top_free, f_necklace → 2
  assert(tagRows.length === 2, `Exactly 2 test feminine free items (got ${tagRows.length})`);
  const slots = new Set(tagRows.map(r => r.slot));
  assert(slots.has('TOP') && slots.has('ORNAMENT'), 'Slots include TOP and ORNAMENT');
  assert(tagRows.every(r => r.gender === 'feminine'), 'All returned gender=feminine');
}

async function testCatalogPaidMasculine() {
  console.log('\n== getCatalogPaid ?gender=masculine ==');
  const res = mockRes();
  await shop.getCatalogPaid({ query: { gender: 'masculine' } }, res);
  assert(res.body?.success === true, 'success=true');

  const items = res.body?.data?.items || [];
  const tagRows = items.filter(i => created.items.find(c => c.id === i.id));
  assert(tagRows.length === 1, `Exactly 1 test masculine paid item (got ${tagRows.length})`);
  assert(tagRows[0]?.slot === 'WATCH', 'Returned paid item slot=WATCH');
  assert(!!tagRows[0]?.appleProductId, 'Paid item has appleProductId');
}

async function testCatalogPaidFeminine() {
  console.log('\n== getCatalogPaid ?gender=feminine ==');
  const res = mockRes();
  await shop.getCatalogPaid({ query: { gender: 'feminine' } }, res);
  assert(res.body?.success === true, 'success=true');

  const items = res.body?.data?.items || [];
  const tagRows = items.filter(i => created.items.find(c => c.id === i.id));
  // Feminine paid: f_bag_paid, f_lipstick → 2
  assert(tagRows.length === 2, `Exactly 2 test feminine paid items (got ${tagRows.length})`);
  const slots = new Set(tagRows.map(r => r.slot));
  assert(slots.has('PURSE') && slots.has('MAKEUP'), 'Slots include PURSE and MAKEUP');
}

async function testWardrobeIgnoresGender() {
  console.log('\n== getWardrobeInventory ignores gender (ownership wins) ==');
  const bcrypt = require('bcrypt');
  const user = await prisma.user.create({
    data: {
      username: `${TAG}_user`,
      email: `${TAG}@test.com`,
      password: await bcrypt.hash('x', 10),
      isVerified: true,
    },
  });
  created.users.push(user.id);

  // Give user a masculine and a feminine item
  const masc = created.items.find(i => i.gender === 'masculine');
  const fem  = created.items.find(i => i.gender === 'feminine');
  const inv1 = await prisma.userInventory.create({ data: { userId: user.id, itemId: masc.id } });
  const inv2 = await prisma.userInventory.create({ data: { userId: user.id, itemId: fem.id } });
  created.inv.push(inv1.id, inv2.id);

  const res = mockRes();
  await shop.getWardrobeInventory({ authData: { id: user.id } }, res);
  assert(res.body?.success === true, 'wardrobe success=true');
  assert(res.body?.data?.totalOwned === 2, `totalOwned=2 (got ${res.body?.data?.totalOwned})`);
  const hasMasc = res.body?.data?.flat?.some(r => r.itemId === masc.id);
  const hasFem  = res.body?.data?.flat?.some(r => r.itemId === fem.id);
  assert(hasMasc && hasFem, 'Both masculine and feminine owned items returned');
}

async function testAdminGenderSlotMapping() {
  console.log('\n== Admin controller GENDER_SLOTS map ==');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'controllers', 'admin', 'adminShopController.js'), 'utf8');
  assert(src.includes('GENDER_SLOTS'), 'GENDER_SLOTS defined');
  assert(/masculine:\s*\[.*'TOP'.*'BOTTOM'.*'SHOES'.*'GLASSES'.*'WATCH'/s.test(src), 'masculine slots correct');
  assert(/feminine:.*'PURSE'.*'ORNAMENT'.*'MAKEUP'/s.test(src), 'feminine slots include PURSE/ORNAMENT/MAKEUP');
  assert(src.includes('Slot ${slot} is not allowed for ${gender}'), 'slot-gender validation present');
}

async function main() {
  console.log('============================================');
  console.log('  Shop Gender Separation - Test Script');
  console.log('============================================');
  try {
    await setup();
    await testCatalogRequiresGender();
    await testCatalogFreeMasculine();
    await testCatalogFreeFeminine();
    await testCatalogPaidMasculine();
    await testCatalogPaidFeminine();
    await testWardrobeIgnoresGender();
    await testAdminGenderSlotMapping();
  } catch (e) {
    console.error('\nUnexpected error:', e);
    failed++;
  } finally {
    await cleanup();
  }

  console.log('\n============================================');
  console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
  if (failures.length) {
    console.log('\n  Failed:');
    failures.forEach(f => console.log(`    - ${f}`));
  }
  console.log('============================================\n');
  process.exit(failed > 0 ? 1 : 0);
}

main();
