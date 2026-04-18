const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const uploadToS3 = require('../../utils/s3Upload');

const GENDER_SLOTS = {
  masculine: ['TOP', 'BOTTOM', 'SHOES', 'GLASSES', 'WATCH'],
  feminine:  ['TOP', 'BOTTOM', 'SHOES', 'GLASSES', 'WATCH', 'PURSE', 'ORNAMENT', 'MAKEUP'],
};

exports.listItems = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 20;
    const slot = req.query.slot;
    const gender = req.query.gender;
    const search = (req.query.q || '').trim();

    const where = {};
    if (slot) where.slot = slot;
    if (gender === 'masculine' || gender === 'feminine') where.gender = gender;
    if (search) where.OR = [{ name: { contains: search } }, { brand: { contains: search } }];

    const [items, total] = await Promise.all([
      prisma.shopItem.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ isFeatured: 'desc' }, { createdAt: 'desc' }],
        include: { _count: { select: { inventories: true } } },
      }),
      prisma.shopItem.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (slot) params.set('slot', slot);
    if (where.gender) params.set('gender', where.gender);
    const baseUrl = `/admin/shop${params.toString() ? `?${params}` : ''}`;

    res.render('admin/pages/shop/index', {
      layout: 'admin/layouts/main',
      title: 'Shop Items',
      items, total, page, totalPages, baseUrl,
      search, slotFilter: slot || '', genderFilter: where.gender || '',
    });
  } catch (error) {
    console.error('List shop items error:', error);
    req.flash('error', 'Failed to load shop items.');
    res.redirect('/admin/dashboard');
  }
};

exports.createForm = (req, res) => {
  res.render('admin/pages/shop/form', {
    layout: 'admin/layouts/main',
    title: 'Create Shop Item',
    item: null,
  });
};

exports.createItem = async (req, res) => {
  try {
    const { slot, name, brand, imageUrl, isFeatured, isFree, gender, appleProductId, googleProductId } = req.body;
    const free = isFree === 'on';

    if (!gender || !GENDER_SLOTS[gender]) {
      req.flash('error', 'Gender must be masculine or feminine.');
      return res.redirect('/admin/shop/create');
    }
    if (!GENDER_SLOTS[gender].includes(slot)) {
      req.flash('error', `Slot ${slot} is not allowed for ${gender}.`);
      return res.redirect('/admin/shop/create');
    }

    let finalImageUrl = imageUrl || '';
    if (req.file) {
      finalImageUrl = await uploadToS3(req.file, 'shop-items');
    }

    const finalName = free
      ? `free-${slot}-${Date.now()}`
      : (name || 'Untitled');

    await prisma.shopItem.create({
      data: {
        slot,
        name: finalName,
        brand: free ? null : (brand || null),
        imageUrl: finalImageUrl,
        isFeatured: free ? false : (isFeatured === 'on'),
        gender,
        appleProductId: free ? null : (appleProductId || null),
        googleProductId: free ? null : (googleProductId || null),
      },
    });
    req.flash('success', free ? 'Free item created.' : 'Shop item created.');
    res.redirect('/admin/shop');
  } catch (error) {
    console.error('Create shop item error:', error);
    if (error.code === 'P2002') {
      req.flash('error', 'A product ID is already in use by another item.');
    } else {
      req.flash('error', 'Failed to create item.');
    }
    res.redirect('/admin/shop/create');
  }
};

exports.editForm = async (req, res) => {
  try {
    const item = await prisma.shopItem.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!item) {
      req.flash('error', 'Item not found.');
      return res.redirect('/admin/shop');
    }
    res.render('admin/pages/shop/form', {
      layout: 'admin/layouts/main',
      title: `Edit: ${item.name}`,
      item,
    });
  } catch (error) {
    console.error('Edit shop form error:', error);
    req.flash('error', 'Failed to load item.');
    res.redirect('/admin/shop');
  }
};

exports.updateItem = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { slot, name, brand, imageUrl, isFeatured, isFree, gender, appleProductId, googleProductId } = req.body;
    const free = isFree === 'on';

    if (!gender || !GENDER_SLOTS[gender]) {
      req.flash('error', 'Gender must be masculine or feminine.');
      return res.redirect(`/admin/shop/${id}/edit`);
    }
    // allow legacy ACCESSORY rows to keep their slot; all other slots must match gender
    if (slot !== 'ACCESSORY' && !GENDER_SLOTS[gender].includes(slot)) {
      req.flash('error', `Slot ${slot} is not allowed for ${gender}.`);
      return res.redirect(`/admin/shop/${id}/edit`);
    }

    let finalImageUrl;
    if (req.file) {
      finalImageUrl = await uploadToS3(req.file, 'shop-items');
    } else if (imageUrl) {
      finalImageUrl = imageUrl;
    }

    const existing = await prisma.shopItem.findUnique({ where: { id }, select: { name: true } });
    const finalName = free
      ? (existing?.name?.startsWith('free-') ? existing.name : `free-${slot}-${Date.now()}`)
      : (name || 'Untitled');

    await prisma.shopItem.update({
      where: { id },
      data: {
        slot,
        name: finalName,
        brand: free ? null : (brand || null),
        imageUrl: finalImageUrl || undefined,
        isFeatured: free ? false : (isFeatured === 'on'),
        gender,
        appleProductId: free ? null : (appleProductId || null),
        googleProductId: free ? null : (googleProductId || null),
      },
    });
    req.flash('success', 'Item updated.');
    res.redirect('/admin/shop');
  } catch (error) {
    console.error('Update shop item error:', error);
    if (error.code === 'P2002') {
      req.flash('error', 'A product ID is already in use by another item.');
    } else {
      req.flash('error', 'Failed to update item.');
    }
    res.redirect(`/admin/shop/${req.params.id}/edit`);
  }
};

exports.deleteItem = async (req, res) => {
  try {
    await prisma.shopItem.delete({ where: { id: parseInt(req.params.id) } });
    req.flash('success', 'Item deleted.');
    res.redirect('/admin/shop');
  } catch (error) {
    console.error('Delete shop item error:', error);
    req.flash('error', 'Failed to delete item. It may be in user inventories.');
    res.redirect('/admin/shop');
  }
};

exports.toggleFeature = async (req, res) => {
  try {
    const item = await prisma.shopItem.findUnique({ where: { id: parseInt(req.params.id) } });
    await prisma.shopItem.update({
      where: { id: parseInt(req.params.id) },
      data: { isFeatured: !item.isFeatured },
    });
    req.flash('success', item.isFeatured ? 'Item unfeatured.' : 'Item featured.');
    res.redirect('/admin/shop');
  } catch (error) {
    console.error('Toggle feature error:', error);
    req.flash('error', 'Failed to toggle feature.');
    res.redirect('/admin/shop');
  }
};
