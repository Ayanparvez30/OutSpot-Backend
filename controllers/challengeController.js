// controllers/challengeController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const uploadToS3 = require('../utils/s3Upload'); // তোমারটা ব্যবহার করো
const { addPointsWithMultiplier } = require('../utils/points');

// ✅ weekly points single source of truth
const {
  getWeeklyPointsForUsers,
  getWeeklyPointsForUser,
} = require('../utils/weeklyPoints');

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

const firstAvatar = (minimeArr) =>
  Array.isArray(minimeArr) && minimeArr.length > 0
    ? (minimeArr[0]?.avatarUrl || null)
    : null;

// ------------------ Create Challenge ------------------
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

// ------------------ Cards: daily + weekly ------------------
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
      preview: (challenge.description || '').slice(0, 120),
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

  const [dailyCard, weeklyCard] = await Promise.all([
    buildCard(daily, 'DAILY'),
    buildCard(weekly, 'WEEKLY'),
  ]);

  // optional filter ?status=in_progress|completed|all
  const statusFilter = (req.query.status || 'all').toLowerCase();
  if (statusFilter === 'all') return res.json({ daily: dailyCard, weekly: weeklyCard });

  const items = [dailyCard, weeklyCard].filter(Boolean).filter(c => c.status === statusFilter);
  return res.json({ items });
};

// ------------------ Full page (daily/weekly) ------------------
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

  // my current window submissions
  const mySubs = await prisma.submission.findMany({
    where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
    orderBy: { createdAt: 'asc' },
  });
  const required = challenge.requiredPhotos || 1;
  const uploaded = mySubs.length;
  const status = uploaded >= required ? 'completed' : uploaded > 0 ? 'in_progress' : 'incomplete';

  // Others who completed in this window (and their REAL awarded points via ledger)
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
          minime: {
            where: { isSaved: true },
            orderBy: { updatedAt: 'desc' },
            select: { avatarUrl: true },
            take: 1
          },
        },
      },
    },
  });

  // count per user within window
  const perUserCount = new Map();
  const perUserInfo = new Map();
  for (const s of windowSubs) {
    const u = s.user;
    if (!u) continue;
    perUserInfo.set(u.id, u);
    perUserCount.set(u.id, (perUserCount.get(u.id) || 0) + 1);
  }

  // completed users (cnt >= required)
  const completedUserIds = Array.from(perUserCount.entries())
    .filter(([_, cnt]) => cnt >= required)
    .map(([uid]) => uid);

  // ledger-based awarded points for those users, in this exact window & challenge
  let awardedByUser = new Map();
  if (completedUserIds.length) {
    const ledgerRows = await prisma.pointsLedger.findMany({
      where: {
        userId: { in: completedUserIds },
        createdAt: { gte: window.startUTC, lte: window.endUTC },
        reason: 'CHALLENGE_COMPLETION',
        refId: challenge.id, // আমরা submit এ এভাবেই লিখেছি
      },
      select: { userId: true, finalPoints: true },
    });
    awardedByUser = ledgerRows.reduce((m, r) => {
      m.set(r.userId, (m.get(r.userId) || 0) + (r.finalPoints || 0));
      return m;
    }, new Map());
  }

  const othersCompleted = completedUserIds
    .map(uid => {
      const u = perUserInfo.get(uid);
      return {
        userId: uid,
        username: u?.username || '',
        avatarUrl: firstAvatar(u?.minime),
        // যদি কোনো কারণে ledger না পাওয়া যায়, fallback -> challenge.points
        earnedPoints: awardedByUser.get(uid) ?? challenge.points
      };
    })
    // কিছু স্টেবল অর্ডার (username/id ভিত্তিক)
    .sort((a, b) => String(a.username).localeCompare(String(b.username)))
    .slice(0, 12);

  // আমার thisWeekPoints (ledger থেকে)
  const thisWeekPoints = await getWeeklyPointsForUser(userId);

  res.json({
    challenge: {
      id: challenge.id,
      title: challenge.title,
      description: challenge.description,
      frequency,
      tier: challenge.tier,
      points: challenge.points,
      requiredCount: required
    },
    status,
    uploadedCount: uploaded,
    timeRemainingMs: timeRemainingMs(frequency, zone, now),
    windowKey,
    zone,
    thisWeekPoints,          // ✅ added for convenience in UI
    othersCompleted
  });
}
exports.getDailyChallenge  = (req, res) => getFull(req, res, 'DAILY');
exports.getWeeklyChallenge = (req, res) => getFull(req, res, 'WEEKLY');

// ------------------ Submit to a challenge ------------------
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

    // already completed in window?
    const existingCount = await prisma.submission.count({
      where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
    });
    const required = challenge.requiredPhotos || 1;
    if (existingCount >= required) return res.status(409).json({ error: 'Challenge already completed' });

    // S3 upload (outside tx)
    const s3Url = await uploadToS3(req.file, 'challenge-submissions');

    // Transactional save + award
    const result = await prisma.$transaction(async (tx) => {
      const submission = await tx.submission.create({
        data: { userId, challengeId: challenge.id, mediaUrl: s3Url }
      });

      const newCount = await tx.submission.count({
        where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
      });

      let awarded = false;
      if (newCount >= required) {
        try {
          await tx.challengeCompletion.create({ data: { userId, challengeId: challenge.id, windowKey } });
          await addPointsWithMultiplier(userId, challenge.points, 'CHALLENGE_COMPLETION', challenge.id, tx);
          awarded = true;
        } catch (_) {
          // unique constraint হলে ignore (already awarded)
        }
      }

      return { submission, newCount, awarded };
    }, { timeout: 15000 });

    res.json({
      message: 'Submission saved',
      submission: result.submission,
      uploadedCount: result.newCount,
      requiredCount: required,
      isCompleted: result.newCount >= required,
      pointsAwarded: result.awarded ? challenge.points : 0, // নোট: multiplier সহ real ledger value client চাইলে আলাদা API দিয়ে টানা যাবে
      tier: challenge.tier,
    });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Failed to submit', details: err.message });
  }
};

// ------------------ Filtered cards list ------------------
// GET /challenges/filter?status=all|in_progress|completed|incomplete&frequency=both|daily|weekly
exports.getFilteredChallenges = async (req, res) => {
  const userId = req.authData.id;
  const zone = currentZone(req);
  const now = new Date();

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
      preview: (challenge.description || '').slice(0, 120),
      frequency: freq,
      tier: challenge.tier,
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

  const statusFilter = (req.query.status || 'all').toLowerCase();
  if (['in_progress', 'completed', 'incomplete'].includes(statusFilter)) {
    items = items.filter(c => c.status === statusFilter);
  }

  return res.json({ items });
};

// ------------------ Legacy helpers ------------------
exports.getSubmissions = async (req, res) => {
  const { challengeId } = req.params;
  const userId = req.authData.id;

  const others = await prisma.submission.findMany({
    where: { challengeId: parseInt(challengeId, 10), NOT: { userId } },
    include: {
      user: {
        select: {
          id: true, username: true,
          minime: {
            where: { isSaved: true },
            orderBy: { updatedAt: 'desc' },
            select: { avatarUrl: true },
            take: 1
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // avatarUrl অ্যারে-সেইফ করে রিটার্ন
  const shaped = others.map(s => ({
    ...s,
    user: {
      ...s.user,
      avatarUrl: firstAvatar(s.user?.minime),
    }
  }));

  res.json(shaped);
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
