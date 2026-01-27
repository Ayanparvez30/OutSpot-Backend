const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.listChallenges = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 20;
    const freq = req.query.frequency;
    const search = (req.query.q || '').trim();

    const where = {};
    if (freq) where.frequency = freq;
    if (search) where.title = { contains: search };

    const [challenges, total] = await Promise.all([
      prisma.challenge.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ frequency: 'asc' }, { createdAt: 'desc' }],
        include: { _count: { select: { submissions: true, completions: true } } },
      }),
      prisma.challenge.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (freq) params.set('frequency', freq);
    const baseUrl = `/admin/challenges${params.toString() ? `?${params}` : ''}`;

    res.render('admin/pages/challenges/index', {
      layout: 'admin/layouts/main',
      title: 'Challenges',
      challenges, total, page, totalPages, baseUrl,
      search, frequency: freq || '',
    });
  } catch (error) {
    console.error('List challenges error:', error);
    req.flash('error', 'Failed to load challenges.');
    res.redirect('/admin/dashboard');
  }
};

exports.createForm = (req, res) => {
  res.render('admin/pages/challenges/form', {
    layout: 'admin/layouts/main',
    title: 'Create Challenge',
    challenge: null,
  });
};

exports.createChallenge = async (req, res) => {
  try {
    const { title, description, type, frequency, points, tier, requiredPhotos } = req.body;
    await prisma.challenge.create({
      data: {
        title,
        description,
        type: type || null,
        frequency: frequency || 'DAILY',
        points: parseInt(points) || 10,
        tier: tier || 'SILVER',
        requiredPhotos: parseInt(requiredPhotos) || 1,
      },
    });
    req.flash('success', 'Challenge created.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Create challenge error:', error);
    req.flash('error', 'Failed to create challenge.');
    res.redirect('/admin/challenges/create');
  }
};

exports.editForm = async (req, res) => {
  try {
    const challenge = await prisma.challenge.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!challenge) {
      req.flash('error', 'Challenge not found.');
      return res.redirect('/admin/challenges');
    }
    res.render('admin/pages/challenges/form', {
      layout: 'admin/layouts/main',
      title: `Edit: ${challenge.title}`,
      challenge,
    });
  } catch (error) {
    console.error('Edit challenge form error:', error);
    req.flash('error', 'Failed to load challenge.');
    res.redirect('/admin/challenges');
  }
};

exports.updateChallenge = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { title, description, type, frequency, points, tier, requiredPhotos } = req.body;
    await prisma.challenge.update({
      where: { id },
      data: {
        title,
        description,
        type: type || null,
        frequency: frequency || undefined,
        points: parseInt(points) || undefined,
        tier: tier || undefined,
        requiredPhotos: parseInt(requiredPhotos) || undefined,
      },
    });
    req.flash('success', 'Challenge updated.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Update challenge error:', error);
    req.flash('error', 'Failed to update challenge.');
    res.redirect(`/admin/challenges/${req.params.id}/edit`);
  }
};

exports.activateChallenge = async (req, res) => {
  try {
    await prisma.challenge.update({ where: { id: parseInt(req.params.id) }, data: { isActive: true } });
    req.flash('success', 'Challenge activated.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Activate challenge error:', error);
    req.flash('error', 'Failed to activate.');
    res.redirect('/admin/challenges');
  }
};

exports.deactivateChallenge = async (req, res) => {
  try {
    await prisma.challenge.update({ where: { id: parseInt(req.params.id) }, data: { isActive: false } });
    req.flash('success', 'Challenge deactivated.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Deactivate challenge error:', error);
    req.flash('error', 'Failed to deactivate.');
    res.redirect('/admin/challenges');
  }
};

exports.toggleFeature = async (req, res) => {
  try {
    const challenge = await prisma.challenge.findUnique({ where: { id: parseInt(req.params.id) } });
    await prisma.challenge.update({
      where: { id: parseInt(req.params.id) },
      data: { isFeatured: !challenge.isFeatured },
    });
    req.flash('success', challenge.isFeatured ? 'Challenge unfeatured.' : 'Challenge featured.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Toggle feature error:', error);
    req.flash('error', 'Failed to toggle feature.');
    res.redirect('/admin/challenges');
  }
};

exports.deleteChallenge = async (req, res) => {
  try {
    await prisma.challenge.delete({ where: { id: parseInt(req.params.id) } });
    req.flash('success', 'Challenge deleted.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Delete challenge error:', error);
    req.flash('error', 'Failed to delete challenge. It may have submissions.');
    res.redirect('/admin/challenges');
  }
};

exports.viewSubmissions = async (req, res) => {
  try {
    const challengeId = parseInt(req.params.id);
    const page = parseInt(req.query.page) || 1;
    const pageSize = 20;

    const challenge = await prisma.challenge.findUnique({ where: { id: challengeId } });

    const [submissions, total] = await Promise.all([
      prisma.submission.findMany({
        where: { challengeId },
        include: { user: { select: { id: true, username: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.submission.count({ where: { challengeId } }),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    res.render('admin/pages/challenges/submissions', {
      layout: 'admin/layouts/main',
      title: `Submissions: ${challenge?.title || challengeId}`,
      challenge, submissions, total, page, totalPages,
      baseUrl: `/admin/challenges/${challengeId}/submissions`,
    });
  } catch (error) {
    console.error('View submissions error:', error);
    req.flash('error', 'Failed to load submissions.');
    res.redirect('/admin/challenges');
  }
};
