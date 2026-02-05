const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { verifyApple, verifyGoogle } = require('../utils/iapVerify');
const { applyClothingToCurrentMinime } = require('../utils/minimeLoadout');
const { renderCurrentMinime } = require('../utils/minimeGen');
const VALID_SLOTS = ['TOP','BOTTOM','SHOES','GLASSES','ACCESSORY'];


exports.previewCustomOutfit = async (req, res) => {
  const userId = req.authData.id;
  const { slot, imageUrl, name, payload } = req.body || {};

  if (!VALID_SLOTS.includes(slot)) {
    return res.status(400).json({ success: false, message: 'Invalid slot' });
  }
  if (!imageUrl || !imageUrl.startsWith('http')) {
    return res.status(400).json({ success: false, message: 'Valid imageUrl required' });
  }

  let mm = await prisma.minime.findFirst({
    where: { userId, isDraft: true, isSaved: false },
    orderBy: { createdAt: 'desc' },
  });
  if (!mm) {
    
    const saved = await prisma.minime.findFirst({
      where: { userId, isSaved: true },
      orderBy: { createdAt: 'desc' },
    });
    const base = saved ? {
      shirt: saved.shirt,
      pant: saved.pant,
      shoes: saved.shoes,
      glasses: saved.glasses,
      lipstick: saved.lipstick,
      jewelry: saved.jewelry,
      bag: saved.bag,
      selfieUrl: saved.selfieUrl ?? null,
    } : {};
    mm = await prisma.minime.create({
      data: { userId, ...base, isSaved: false, isDraft: true },
    });
  }

  // Store imageUrl for image reference in AI generation
  // Priority: payload > imageUrl > name > fallback
  const data = {};
  switch (slot) {
    case 'TOP':       data.shirt   = payload?.shirt   || imageUrl || name || 'Custom Top'; break;
    case 'BOTTOM':    data.pant    = payload?.pant    || imageUrl || name || 'Custom Bottom'; break;
    case 'SHOES':     data.shoes   = payload?.shoes   || imageUrl || name || 'Custom Shoes'; break;
    case 'GLASSES':   data.glasses = payload?.glasses || imageUrl || name || 'Custom Glasses'; break;
case 'ACCESSORY': {
  if (payload?.bag) {
    data.bag = payload.bag;
  }
  else if (payload?.watch) {
    data.watch = payload.watch;
  }
  else if (payload?.jewelry) {
    data.jewelry = payload.jewelry;
  }
  else {
    data.jewelry = imageUrl || name || 'Custom Accessory';
  }
  break;
}

  }

  await prisma.minime.update({ where: { id: mm.id }, data });

  // ✅ রেন্ডার কলে টার্গেট মিনিমে আইডি পাঠাও—saved কখনো স্পর্শ হবে না
  try {
    const rendered = await renderCurrentMinime(userId, { targetMinimeId: mm.id });
    return res.json({
      success: true,
      message: 'Preview applied & rendered',
      data: { minime: rendered },
    });
  } catch (e) {
    console.error('preview render error:', e);
    const latest = await prisma.minime.findUnique({ where: { id: mm.id } });
    return res.json({
      success: true,
      message: 'Preview applied (render failed; showing draft fields)',
      data: { minime: latest },
      error: e.message,
    });
  }
};
exports.quickBuyFromPreview = async (req, res) => {
  const userId = req.authData.id;
  const {
    slot,
    name,               
    brand,            
    priceUsd = '3.00',  
    equip = true       
  } = req.body || {};

  try {
    if (!VALID_SLOTS.includes(slot)) {
      return res.status(400).json({ success: false, message: 'Invalid slot' });
    }

    const mm = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
    if (!mm) {
      return res.status(400).json({ success: false, message: 'No preview/draft found. Call /shop/custom/preview first.' });
    }

    let valueUrlOrName = null;
    let payload = {};
    switch (slot) {
      case 'TOP':
        valueUrlOrName = mm.shirt;
        payload = { shirt: mm.shirt };
        break;
      case 'BOTTOM':
        valueUrlOrName = mm.pant;
        payload = { pant: mm.pant };
        break;
      case 'SHOES':
        valueUrlOrName = mm.shoes;
        payload = { shoes: mm.shoes };
        break;
      case 'GLASSES':
        valueUrlOrName = mm.glasses;
        payload = { glasses: mm.glasses };
        break;
      case 'ACCESSORY':
        // priority: bag -> watch(jewelry) -> jewelry (string/url)
        if (mm.bag)        { valueUrlOrName = mm.bag;        payload = { bag: mm.bag }; }
        else if (mm.jewelry && typeof mm.jewelry === 'string' && mm.jewelry.startsWith('http')) {
          // watch বা generic image-url jewelry
          valueUrlOrName = mm.jewelry;
          payload = { watch: mm.jewelry }; // wrist jewelry হিসেবে রাখলাম
        } else if (mm.jewelry) {
          valueUrlOrName = mm.jewelry;
          payload = { jewelry: mm.jewelry };
        }
        break;
    }

    if (!valueUrlOrName) {
      return res.status(400).json({ success: false, message: `Nothing to buy for slot ${slot}. Did you preview it first?` });
    }

   
    let item = null;
    if (typeof valueUrlOrName === 'string' && valueUrlOrName.startsWith('http')) {
      item = await prisma.shopItem.findFirst({
        where: { slot, imageUrl: valueUrlOrName }
      });
    }
    if (!item) {
  
      const safeName = (name && String(name).trim())
        ? name.trim()
        : (

            (typeof valueUrlOrName === 'string' && valueUrlOrName.startsWith('http'))
              ? `Custom ${slot} ${valueUrlOrName.split('/').pop()?.split('?')[0] || Date.now()}`
              : `Custom ${slot} ${Date.now()}`
          );

   
      const existed = await prisma.shopItem.findFirst({ where: { slot, name: safeName } });
      item = existed || await prisma.shopItem.create({
        data: {
          slot,
          name: safeName,
          brand: brand || 'Custom',
          imageUrl: (typeof valueUrlOrName === 'string' && valueUrlOrName.startsWith('http')) ? valueUrlOrName : '',
          priceUsd,
          payload,
          isFeatured: false
        }
      });
    }

    const inv = await prisma.userInventory.upsert({
      where: { userId_itemId: { userId, itemId: item.id } },
      update: {},
      create: { userId, itemId: item.id, equipped: false }
    });

    let minime = mm;
    if (equip) {

      const owned = await prisma.userInventory.findMany({ where: { userId }, include: { item: true } });
      const toUnequip = owned.filter(r => r.item.slot === slot && r.equipped && r.itemId !== item.id);
      for (const r of toUnequip) {
        await prisma.userInventory.update({ where: { id: r.id }, data: { equipped: false } });
      }
      await prisma.userInventory.update({ where: { id: inv.id }, data: { equipped: true } });

      // MiniMe তে apply (fields already set in preview, তবু নিশ্চিত করি)
      await applyClothingToCurrentMinime(userId, item);
      minime = await prisma.minime.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    }

    return res.json({
      success: true,
      message: 'Purchased from preview',
      data: {
        item,
        inventory: { ...inv, equipped: !!equip },
        minime
      }
    });
  } catch (e) {
    console.error('quickBuyFromPreview error:', e);
    return res.status(500).json({ success: false, message: 'Quick buy failed', error: e.message });
  }
};

const toInt = (v) => Number.parseInt(v, 10);

exports.listClothing = async (req, res) => {
  try {
    const { slot, q, page = 1, pageSize = 12 } = req.query;
    const where = {
      ...(slot ? { slot } : {}),
      ...(q ? { OR: [{ name: { contains: q } }, { brand: { contains: q } }] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.shopItem.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: toInt(pageSize),
        orderBy: [{ isFeatured: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.shopItem.count({ where }),
    ]);
    res.json({ success: true, data: { items, total, page: toInt(page), pageSize: toInt(pageSize) } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to list clothing', error: e.message });
  }
};

exports.listFeatured = async (_req, res) => {
  const items = await prisma.shopItem.findMany({ where: { isFeatured: true }, take: 12 });
  res.json({ success: true, data: items });
};
// controllers/shopController.js
exports.getWardrobeInventory = async (req, res) => {
  try {
    const userId = req.authData.id;

    const rows = await prisma.userInventory.findMany({
      where: { userId },
      include: { item: true },
      orderBy: { acquiredAt: "desc" },
    });

    // ✅ flat (slot flattened)
    const flat = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      itemId: r.itemId,
      equipped: r.equipped,
      acquiredAt: r.acquiredAt,

      // 👇 NEW top-level slot
      slot: r.item?.slot || "UNKNOWN",

      // keep item
      item: r.item,
    }));

    // ✅ grouped by slot (each row contains slot too)
    const grouped = flat.reduce((acc, r) => {
      const slot = r.slot || "UNKNOWN";
      if (!acc[slot]) acc[slot] = [];
      acc[slot].push(r);
      return acc;
    }, {});

    // ✅ quick helper: equipped item per slot
    const equippedBySlot = Object.keys(grouped).reduce((acc, slot) => {
      acc[slot] = grouped[slot].find((x) => x.equipped) || null;
      return acc;
    }, {});

    return res.json({
      success: true,
      data: {
        totalOwned: flat.length,
        grouped,
        flat,
        equippedBySlot,
      },
    });
  } catch (e) {
    console.error("getWardrobeInventory error:", e);
    return res.status(500).json({
      success: false,
      message: "Failed to load wardrobe",
      error: e.message,
    });
  }
};

exports.getInventory = async (req, res) => {
  const userId = req.authData.id;
  const inv = await prisma.userInventory.findMany({
    where: { userId },
    include: { item: true },
    orderBy: { acquiredAt: 'desc' },
  });
  res.json({ success: true, data: inv });
};

exports.listMultipliers = async (_req, res) => {
  const rows = await prisma.multiplierProduct.findMany({ orderBy: [{ hours: 'asc' }, { factor: 'asc' }] });
  res.json({ success: true, data: rows });
};

exports.getActiveMultiplier = async (req, res) => {
  const userId = req.authData.id;
  const now = new Date();
  const row = await prisma.activeMultiplier.findFirst({
    where: { userId, endsAt: { gt: now } },
    orderBy: { endsAt: 'desc' },
  });
  res.json({ success: true, data: row || null });
};

/**
 * Confirm IAP and grant entitlement.
 * Body: { platform: 'apple'|'google', productId: string, receipt: string, type: 'multiplier'|'item', itemId?: number, applyNow?: boolean }
 */
exports.confirmIAPPurchase = async (req, res) => {
  const userId = req.authData.id;

  // ✅ slot added (optional)
  const { platform, productId, receipt, type, itemId, applyNow, slot } = req.body || {};

  try {
    // ------------------ Basic validations ------------------
    if (!platform || !productId || !receipt || !type) {
      return res.status(400).json({
        success: false,
        message: 'platform, productId, receipt, type are required',
      });
    }

    // ✅ slot validate (if provided)
    if (slot && !VALID_SLOTS.includes(slot)) {
      return res.status(400).json({ success: false, message: 'Invalid slot' });
    }

    // ------------------ Verify receipt ------------------
    let verified;
    if (platform === 'apple') {
      verified = await verifyApple(receipt, productId);
    } else if (platform === 'google') {
      verified = await verifyGoogle(receipt, productId);
    } else {
      return res.status(400).json({ success: false, message: 'Unknown platform' });
    }

    if (!verified?.ok) {
      return res.status(400).json({
        success: false,
        message: 'Receipt invalid',
        detail: verified?.message || 'Verification failed',
      });
    }

    // ------------------ MULTIPLIER ------------------
    if (type === 'multiplier') {
      // Platform-specific lookup with legacy fallback
      let mp = null;
      if (platform === 'apple') {
        mp = await prisma.multiplierProduct.findUnique({ where: { appleProductId: productId } });
      } else if (platform === 'google') {
        mp = await prisma.multiplierProduct.findUnique({ where: { googleProductId: productId } });
      }
      if (!mp) {
        mp = await prisma.multiplierProduct.findUnique({ where: { productId } });
      }
      if (!mp) return res.status(404).json({ success: false, message: 'Product not found' });

      const now = new Date();
      const endsAt = new Date(now.getTime() + mp.hours * 3600 * 1000);

      // ✅ idempotency by receiptTxId
      const existing = await prisma.activeMultiplier
        .findUnique({
          where: { userId_receiptTxId: { userId, receiptTxId: verified.transactionId } },
        })
        .catch(() => null);

      if (existing) {
        return res.json({ success: true, message: 'Already granted', data: existing });
      }

      const grant = await prisma.activeMultiplier.create({
        data: {
          userId,
          factor: mp.factor,
          startedAt: now,
          endsAt,
          source: 'IAP',
          productId: mp.productId,
          receiptTxId: verified.transactionId,
        },
      });

      return res.json({ success: true, message: 'Multiplier activated', data: grant });
    }

    // ------------------ ITEM ------------------
    if (type === 'item') {
      if (!itemId) {
        return res.status(400).json({ success: false, message: 'itemId required for item purchase' });
      }

      const item = await prisma.shopItem.findUnique({ where: { id: Number(itemId) } });
      if (!item) return res.status(404).json({ success: false, message: 'Item not found' });

      // ✅ slot mismatch guard (only when client sends slot)
      if (slot && item.slot !== slot) {
        return res.status(400).json({
          success: false,
          message: `Slot mismatch. item.slot=${item.slot} but body.slot=${slot}`,
        });
      }

      // ✅ add to inventory (idempotent)
      const inv = await prisma.userInventory.upsert({
        where: { userId_itemId: { userId, itemId: item.id } },
        update: {},
        create: { userId, itemId: item.id, equipped: false },
      });

      console.log('✅ Item granted to inventory:', { userId, itemId: item.id, invId: inv.id });

      let minime = null;

      // ✅ applyNow = equip + apply to minime
      if (String(applyNow).toLowerCase() === 'true' || applyNow === true) {
        // 1) apply in minime (creates draft if missing)
        await applyClothingToCurrentMinime(userId, item);

        // 2) unequip others in same slot (recommended)
        await prisma.userInventory.updateMany({
          where: {
            userId,
            equipped: true,
            item: { slot: item.slot },
            NOT: { itemId: item.id },
          },
          data: { equipped: false },
        });

        // 3) equip this one
        await prisma.userInventory.update({
          where: { id: inv.id },
          data: { equipped: true },
        });

        // 4) latest minime (saved/draft যেটাই latest)
        minime = await prisma.minime.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
        });
      }

      // ✅ wardrobe return (inventory list)
      const wardrobe = await prisma.userInventory.findMany({
        where: { userId },
        include: { item: true },
        orderBy: { acquiredAt: 'desc' },
      });

      return res.json({
        success: true,
        message: 'Item granted',
        data: {
          item,
          inventory: inv,
          minime,
          wardrobeCount: wardrobe.length,
          wardrobe,
        },
      });
    }

    // ------------------ Unknown type ------------------
    return res.status(400).json({ success: false, message: 'Unknown purchase type' });
  } catch (e) {
    console.error('confirmIAPPurchase error:', e);
    return res.status(500).json({ success: false, message: 'IAP confirm failed', error: e.message });
  }
};

exports.equipItem = async (req, res) => {
  const userId = req.authData.id;
  const { itemId, save } = req.body; // optional: save=true দিলে draft auto-save করবে
  try {
    const inv = await prisma.userInventory.findFirst({
      where: { userId, itemId: Number(itemId) },
      include: { item: true }
    });
    if (!inv) return res.status(404).json({ success: false, message: 'Item not in inventory' });

    // Unequip others in same slot
    const slot = inv.item.slot;
    const ownedSlotItems = await prisma.userInventory.findMany({
      where: { userId },
      include: { item: true },
    });
    const toUnequip = ownedSlotItems.filter(r => r.item.slot === slot && r.equipped && r.itemId !== inv.itemId);
    for (const r of toUnequip) {
      await prisma.userInventory.update({ where: { id: r.id }, data: { equipped: false } });
    }

    await prisma.userInventory.update({ where: { id: inv.id }, data: { equipped: true } });

    
    await applyClothingToCurrentMinime(userId, inv.item);

    let minime = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    
    if (save && minime && minime.isDraft) {
      await prisma.minime.update({ where: { id: minime.id }, data: { isSaved: true, isDraft: false } });
      minime = await prisma.minime.findUnique({ where: { id: minime.id } });
    }

    res.json({
      success: true,
      message: 'Equipped',
      data: { itemId: inv.itemId, slot, minime } // <-- MiniMe included
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Equip failed', error: e.message });
  }
};

exports.listPointBundles = async (_req, res) => {
  try {
    const rows = await prisma.pointBundleProduct.findMany({
      where: { isActive: true },
      orderBy: [{ points: 'asc' }],
      select: { productId: true, points: true, appleProductId: true, googleProductId: true }
    });
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load point bundles', error: e.message });
  }
};


exports.purchasePointBundle = async (req, res) => {
  const userId = req.authData.id;
  const { productId, receiptTxId, platform } = req.body || {};
  if (!productId) return res.status(400).json({ success: false, message: 'productId required' });

  try {
    // Platform-specific lookup with legacy fallback
    let bundle = null;
    if (platform === 'apple') {
      bundle = await prisma.pointBundleProduct.findUnique({ where: { appleProductId: productId } });
    } else if (platform === 'google') {
      bundle = await prisma.pointBundleProduct.findUnique({ where: { googleProductId: productId } });
    }
    if (!bundle) {
      bundle = await prisma.pointBundleProduct.findUnique({ where: { productId } });
    }
    if (!bundle || !bundle.isActive) {
      return res.status(404).json({ success: false, message: 'Bundle not found' });
    }

    // Optional idempotency
    if (receiptTxId) {
      const dup = await prisma.pointBundlePurchase.findUnique({ where: { receiptTxId } }).catch(() => null);
      if (dup) {
        return res.json({ success: true, message: 'Already processed', data: { totalPoints: undefined } });
      }
    }

    const newTotal = await prisma.$transaction(async (tx) => {
      // 1) purchase log
      await tx.pointBundlePurchase.create({
        data: {
          userId,
          productId: bundle.productId,
          points: bundle.points,
          priceUsd: bundle.priceUsd,
          receiptTxId: receiptTxId || null
        }
      });

      // 2) ledger entry
      await tx.pointsLedger.create({
        data: {
          userId,
          basePoints: bundle.points,
          appliedMultiplier: 1,
          finalPoints: bundle.points,
          reason: 'POINT_BUNDLE',
          refId: null
        }
      });

      // 3) denorm user.totalPoints
      const u = await tx.user.update({
        where: { id: userId },
        data: { totalPoints: { increment: bundle.points } },
        select: { totalPoints: true }
      });

      return u.totalPoints;
    });

    return res.json({
      success: true,
      message: `+${bundle.points} points credited`,
      data: {
        productId: bundle.productId,
        pointsCredited: bundle.points,
        totalPoints: newTotal
      }
    });
  } catch (e) {
    if (e.code === 'P2002' && e.meta?.target?.includes('receiptTxId')) {
      return res.json({ success: true, message: 'Already processed (duplicate receipt)', data: {} });
    }
    res.status(500).json({ success: false, message: 'Purchase failed', error: e.message });
  }
};

exports.getCatalog = async (_req, res) => {
  try {
    const items = await prisma.shopItem.findMany({
      orderBy: [{ isFeatured: 'desc' }, { slot: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        slot: true,
        name: true,
        brand: true,
        imageUrl: true,
        isFeatured: true,
        appleProductId: true,
        googleProductId: true,
      },
    });

    const grouped = items.reduce((acc, item) => {
      if (!acc[item.slot]) acc[item.slot] = [];
      acc[item.slot].push(item);
      return acc;
    }, {});

    res.json({ success: true, data: { items, grouped, total: items.length } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load catalog', error: e.message });
  }
};
