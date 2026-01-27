const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.listLocationPoints = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 30;
    const search = (req.query.q || '').trim();

    const where = search
      ? { OR: [{ placeName: { contains: search } }, { user: { username: { contains: search } } }] }
      : {};

    const [locationPoints, total] = await Promise.all([
      prisma.locationPoint.findMany({
        where,
        include: { user: { select: { id: true, username: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.locationPoint.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const baseUrl = `/admin/locations${search ? `?q=${encodeURIComponent(search)}` : ''}`;

    res.render('admin/pages/locations/index', {
      layout: 'admin/layouts/main',
      title: 'Location Points',
      locationPoints, total, page, totalPages, baseUrl, search,
    });
  } catch (error) {
    console.error('List location points error:', error);
    req.flash('error', 'Failed to load location points.');
    res.redirect('/admin/dashboard');
  }
};

exports.adjustPoints = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { points } = req.body;
    await prisma.locationPoint.update({
      where: { id },
      data: { points: parseInt(points) },
    });
    req.flash('success', `Location point #${id} adjusted.`);
    res.redirect('/admin/locations');
  } catch (error) {
    console.error('Adjust location points error:', error);
    req.flash('error', 'Failed to adjust points.');
    res.redirect('/admin/locations');
  }
};

exports.removePoint = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.locationPoint.delete({ where: { id } });
    req.flash('success', `Location point #${id} removed.`);
    res.redirect('/admin/locations');
  } catch (error) {
    console.error('Remove location point error:', error);
    req.flash('error', 'Failed to remove location point.');
    res.redirect('/admin/locations');
  }
};
