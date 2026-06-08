const { PrismaClient } = require('@prisma/client');
const { notifyUser } = require('../../utils/notificationService');
const prisma = new PrismaClient();

exports.listReports = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 20;
    const status = req.query.status;

    const where = status ? { status } : {};

    const [reports, total] = await Promise.all([
      prisma.report.findMany({
        where,
        include: {
          reporter: { select: { id: true, username: true } },
          reported: { select: { id: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.report.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const baseUrl = `/admin/reports${status ? `?status=${status}` : ''}`;

    res.render('admin/pages/reports/index', {
      layout: 'admin/layouts/main',
      title: 'Reports',
      reports, total, page, totalPages, baseUrl,
      statusFilter: status || '',
    });
  } catch (error) {
    console.error('List reports error:', error);
    req.flash('error', 'Failed to load reports.');
    res.redirect('/admin/dashboard');
  }
};

exports.showReport = async (req, res) => {
  try {
    const report = await prisma.report.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        reporter: { select: { id: true, username: true, email: true } },
        reported: { select: { id: true, username: true, email: true, isBanned: true, isActive: true } },
      },
    });

    if (!report) {
      req.flash('error', 'Report not found.');
      return res.redirect('/admin/reports');
    }

    res.render('admin/pages/reports/show', {
      layout: 'admin/layouts/main',
      title: `Report #${report.id}`,
      report,
    });
  } catch (error) {
    console.error('Show report error:', error);
    req.flash('error', 'Failed to load report.');
    res.redirect('/admin/reports');
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const { status, adminNote } = req.body;

    await prisma.report.update({
      where: { id: reportId },
      data: { status, adminNote: adminNote || null, reviewedAt: new Date() },
    });

    req.flash('success', `Report #${reportId} updated to ${status}.`);
    res.redirect(`/admin/reports/${reportId}`);
  } catch (error) {
    console.error('Update report error:', error);
    req.flash('error', 'Failed to update report.');
    res.redirect(`/admin/reports/${req.params.id}`);
  }
};

exports.takeAction = async (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    const { action, targetUserId } = req.body;
    const userId = parseInt(targetUserId);

    switch (action) {
      case 'warn':
        // Route through notifyUser so the red-dot persist + socket emit fire too.
        await notifyUser(
          userId,
          'NEW_CHALLENGE',
          'Admin Warning',
          'You have received a warning for reported behavior.'
        );
        break;
      case 'ban':
        await prisma.user.update({
          where: { id: userId },
          data: { isBanned: true, bannedAt: new Date(), banReason: `Enforcement from Report #${reportId}` },
        });
        break;
      case 'deactivate':
        await prisma.user.update({
          where: { id: userId },
          data: { isActive: false },
        });
        break;
    }

    await prisma.report.update({
      where: { id: reportId },
      data: { status: 'Resolved', reviewedAt: new Date() },
    });

    req.flash('success', `Enforcement action "${action}" applied.`);
    res.redirect(`/admin/reports/${reportId}`);
  } catch (error) {
    console.error('Take action error:', error);
    req.flash('error', 'Failed to take action.');
    res.redirect(`/admin/reports/${req.params.id}`);
  }
};
