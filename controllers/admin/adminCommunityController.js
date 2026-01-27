const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.listCommunities = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 20;
    const search = (req.query.q || '').trim();

    const where = search ? { name: { contains: search } } : {};

    const [communities, total] = await Promise.all([
      prisma.community.findMany({
        where,
        include: {
          creator: { select: { id: true, username: true } },
          _count: { select: { members: true } },
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { id: 'desc' },
      }),
      prisma.community.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const baseUrl = `/admin/communities${search ? `?q=${encodeURIComponent(search)}` : ''}`;

    res.render('admin/pages/communities/index', {
      layout: 'admin/layouts/main',
      title: 'Communities',
      communities, total, page, totalPages, baseUrl, search,
    });
  } catch (error) {
    console.error('List communities error:', error);
    req.flash('error', 'Failed to load communities.');
    res.redirect('/admin/dashboard');
  }
};

exports.editForm = async (req, res) => {
  try {
    const community = await prisma.community.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { creator: { select: { id: true, username: true } } },
    });
    if (!community) {
      req.flash('error', 'Community not found.');
      return res.redirect('/admin/communities');
    }
    res.render('admin/pages/communities/edit', {
      layout: 'admin/layouts/main',
      title: `Edit: ${community.name}`,
      community,
    });
  } catch (error) {
    console.error('Edit community form error:', error);
    req.flash('error', 'Failed to load community.');
    res.redirect('/admin/communities');
  }
};

exports.updateCommunity = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, imageUrl } = req.body;
    await prisma.community.update({
      where: { id },
      data: { name, imageUrl: imageUrl || null },
    });
    req.flash('success', 'Community updated.');
    res.redirect('/admin/communities');
  } catch (error) {
    console.error('Update community error:', error);
    req.flash('error', 'Failed to update community.');
    res.redirect(`/admin/communities/${req.params.id}/edit`);
  }
};
