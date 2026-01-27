const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.listFriendships = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 30;
    const status = req.query.status;

    const where = status ? { status } : {};

    const [friendships, total] = await Promise.all([
      prisma.friendship.findMany({
        where,
        include: {
          requester: { select: { id: true, username: true } },
          receiver: { select: { id: true, username: true } },
        },
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.friendship.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const baseUrl = `/admin/friends${status ? `?status=${status}` : ''}`;

    res.render('admin/pages/friends/index', {
      layout: 'admin/layouts/main',
      title: 'Friendships',
      friendships, total, page, totalPages, baseUrl,
      statusFilter: status || '',
    });
  } catch (error) {
    console.error('List friendships error:', error);
    req.flash('error', 'Failed to load friendships.');
    res.redirect('/admin/dashboard');
  }
};

exports.approveFriendship = async (req, res) => {
  try {
    await prisma.friendship.update({
      where: { id: parseInt(req.params.id) },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
    req.flash('success', 'Friendship approved.');
    res.redirect('/admin/friends');
  } catch (error) {
    console.error('Approve friendship error:', error);
    req.flash('error', 'Failed to approve.');
    res.redirect('/admin/friends');
  }
};

exports.revokeFriendship = async (req, res) => {
  try {
    await prisma.friendship.update({
      where: { id: parseInt(req.params.id) },
      data: { status: 'PENDING', acceptedAt: null },
    });
    req.flash('success', 'Friendship revoked to pending.');
    res.redirect('/admin/friends');
  } catch (error) {
    console.error('Revoke friendship error:', error);
    req.flash('error', 'Failed to revoke.');
    res.redirect('/admin/friends');
  }
};

exports.removeFriendship = async (req, res) => {
  try {
    await prisma.friendship.delete({ where: { id: parseInt(req.params.id) } });
    req.flash('success', 'Friendship removed.');
    res.redirect('/admin/friends');
  } catch (error) {
    console.error('Remove friendship error:', error);
    req.flash('error', 'Failed to remove.');
    res.redirect('/admin/friends');
  }
};

exports.listBlocks = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 30;

    const [blocks, total] = await Promise.all([
      prisma.block.findMany({
        include: {
          blocker: { select: { id: true, username: true } },
          blocked: { select: { id: true, username: true } },
        },
        orderBy: { blockedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.block.count(),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    res.render('admin/pages/friends/blocks', {
      layout: 'admin/layouts/main',
      title: 'Blocked Users',
      blocks, total, page, totalPages,
      baseUrl: '/admin/friends/blocks',
    });
  } catch (error) {
    console.error('List blocks error:', error);
    req.flash('error', 'Failed to load blocks.');
    res.redirect('/admin/dashboard');
  }
};

exports.unblock = async (req, res) => {
  try {
    await prisma.block.delete({ where: { id: parseInt(req.params.id) } });
    req.flash('success', 'User unblocked.');
    res.redirect('/admin/friends/blocks');
  } catch (error) {
    console.error('Unblock error:', error);
    req.flash('error', 'Failed to unblock.');
    res.redirect('/admin/friends/blocks');
  }
};

exports.createBlock = async (req, res) => {
  try {
    const { blockerId, blockedId } = req.body;
    await prisma.block.create({
      data: { blockerId: parseInt(blockerId), blockedId: parseInt(blockedId) },
    });
    req.flash('success', 'User blocked.');
    res.redirect('/admin/friends/blocks');
  } catch (error) {
    console.error('Create block error:', error);
    req.flash('error', 'Failed to block user.');
    res.redirect('/admin/friends/blocks');
  }
};
