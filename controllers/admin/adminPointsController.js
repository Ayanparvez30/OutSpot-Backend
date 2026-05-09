const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.listMultipliers = async (req, res) => {
  try {
    const products = await prisma.multiplierProduct.findMany({ orderBy: { factor: 'asc' } });
    const activeCount = await prisma.activeMultiplier.count({ where: { endsAt: { gt: new Date() } } });

    res.render('admin/pages/points/multipliers', {
      layout: 'admin/layouts/main',
      title: 'Multiplier Products',
      products, activeCount,
    });
  } catch (error) {
    console.error('List multipliers error:', error);
    req.flash('error', 'Failed to load multipliers.');
    res.redirect('/admin/dashboard');
  }
};

exports.createMultiplierForm = (req, res) => {
  res.render('admin/pages/points/multiplier-form', {
    layout: 'admin/layouts/main',
    title: 'Create Multiplier',
    product: null,
  });
};

exports.createMultiplier = async (req, res) => {
  try {
    const { productId, factor, hours, priceUsd, appleProductId, googleProductId } = req.body;
    if (!productId || !productId.trim()) {
      req.flash('error', 'Product ID (IAP SKU) is required.');
      return res.redirect('/admin/points/multipliers/create');
    }
    await prisma.multiplierProduct.create({
      data: {
        productId: productId.trim(),
        factor: parseFloat(factor),
        hours: parseInt(hours),
        priceUsd: priceUsd && priceUsd.trim() ? parseFloat(priceUsd) : null,
        appleProductId: appleProductId?.trim() || null,
        googleProductId: googleProductId?.trim() || null,
      },
    });
    req.flash('success', 'Multiplier product created.');
    res.redirect('/admin/points/multipliers');
  } catch (error) {
    console.error('Create multiplier error:', error);
    if (error.code === 'P2002') {
      req.flash('error', `A product ID is already in use: ${(error.meta?.target || []).join(', ')}`);
    } else {
      req.flash('error', `Failed to create multiplier: ${error.message}`);
    }
    res.redirect('/admin/points/multipliers/create');
  }
};

exports.editMultiplierForm = async (req, res) => {
  try {
    const product = await prisma.multiplierProduct.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!product) {
      req.flash('error', 'Product not found.');
      return res.redirect('/admin/points/multipliers');
    }
    res.render('admin/pages/points/multiplier-form', {
      layout: 'admin/layouts/main',
      title: `Edit: ${product.productId}`,
      product,
    });
  } catch (error) {
    console.error('Edit multiplier form error:', error);
    req.flash('error', 'Failed to load product.');
    res.redirect('/admin/points/multipliers');
  }
};

exports.updateMultiplier = async (req, res) => {
  try {
    const { productId, factor, hours, priceUsd, appleProductId, googleProductId } = req.body;
    await prisma.multiplierProduct.update({
      where: { id: parseInt(req.params.id) },
      data: {
        productId: productId?.trim(),
        factor: parseFloat(factor),
        hours: parseInt(hours),
        priceUsd: priceUsd && priceUsd.trim() ? parseFloat(priceUsd) : null,
        appleProductId: appleProductId?.trim() || null,
        googleProductId: googleProductId?.trim() || null,
      },
    });
    req.flash('success', 'Multiplier product updated.');
    res.redirect('/admin/points/multipliers');
  } catch (error) {
    console.error('Update multiplier error:', error);
    if (error.code === 'P2002') {
      req.flash('error', `A product ID is already in use: ${(error.meta?.target || []).join(', ')}`);
    } else {
      req.flash('error', `Failed to update multiplier: ${error.message}`);
    }
    res.redirect(`/admin/points/multipliers/${req.params.id}/edit`);
  }
};

exports.viewLedger = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 30;
    const userId = req.query.userId ? parseInt(req.query.userId) : undefined;
    const reason = req.query.reason;

    const where = {};
    if (userId) where.userId = userId;
    if (reason) where.reason = reason;

    const [entries, total] = await Promise.all([
      prisma.pointsLedger.findMany({
        where,
        include: { user: { select: { id: true, username: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.pointsLedger.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const params = new URLSearchParams();
    if (userId) params.set('userId', userId);
    if (reason) params.set('reason', reason);
    const baseUrl = `/admin/points/ledger${params.toString() ? `?${params}` : ''}`;

    res.render('admin/pages/points/ledger', {
      layout: 'admin/layouts/main',
      title: 'Points Ledger',
      entries, total, page, totalPages, baseUrl,
      userId: userId || '', reason: reason || '',
    });
  } catch (error) {
    console.error('View ledger error:', error);
    req.flash('error', 'Failed to load ledger.');
    res.redirect('/admin/dashboard');
  }
};

exports.listBundles = async (req, res) => {
  try {
    const bundles = await prisma.pointBundleProduct.findMany({ orderBy: { points: 'asc' } });
    res.render('admin/pages/points/bundles', {
      layout: 'admin/layouts/main',
      title: 'Point Bundles',
      bundles,
    });
  } catch (error) {
    console.error('List bundles error:', error);
    req.flash('error', 'Failed to load bundles.');
    res.redirect('/admin/dashboard');
  }
};

exports.createBundleForm = (req, res) => {
  res.render('admin/pages/points/bundle-form', {
    layout: 'admin/layouts/main',
    title: 'Create Bundle',
    bundle: null,
  });
};

exports.createBundle = async (req, res) => {
  try {
    const { productId, points, priceUsd, isActive, appleProductId, googleProductId } = req.body;
    if (!productId || !productId.trim()) {
      req.flash('error', 'Product ID is required.');
      return res.redirect('/admin/points/bundles/create');
    }
    await prisma.pointBundleProduct.create({
      data: {
        productId: productId.trim(),
        points: parseInt(points),
        priceUsd: priceUsd && priceUsd.trim() ? parseFloat(priceUsd) : null,
        isActive: isActive === 'on',
        appleProductId: appleProductId?.trim() || null,
        googleProductId: googleProductId?.trim() || null,
      },
    });
    req.flash('success', 'Bundle created.');
    res.redirect('/admin/points/bundles');
  } catch (error) {
    console.error('Create bundle error:', error);
    if (error.code === 'P2002') {
      req.flash('error', `A product ID is already in use: ${(error.meta?.target || []).join(', ')}`);
    } else {
      req.flash('error', `Failed to create bundle: ${error.message}`);
    }
    res.redirect('/admin/points/bundles/create');
  }
};

exports.editBundleForm = async (req, res) => {
  try {
    const bundle = await prisma.pointBundleProduct.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!bundle) {
      req.flash('error', 'Bundle not found.');
      return res.redirect('/admin/points/bundles');
    }
    res.render('admin/pages/points/bundle-form', {
      layout: 'admin/layouts/main',
      title: `Edit: ${bundle.productId}`,
      bundle,
    });
  } catch (error) {
    console.error('Edit bundle form error:', error);
    req.flash('error', 'Failed to load bundle.');
    res.redirect('/admin/points/bundles');
  }
};

exports.updateBundle = async (req, res) => {
  try {
    const { productId, points, priceUsd, isActive, appleProductId, googleProductId } = req.body;
    await prisma.pointBundleProduct.update({
      where: { id: parseInt(req.params.id) },
      data: {
        productId: productId?.trim(),
        points: parseInt(points),
        priceUsd: priceUsd && priceUsd.trim() ? parseFloat(priceUsd) : null,
        isActive: isActive === 'on',
        appleProductId: appleProductId?.trim() || null,
        googleProductId: googleProductId?.trim() || null,
      },
    });
    req.flash('success', 'Bundle updated.');
    res.redirect('/admin/points/bundles');
  } catch (error) {
    console.error('Update bundle error:', error);
    if (error.code === 'P2002') {
      req.flash('error', 'A product ID is already in use.');
    } else {
      req.flash('error', 'Failed to update bundle.');
    }
    res.redirect(`/admin/points/bundles/${req.params.id}/edit`);
  }
};

exports.listPurchases = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 30;

    const [purchases, total] = await Promise.all([
      prisma.pointBundlePurchase.findMany({
        include: { user: { select: { id: true, username: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.pointBundlePurchase.count(),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    res.render('admin/pages/points/purchases', {
      layout: 'admin/layouts/main',
      title: 'Bundle Purchases',
      purchases, total, page, totalPages,
      baseUrl: '/admin/points/purchases',
    });
  } catch (error) {
    console.error('List purchases error:', error);
    req.flash('error', 'Failed to load purchases.');
    res.redirect('/admin/dashboard');
  }
};
