const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { verifyApple, verifyGoogle } = require('../utils/iapVerify');
const { applyClothingToCurrentMinime } = require('../utils/minimeLoadout');
const { addPointsWithMultiplier } = require('../utils/points'); // used elsewhere too

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
  const { platform, productId, receipt, type, itemId, applyNow } = req.body;

  try {
    let verified;
    if (platform === 'apple') {
      verified = await verifyApple(receipt, productId);
    } else if (platform === 'google') {
      verified = await verifyGoogle(receipt, productId);
    } else {
      return res.status(400).json({ success: false, message: 'Unknown platform' });
    }
    if (!verified.ok) {
      return res.status(400).json({ success: false, message: 'Receipt invalid', detail: verified.message });
    }

    if (type === 'multiplier') {
      const mp = await prisma.multiplierProduct.findUnique({ where: { productId } });
      if (!mp) return res.status(404).json({ success: false, message: 'Product not found' });

      const now = new Date();
      const endsAt = new Date(now.getTime() + mp.hours * 3600 * 1000);

      // idempotency by receiptTxId
      const existing = await prisma.activeMultiplier.findUnique({
        where: { userId_receiptTxId: { userId, receiptTxId: verified.transactionId } },
      }).catch(() => null);

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
if (type === 'item') {
  const item = await prisma.shopItem.findUnique({ where: { id: Number(itemId) } });
  if (!item) return res.status(404).json({ success: false, message: 'Item not found' });

  const inv = await prisma.userInventory.upsert({
    where: { userId_itemId: { userId, itemId: item.id } },
    update: {},
    create: { userId, itemId: item.id, equipped: false },
  });

  let minime = null;

  if (applyNow) {
    await applyClothingToCurrentMinime(userId, item);
    await prisma.userInventory.update({ where: { id: inv.id }, data: { equipped: true } });

    // latest (saved or draft) bring back
    minime = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
  }

  return res.json({
    success: true,
    message: 'Item granted',
    data: { inventory: inv, minime } // <-- MiniMe included
  });
}

    res.status(400).json({ success: false, message: 'Unknown purchase type' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'IAP confirm failed', error: e.message });
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

    // Apply to current MiniMe (creates/updates latest draft)
    await applyClothingToCurrentMinime(userId, inv.item);

    // Get latest mini (draft or saved)
    let minime = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    // optional: auto-save if client asked
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

// ---------- POINT BUNDLES ----------
exports.listPointBundles = async (_req, res) => {
  try {
    const rows = await prisma.pointBundleProduct.findMany({
      where: { isActive: true },
      orderBy: [{ points: 'asc' }],
      select: { productId: true, points: true, priceUsd: true }
    });
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load point bundles', error: e.message });
  }
};

/**
 * POST /shop/bundles/purchase
 * body: { productId: string, receiptTxId?: string }
 * → ক্রেডিট দেয় + ledger log + purchase log
 */
exports.purchasePointBundle = async (req, res) => {
  const userId = req.authData.id;
  const { productId, receiptTxId } = req.body || {};
  if (!productId) return res.status(400).json({ success: false, message: 'productId required' });

  try {
    const bundle = await prisma.pointBundleProduct.findUnique({ where: { productId } });
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
