const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.listUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 20;
    const search = (req.query.q || '').trim();

    const where = search
      ? {
          OR: [
            { username: { contains: search } },
            { email: { contains: search } },
            { firstName: { contains: search } },
            { lastName: { contains: search } },
            { phone: { contains: search } },
            { referralCode: { contains: search } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, username: true, email: true, phone: true,
          firstName: true, lastName: true, totalPoints: true,
          isActive: true, isBanned: true, createdAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const baseUrl = `/admin/users${search ? `?q=${encodeURIComponent(search)}` : ''}`;

    res.render('admin/pages/users/index', {
      layout: 'admin/layouts/main',
      title: 'Users',
      users, total, page, totalPages, search, baseUrl,
    });
  } catch (error) {
    console.error('List users error:', error);
    req.flash('error', 'Failed to load users.');
    res.redirect('/admin/dashboard');
  }
};

exports.showUser = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        communities: { include: { community: true }, take: 20 },
        inventory: { include: { item: true }, take: 20 },
        pointsLedger: { orderBy: { createdAt: 'desc' }, take: 10 },
        multipliers: { orderBy: { endsAt: 'desc' }, take: 5 },
        submissions: { orderBy: { createdAt: 'desc' }, take: 10, include: { challenge: true } },
        reportsSent: { take: 5, include: { reported: { select: { username: true } } } },
        reportsReceived: { take: 5, include: { reporter: { select: { username: true } } } },
        locationPoints: { orderBy: { createdAt: 'desc' }, take: 10 },
        Location: true,
      },
    });

    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/admin/users');
    }

    const friendCount = await prisma.friendship.count({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: userId }, { receiverId: userId }],
      },
    });

    // Get all shop items for the grant-item dropdown
    const shopItems = await prisma.shopItem.findMany({
      orderBy: [{ slot: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slot: true },
    });

    res.render('admin/pages/users/show', {
      layout: 'admin/layouts/main',
      title: `User: ${user.username}`,
      user, friendCount, shopItems,
    });
  } catch (error) {
    console.error('Show user error:', error);
    req.flash('error', 'Failed to load user.');
    res.redirect('/admin/users');
  }
};

exports.editUserForm = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/admin/users');
    }
    res.render('admin/pages/users/edit', {
      layout: 'admin/layouts/main',
      title: `Edit: ${user.username}`,
      user,
    });
  } catch (error) {
    console.error('Edit user form error:', error);
    req.flash('error', 'Failed to load user.');
    res.redirect('/admin/users');
  }
};

exports.updateUser = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { firstName, lastName, bio } = req.body;
    await prisma.user.update({
      where: { id: userId },
      data: { firstName: firstName || null, lastName: lastName || null, bio: bio || null },
    });
    req.flash('success', 'User updated.');
    res.redirect(`/admin/users/${userId}`);
  } catch (error) {
    console.error('Update user error:', error);
    req.flash('error', 'Failed to update user.');
    res.redirect(`/admin/users/${req.params.id}/edit`);
  }
};

exports.banUser = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { reason } = req.body;
    await prisma.user.update({
      where: { id: userId },
      data: { isBanned: true, bannedAt: new Date(), banReason: reason || null },
    });
    req.flash('success', 'User has been banned.');
    res.redirect(`/admin/users/${userId}`);
  } catch (error) {
    console.error('Ban user error:', error);
    req.flash('error', 'Failed to ban user.');
    res.redirect(`/admin/users/${req.params.id}`);
  }
};

exports.unbanUser = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    await prisma.user.update({
      where: { id: userId },
      data: { isBanned: false, bannedAt: null, banReason: null },
    });
    req.flash('success', 'User has been unbanned.');
    res.redirect(`/admin/users/${userId}`);
  } catch (error) {
    console.error('Unban user error:', error);
    req.flash('error', 'Failed to unban user.');
    res.redirect(`/admin/users/${req.params.id}`);
  }
};

exports.deactivateUser = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
    req.flash('success', 'User deactivated.');
    res.redirect(`/admin/users/${userId}`);
  } catch (error) {
    console.error('Deactivate error:', error);
    req.flash('error', 'Failed to deactivate user.');
    res.redirect(`/admin/users/${req.params.id}`);
  }
};

exports.activateUser = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    await prisma.user.update({ where: { id: userId }, data: { isActive: true } });
    req.flash('success', 'User activated.');
    res.redirect(`/admin/users/${userId}`);
  } catch (error) {
    console.error('Activate error:', error);
    req.flash('error', 'Failed to activate user.');
    res.redirect(`/admin/users/${req.params.id}`);
  }
};

exports.adjustPoints = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const amount = parseInt(req.body.points);
    const reason = req.body.reason || 'ADMIN_ADJUSTMENT';

    if (!amount || isNaN(amount)) {
      req.flash('error', 'Invalid points amount.');
      return res.redirect(`/admin/users/${userId}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { totalPoints: { increment: amount } },
      });
      await tx.pointsLedger.create({
        data: { userId, basePoints: amount, appliedMultiplier: 1, finalPoints: amount, reason },
      });
    });

    req.flash('success', `${amount > 0 ? '+' : ''}${amount} points adjusted.`);
    res.redirect(`/admin/users/${userId}`);
  } catch (error) {
    console.error('Adjust points error:', error);
    req.flash('error', 'Failed to adjust points.');
    res.redirect(`/admin/users/${req.params.id}`);
  }
};

exports.grantItem = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const itemId = parseInt(req.body.itemId);

    await prisma.userInventory.upsert({
      where: { userId_itemId: { userId, itemId } },
      update: {},
      create: { userId, itemId },
    });

    req.flash('success', 'Item granted.');
    res.redirect(`/admin/users/${userId}`);
  } catch (error) {
    console.error('Grant item error:', error);
    req.flash('error', 'Failed to grant item.');
    res.redirect(`/admin/users/${req.params.id}`);
  }
};

exports.removeItem = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const inventoryId = parseInt(req.body.inventoryId);
    await prisma.userInventory.delete({ where: { id: inventoryId } });
    req.flash('success', 'Item removed from inventory.');
    res.redirect(`/admin/users/${userId}`);
  } catch (error) {
    console.error('Remove item error:', error);
    req.flash('error', 'Failed to remove item.');
    res.redirect(`/admin/users/${req.params.id}`);
  }
};

exports.viewInventory = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true },
    });
    const inventory = await prisma.userInventory.findMany({
      where: { userId },
      include: { item: true },
      orderBy: { acquiredAt: 'desc' },
    });

    res.render('admin/pages/users/inventory', {
      layout: 'admin/layouts/main',
      title: `Inventory: ${user?.username || userId}`,
      user, inventory,
    });
  } catch (error) {
    console.error('View inventory error:', error);
    req.flash('error', 'Failed to load inventory.');
    res.redirect(`/admin/users/${req.params.id}`);
  }
};

exports.viewPointsLedger = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const page = parseInt(req.query.page) || 1;
    const pageSize = 30;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, totalPoints: true },
    });

    const [entries, total] = await Promise.all([
      prisma.pointsLedger.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.pointsLedger.count({ where: { userId } }),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    res.render('admin/pages/users/points', {
      layout: 'admin/layouts/main',
      title: `Points: ${user?.username || userId}`,
      user, entries, total, page, totalPages,
      baseUrl: `/admin/users/${userId}/points`,
    });
  } catch (error) {
    console.error('View points error:', error);
    req.flash('error', 'Failed to load points.');
    res.redirect(`/admin/users/${req.params.id}`);
  }
};

exports.exportCsv = async (req, res) => {
  try {
    const { Parser } = require('json2csv');
    const users = await prisma.user.findMany({
      select: {
        id: true, username: true, email: true, phone: true,
        firstName: true, lastName: true, totalPoints: true,
        referralCode: true, isVerified: true, isActive: true,
        isBanned: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const parser = new Parser({
      fields: [
        'id', 'username', 'email', 'phone', 'firstName', 'lastName',
        'totalPoints', 'referralCode', 'isVerified', 'isActive', 'isBanned', 'createdAt',
      ],
    });
    const csv = parser.parse(users);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=outspot-users-${Date.now()}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('Export CSV error:', error);
    req.flash('error', 'Failed to export users.');
    res.redirect('/admin/users');
  }
};
