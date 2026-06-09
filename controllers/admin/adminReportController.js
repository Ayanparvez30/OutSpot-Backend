const { PrismaClient } = require('@prisma/client');
const { notifyUser } = require('../../utils/notificationService');
const prisma = new PrismaClient();

exports.listReports = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 20;
    const status = req.query.status;
    // Item 7: optional ?type=user|message filter. Default behavior unchanged
    // when omitted (returns both kinds).
    const type = req.query.type;

    const where = {
      ...(status ? { status } : {}),
      ...(type && (type === 'user' || type === 'message') ? { type } : {}),
    };

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
    const qs = [];
    if (status) qs.push(`status=${status}`);
    if (type)   qs.push(`type=${type}`);
    const baseUrl = `/admin/reports${qs.length ? `?${qs.join('&')}` : ''}`;

    res.render('admin/pages/reports/index', {
      layout: 'admin/layouts/main',
      title: 'Reports',
      reports, total, page, totalPages, baseUrl,
      statusFilter: status || '',
      typeFilter: type || '',
    });
  } catch (error) {
    console.error('List reports error:', error);
    req.flash('error', 'Failed to load reports.');
    res.redirect('/admin/dashboard');
  }
};

// Item 7: admin can hard-delete the reported message + mark the report Resolved.
// Only meaningful when report.type === 'message'. Emits the same messagesDeleted
// event clients already handle, so all chat windows clear the message instantly.
exports.deleteReportedMessage = async (req, res) => {
  try {
    const reportId = parseInt(req.params.id, 10);
    if (!reportId || !Number.isInteger(reportId)) {
      return res.status(400).json({ error: 'Invalid report id' });
    }

    const report = await prisma.report.findUnique({
      where: { id: reportId },
      select: { id: true, type: true, messageId: true, chatId: true },
    });
    if (!report)                  return res.status(404).json({ error: 'Report not found' });
    if (report.type !== 'message') return res.status(400).json({ error: 'Report is not a message report' });
    if (!report.messageId)        return res.status(400).json({ error: 'Report has no linked message' });

    const message = await prisma.message.findUnique({
      where: { id: report.messageId },
      select: { id: true, chatId: true, imageUrl: true },
    });

    if (message) {
      await prisma.message.delete({ where: { id: message.id } });

      // Orphan-only S3 cleanup
      if (message.imageUrl) {
        try {
          const { deleteS3IfOrphanBulk } = require('../../utils/s3Cleanup');
          deleteS3IfOrphanBulk([message.imageUrl]).catch((e) =>
            console.error('admin deleteReportedMessage S3 cleanup error', e)
          );
        } catch (_) { /* s3 module unavailable */ }
      }

      // Broadcast messagesDeleted so live clients drop the row.
      try {
        const { getIO } = require('../../utils/socket');
        const io = getIO && getIO();
        if (io) {
          io.to(`chat_${message.chatId}`).emit('messagesDeleted', {
            chatId: message.chatId,
            messageIds: [message.id],
          });
        }
      } catch (_) { /* socket not ready */ }
    }

    await prisma.report.update({
      where: { id: reportId },
      data: { status: 'Resolved', reviewedAt: new Date() },
    });

    return res.json({ success: true, deleted: message ? [message.id] : [] });
  } catch (error) {
    console.error('Admin deleteReportedMessage error:', error);
    return res.status(500).json({ error: 'Failed to delete reported message' });
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
