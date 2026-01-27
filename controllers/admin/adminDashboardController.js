const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.renderDashboard = async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      newUsersToday,
      newUsersWeek,
      totalChallenges,
      activeChallenges,
      pendingReports,
      totalPurchases,
      recentReports,
      recentUsers,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.challenge.count(),
      prisma.challenge.count({ where: { isActive: true } }),
      prisma.report.count({ where: { status: 'PENDING' } }),
      prisma.pointBundlePurchase.count({ where: { createdAt: { gte: monthAgo } } }),
      prisma.report.findMany({
        where: { status: 'PENDING' },
        include: {
          reporter: { select: { id: true, username: true } },
          reported: { select: { id: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, username: true, email: true, createdAt: true, totalPoints: true },
      }),
    ]);

    res.render('admin/pages/dashboard', {
      layout: 'admin/layouts/main',
      title: 'Dashboard',
      metrics: {
        totalUsers,
        newUsersToday,
        newUsersWeek,
        totalChallenges,
        activeChallenges,
        pendingReports,
        totalPurchases,
      },
      recentReports,
      recentUsers,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    req.flash('error', 'Failed to load dashboard.');
    res.render('admin/pages/dashboard', {
      layout: 'admin/layouts/main',
      title: 'Dashboard',
      metrics: {},
      recentReports: [],
      recentUsers: [],
    });
  }
};
