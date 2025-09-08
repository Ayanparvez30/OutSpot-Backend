// controllers/challengeController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const uploadToS3 = require('../utils/s3Upload'); // তোমারটা ব্যবহার করো

const {
  resolveZone,
  startOfDayInZone,
  endOfDayInZone,
  getWeekStartEndInZone,
  getAssignedChallenge,
  timeRemainingMs,
  dateKeyInZone,
  weekKeyInZone,
} = require('../utils/challenges');

const currentZone = (req) => resolveZone(req.user?.timezone || null);
exports.createChallenge = async (req, res) => {
  try {
    const rawFreq = String(req.body.frequency || 'DAILY').toUpperCase(); // DAILY|WEEKLY
    const frequency = rawFreq === 'WEEKLY' ? 'WEEKLY' : 'DAILY';
    const tier  = req.body.tier || (frequency === 'WEEKLY' ? 'GOLD' : 'SILVER');
    const points = parseInt(req.body.points ?? (frequency === 'WEEKLY' ? 50 : 10), 10);
    const requiredPhotos = parseInt(req.body.requiredPhotos ?? 1, 10);

    const challenge = await prisma.challenge.create({
      data: {
        title: req.body.title,
        description: req.body.description,
        type: req.body.type || null,
        frequency,
        tier,
        points,
        requiredPhotos,
      },
    });
    res.json(challenge);
  } catch (err) {
    console.error('Create Challenge Error:', err);
    res.status(500).json({ error: 'Failed to create challenge' });
  }
};


// Cards: daily + weekly
exports.getChallengeCards = async (req, res) => {
  const userId = req.authData.id;
  const zone = currentZone(req);
  const now = new Date();

  const daily = await getAssignedChallenge(prisma, userId, 'DAILY', zone, now);
  const weekly = await getAssignedChallenge(prisma, userId, 'WEEKLY', zone, now);

  async function buildCard(assign, freq) {
    if (!assign || !assign.challenge) return null;
    const { challenge, windowKey } = assign;
    const window = (freq === 'DAILY')
      ? { startUTC: startOfDayInZone(now, zone), endUTC: endOfDayInZone(now, zone) }
      : getWeekStartEndInZone(now, zone);

    const cnt = await prisma.submission.count({
      where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
    });
    const required = challenge.requiredPhotos || 1;
    const status = cnt >= required ? 'completed' : cnt > 0 ? 'in_progress' : 'incomplete';

    return {
      id: challenge.id,
      title: challenge.title,
      preview: challenge.description.slice(0, 120),
      frequency: freq,
      tier: challenge.tier,
      points: challenge.points,
      requiredCount: required,
      uploadedCount: cnt,
      status,
      timeRemainingMs: timeRemainingMs(freq, zone, now),
      windowKey, zone,
    };
  }

  const [dailyCard, weeklyCard] = await Promise.all([buildCard(daily, 'DAILY'), buildCard(weekly, 'WEEKLY')]);

  // optional filter ?status=in_progress|completed|all
  const statusFilter = (req.query.status || 'all').toLowerCase();
  if (statusFilter === 'all') return res.json({ daily: dailyCard, weekly: weeklyCard });

  const items = [dailyCard, weeklyCard].filter(Boolean).filter(c => c.status === statusFilter);
  return res.json({ items });
};

// Full page
async function getFull(req, res, frequency) {
  const userId = req.authData.id;
  const zone = currentZone(req);
  const now = new Date();

  const assign = await getAssignedChallenge(prisma, userId, frequency, zone, now);
  if (!assign || !assign.challenge) return res.status(404).json({ error: 'No challenge available' });

  const { challenge, windowKey } = assign;
  const window = (frequency === 'DAILY')
    ? { startUTC: startOfDayInZone(now, zone), endUTC: endOfDayInZone(now, zone) }
    : getWeekStartEndInZone(now, zone);

  const mySubs = await prisma.submission.findMany({
    where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
    orderBy: { createdAt: 'asc' },
  });
  const required = challenge.requiredPhotos || 1;
  const uploaded = mySubs.length;
  const status = uploaded >= required ? 'completed' : uploaded > 0 ? 'in_progress' : 'incomplete';

  const windowSubs = await prisma.submission.findMany({
    where: {
      challengeId: challenge.id,
      userId: { not: userId },
      createdAt: { gte: window.startUTC, lte: window.endUTC },
    },
    include: {
      user: {
        select: {
          id: true, username: true,
          minime: { where: { isSaved: true }, orderBy: { updatedAt: 'desc' }, select: { avatarUrl: true }, take: 1 },
        },
      },
    },
  });

  const map = new Map();
  for (const s of windowSubs) {
    const u = s.user; if (!u) continue;
    if (!map.has(u.id)) map.set(u.id, { user: u, count: 0 });
    map.get(u.id).count++;
  }
  const othersCompleted = [];
  for (const { user: u, count } of map.values()) {
    if (count >= required) {
      othersCompleted.push({ userId: u.id, username: u.username, avatarUrl: u.minime?.[0]?.avatarUrl || null, earnedPoints: challenge.points });
    }
  }
  othersCompleted.sort((a, b) => b.userId - a.userId);

  res.json({
    challenge: { id: challenge.id, title: challenge.title, description: challenge.description, frequency, tier: challenge.tier, points: challenge.points, requiredCount: required },
    status, uploadedCount: uploaded,
    timeRemainingMs: timeRemainingMs(frequency, zone, now),
    windowKey, zone,
    othersCompleted: othersCompleted.slice(0, 12),
  });
}
exports.getDailyChallenge  = (req, res) => getFull(req, res, 'DAILY');
exports.getWeeklyChallenge = (req, res) => getFull(req, res, 'WEEKLY');

// Submit
exports.submitToChallenge = async (req, res) => {
  const userId = req.authData.id;
  const { challengeId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No media uploaded' });

  try {
    const challenge = await prisma.challenge.findUnique({ where: { id: parseInt(challengeId, 10) } });
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });

    const now = new Date();
    const zone = currentZone(req);
    const frequency = challenge.frequency;
    const assigned = await getAssignedChallenge(prisma, userId, frequency, zone, now);
    if (!assigned || !assigned.challenge || assigned.challenge.id !== challenge.id) {
      return res.status(403).json({ error: 'This is not your current assigned challenge' });
    }
    const window = (frequency === 'DAILY')
      ? { startUTC: startOfDayInZone(now, zone), endUTC: endOfDayInZone(now, zone) }
      : getWeekStartEndInZone(now, zone);
    const windowKey = `${frequency}:${frequency === 'DAILY' ? dateKeyInZone(now, zone) : weekKeyInZone(now, zone)}`;

    const existingCount = await prisma.submission.count({
      where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
    });
    const required = challenge.requiredPhotos || 1;
    if (existingCount >= required) return res.status(409).json({ error: 'Challenge already completed' });

    const s3Url = await uploadToS3(req.file, 'challenge-submissions');

    const result = await prisma.$transaction(async (tx) => {
      const submission = await tx.submission.create({ data: { userId, challengeId: challenge.id, mediaUrl: s3Url } });
      const newCount = await tx.submission.count({
        where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
      });

      let awarded = false;
      if (newCount >= required) {
        try {
          await tx.challengeCompletion.create({ data: { userId, challengeId: challenge.id, windowKey } });
          await tx.user.update({ where: { id: userId }, data: { totalPoints: { increment: challenge.points } } });
          awarded = true;
        } catch (_) { /* unique -> already awarded */ }
      }
      return { submission, newCount, awarded };
    });

    res.json({
      message: 'Submission saved',
      submission: result.submission,
      uploadedCount: result.newCount,
      requiredCount: required,
      isCompleted: result.newCount >= required,
      pointsAwarded: result.awarded ? challenge.points : 0,
      tier: challenge.tier,
    });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Failed to submit', details: err.message });
  }
};
// --- Add this at the bottom (or near other exports) ---

// GET /challenges/filter?status=all|in_progress|completed|incomplete&frequency=both|daily|weekly
exports.getFilteredChallenges = async (req, res) => {
  const userId = req.authData.id;
  const zone = currentZone(req);
  const now = new Date();

  // Helper to build a single card by frequency
  async function buildCardByFrequency(freq) {
    const assign = await getAssignedChallenge(prisma, userId, freq, zone, now);
    if (!assign || !assign.challenge) return null;

    const { challenge, windowKey } = assign;
    const window = (freq === 'DAILY')
      ? { startUTC: startOfDayInZone(now, zone), endUTC: endOfDayInZone(now, zone) }
      : getWeekStartEndInZone(now, zone);

    const cnt = await prisma.submission.count({
      where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
    });

    const required = challenge.requiredPhotos || 1;
    const status = cnt >= required ? 'completed' : (cnt > 0 ? 'in_progress' : 'incomplete');

    return {
      id: challenge.id,
      title: challenge.title,
      preview: challenge.description.slice(0, 120),
      frequency: freq,
      tier: challenge.tier,           // SILVER/GOLD
      points: challenge.points,
      requiredCount: required,
      uploadedCount: cnt,
      status,
      timeRemainingMs: timeRemainingMs(freq, zone, now),
      windowKey,
      zone,
    };
  }

  const frequency = (req.query.frequency || 'both').toLowerCase(); // both|daily|weekly
  const wantDaily  = frequency === 'both' || frequency === 'daily';
  const wantWeekly = frequency === 'both' || frequency === 'weekly';

  const [dailyCard, weeklyCard] = await Promise.all([
    wantDaily  ? buildCardByFrequency('DAILY')  : Promise.resolve(null),
    wantWeekly ? buildCardByFrequency('WEEKLY') : Promise.resolve(null),
  ]);

  let items = [dailyCard, weeklyCard].filter(Boolean);

  // status filter: all|in_progress|completed|incomplete
  const statusFilter = (req.query.status || 'all').toLowerCase();
  if (['in_progress', 'completed', 'incomplete'].includes(statusFilter)) {
    items = items.filter(c => c.status === statusFilter);
  }

  // response shape: list
  return res.json({ items });
};

// Optional legacy (if needed)
exports.getSubmissions = async (req, res) => {
  const { challengeId } = req.params;
  const userId = req.authData.id;

  const others = await prisma.submission.findMany({
    where: { challengeId: parseInt(challengeId, 10), NOT: { userId } },
    include: {
      user: {
        select: {
          id: true, username: true,
          minime: { where: { isSaved: true }, orderBy: { updatedAt: 'desc' }, select: { avatarUrl: true }, take: 1 },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(others);
};

exports.getMySubmission = async (req, res) => {
  const userId = req.authData.id;
  const { challengeId } = req.params;
  const submissions = await prisma.submission.findMany({
    where: { userId, challengeId: parseInt(challengeId, 10) },
    orderBy: { createdAt: 'asc' },
  });
  if (!submissions.length) return res.status(404).json({ message: 'No submissions found' });
  res.json(submissions);
};
