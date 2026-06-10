// controllers/challengeController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const uploadToS3 = require('../utils/s3Upload');
const { addPointsWithMultiplier } = require('../utils/points');
const realtime = require('../utils/realtime');
const {
  verifySubmissionImage,
  checkTimeConstraints,
  checkDuplicateImage,
} = require('../utils/challengeVerification');
const { notifyNewChallenge } = require('../utils/challengeNotifications');
const { notifyUser } = require('../utils/notificationService'); // Import notification service

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

    // Note: Notifications are sent automatically via cron jobs when challenges become available
    // No need to notify on creation since challenges are premade and assigned deterministically

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

    // Create notifications for assigned challenges if not already present
    async function maybeNotify(assign, freq) {
      if (!assign || !assign.challenge) return;
      const challenge = assign.challenge;
      const type = freq === 'DAILY' ? 'DAILY_CHALLENGE' : 'WEEKLY_CHALLENGE';
      const today = new Date();
      let start, end;
      if (freq === 'DAILY') {
        start = startOfDayInZone(today, zone);
        end = endOfDayInZone(today, zone);
      } else {
        const week = getWeekStartEndInZone(today, zone);
        start = week.startUTC;
        end = week.endUTC;
      }

      // Add unique constraint check for notifications
      const existing = await prisma.notification.findFirst({
        where: {
          userId,
          type,
          title: challenge.title,
          createdAt: { gte: start, lte: end },
        },
      });

      if (!existing) {
        // Send push notification
        await notifyUser(
          userId,
          type,
            challenge.title,
            challenge.description,
            { challengeId: challenge.id }
          );
        }
      }
    

    await Promise.all([
      maybeNotify(daily, 'DAILY'),
      maybeNotify(weekly, 'WEEKLY'),
    ]);

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

    // Create notification for assigned challenge if not already present
    const type = frequency === 'DAILY' ? 'DAILY_CHALLENGE' : 'WEEKLY_CHALLENGE';
    let start, end;
    if (frequency === 'DAILY') {
      start = startOfDayInZone(now, zone);
      end = endOfDayInZone(now, zone);
    } else {
      const week = getWeekStartEndInZone(now, zone);
      start = week.startUTC;
      end = week.endUTC;
    }
    const existing = await prisma.notification.findFirst({
      where: {
        userId,
        type,
        title: challenge.title,
        createdAt: { gte: start, lte: end },
      },
    });


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
    thisWeekPoints,      
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

    const required = challenge.requiredPhotos || 1;


    const existingCount = await prisma.submission.count({
      where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
    });
    if (existingCount >= required) {
      return res.status(409).json({ error: 'Challenge already completed (upload limit reached)' });
    }

    // ── Verification (runs BEFORE S3 upload to avoid orphaned files) ──
    const imageBuffer = req.file.buffer;

    const [aiResult, timeResult, dupeResult] = await Promise.all([
      verifySubmissionImage(imageBuffer, challenge.title, challenge.description),
      Promise.resolve(checkTimeConstraints(challenge.title, zone)),
      checkDuplicateImage(imageBuffer, userId),
    ]);

    // Duplicate check
    if (!dupeResult.pass) {
      return res.status(400).json({
        error: dupeResult.reason,
        verificationStatus: 'FAILED',
      });
    }

    // Time constraint check
    if (!timeResult.pass) {
      return res.status(400).json({
        error: timeResult.reason,
        verificationStatus: 'FAILED',
      });
    }

    // AI vision check — only PASSED is accepted; FAILED and SKIPPED both reject
    const verificationStatus = aiResult.status;
    if (verificationStatus !== 'PASSED') {
      return res.status(400).json({
        error: 'Photo verification failed',
        reason: aiResult.reason || 'Please submit a clear, relevant photo that matches the challenge.',
        verificationStatus: 'FAILED',
      });
    }

    // ── Verification passed — proceed with upload + submission ──
    const s3Url = await uploadToS3(req.file, 'challenge-submissions');

    try {
      const result = await prisma.$transaction(async (tx) => {

        const countBefore = await tx.submission.count({
          where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
        });
        if (countBefore >= required) {
          const err = new Error('LIMIT_REACHED');
          err.code = 'LIMIT_REACHED';
          throw err;
        }

        const submission = await tx.submission.create({
          data: {
            userId,
            challengeId: challenge.id,
            mediaUrl: s3Url,
            verificationStatus,
            rejectionReason: aiResult.reason || null,
            imageHash: dupeResult.hash || null,
          },
        });

        const newCount = await tx.submission.count({
          where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
        });

        if (newCount > required) {
          const err = new Error('LIMIT_REACHED_AFTER_INSERT');
          err.code = 'LIMIT_REACHED';
          throw err;
        }

        let awarded = false;
        if (newCount === required) {
          try {
            await tx.challengeCompletion.create({ data: { userId, challengeId: challenge.id, windowKey } });
            await addPointsWithMultiplier(userId, challenge.points, 'CHALLENGE_COMPLETION', challenge.id, tx);
            awarded = true;
          } catch (_) {
            // unique constraint — already completed
          }
        }

        return { submission, newCount, awarded };
      }, { timeout: 15000 });

      // Realtime (after commit): challenge card state + points if awarded
      realtime.toUser(userId, 'challenge.submitted', { challengeId: challenge.id });
      if (result.awarded) {
        realtime.toUser(userId, 'user.points_changed', { userId });
      }

      return res.json({
        message: 'Submission saved',
        submission: result.submission,
        uploadedCount: result.newCount,
        requiredCount: required,
        isCompleted: result.newCount >= required,
        pointsAwarded: result.awarded ? challenge.points : 0,
        tier: challenge.tier,
        verificationStatus,
      });
    } catch (txErr) {
      if (txErr && txErr.code === 'LIMIT_REACHED') {
        return res.status(409).json({ error: 'Challenge already completed (upload limit reached)' });
      }
      throw txErr;
    }
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
// ------------------ Legacy helpers (UPDATED) ------------------
exports.getSubmissions = async (req, res) => {
  try {
    const me = req.authData.id;
    const challengeId = parseInt(req.params.challengeId, 10);
    if (!Number.isFinite(challengeId)) {
      return res.status(400).json({ error: 'Invalid challengeId' });
    }

    // ---- Pagination + sort params ----
    // Sized to keep the 50k+ submitter case stable on the client. Page size
    // capped at 100 to bound the per-page hydration work below.
    const page     = Math.max(1, parseInt(req.query.page,     10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize, 10) || 20));
    const sortDir  = String(req.query.sort || 'newest').toLowerCase() === 'oldest' ? 'asc' : 'desc';
    const skip     = (page - 1) * pageSize;

    // 1) challenge + window (daily/week) — unchanged.
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { id: true, frequency: true, requiredPhotos: true, points: true },
    });
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });

    const zone = currentZone(req);
    const now = new Date();
    const win =
      challenge.frequency === 'DAILY'
        ? { startUTC: startOfDayInZone(now, zone), endUTC: endOfDayInZone(now, zone) }
        : getWeekStartEndInZone(now, zone);
    const required = challenge.requiredPhotos || 1;

    // ---- Friends + shared community/group sets (bounded by ME, never by 50k) ----
    const friendRows = await prisma.friendship.findMany({
      where: { status: 'ACCEPTED', OR: [{ requesterId: me }, { receiverId: me }] },
      select: { requesterId: true, receiverId: true },
    });
    const friendIds = friendRows.map((r) => (r.requesterId === me ? r.receiverId : r.requesterId));
    const friendSet = new Set(friendIds);

    const myComms = await prisma.communityMember.findMany({
      where: { userId: me },
      include: { community: { select: { id: true, name: true } } },
    });
    const myCommIds = myComms.map((c) => c.communityId);
    const commNameById = new Map(myComms.map((c) => [c.communityId, c.community?.name]));

    const myGroups = await prisma.userOnChat.findMany({
      where: { userId: me, chat: { isGroup: true, isCommunity: false } },
      include: { chat: { select: { id: true, name: true } } },
    });
    const myGroupIds = myGroups.map((g) => g.chatId);
    const groupNameById = new Map(myGroups.map((g) => [g.chatId, g.chat?.name || 'Group']));

    // All my community/group co-member user-ids — bounded by my comms/groups,
    // not the submitter pool. Subtract friends and self.
    const [coCommRows, coGroupRows] = await Promise.all([
      myCommIds.length
        ? prisma.communityMember.findMany({
            where: { communityId: { in: myCommIds }, NOT: { userId: me } },
            select: { userId: true },
          })
        : Promise.resolve([]),
      myGroupIds.length
        ? prisma.userOnChat.findMany({
            where: { chatId: { in: myGroupIds }, NOT: { userId: me } },
            select: { userId: true },
          })
        : Promise.resolve([]),
    ]);
    const sharedSet = new Set([
      ...coCommRows.map((r) => r.userId),
      ...coGroupRows.map((r) => r.userId),
    ]);
    for (const fid of friendIds) sharedSet.delete(fid); // friends always win tier 1
    sharedSet.delete(me);

    const sharedIds = [...sharedSet];

    // ---- Helper: per-user submissions for a fixed candidate set, ordered ----
    // Returns array of { userId, uploadedCount, latestAt } ordered by latestAt
    // (sortDir) then by userId asc as the stable tiebreaker.
    async function rankUsers(candidateIds) {
      if (candidateIds.length === 0) return [];
      const groups = await prisma.submission.groupBy({
        by: ['userId'],
        where: {
          challengeId: challenge.id,
          userId: { in: candidateIds, not: me },
          createdAt: { gte: win.startUTC, lte: win.endUTC },
        },
        _max: { createdAt: true },
        _count: { _all: true },
      });
      // Tiebreaker MUST be deterministic — Prisma orderBy on userId works,
      // but doing the sort in JS keeps the by/orderBy simple across versions.
      groups.sort((a, b) => {
        const ta = a._max?.createdAt ? new Date(a._max.createdAt).getTime() : 0;
        const tb = b._max?.createdAt ? new Date(b._max.createdAt).getTime() : 0;
        if (ta !== tb) return sortDir === 'desc' ? tb - ta : ta - tb;
        return a.userId - b.userId;
      });
      return groups.map((g) => ({
        userId: g.userId,
        uploadedCount: g._count?._all || 0,
        latestAt: g._max?.createdAt || null,
      }));
    }

    // ---- Tier 1 + Tier 2 — bounded by my social graph, fully materialised ----
    const t1 = await rankUsers(friendIds);
    const t2 = await rankUsers(sharedIds);
    const t1IdSet = new Set(t1.map((u) => u.userId));
    const t2IdSet = new Set(t2.map((u) => u.userId));

    // ---- Total distinct submitters (excluding me) — single COUNT, no NOT IN ----
    const totalRows = await prisma.$queryRaw`
      SELECT COUNT(DISTINCT \`userId\`) AS c
      FROM \`Submission\`
      WHERE \`challengeId\` = ${challenge.id}
        AND \`userId\` != ${me}
        AND \`createdAt\` >= ${win.startUTC}
        AND \`createdAt\` <= ${win.endUTC}
    `;
    const totalDistinct = (() => {
      const r = Array.isArray(totalRows) ? totalRows[0] : null;
      if (!r) return 0;
      const v = r.c ?? r.C ?? Object.values(r)[0];
      return typeof v === 'bigint' ? Number(v) : Number(v) || 0;
    })();
    const t3Count = Math.max(0, totalDistinct - t1.length - t2.length);
    const total   = totalDistinct;
    const t12IdsForNotIn = [...t1IdSet, ...t2IdSet];

    // ---- Walk tiers to assemble the requested page ----
    let take = pageSize;
    let cursor = skip;
    const pageRows = []; // each: { userId, uploadedCount, latestAt, tier }

    function drainFrom(list, tierLabel) {
      if (cursor < list.length && take > 0) {
        const slice = list.slice(cursor, cursor + take);
        for (const e of slice) pageRows.push({ ...e, tier: tierLabel });
        take -= slice.length;
        cursor = 0;
      } else {
        cursor = Math.max(0, cursor - list.length);
      }
    }

    drainFrom(t1, 'friend');
    drainFrom(t2, 'shared');

    if (take > 0 && t3Count > 0) {
      // Tier 3 — page slice via groupBy with offset/limit. Excludes t1+t2 ids.
      const t3Slice = await prisma.submission.groupBy({
        by: ['userId'],
        where: {
          challengeId: challenge.id,
          userId: {
            not: me,
            ...(t12IdsForNotIn.length ? { notIn: t12IdsForNotIn } : {}),
          },
          createdAt: { gte: win.startUTC, lte: win.endUTC },
        },
        _max: { createdAt: true },
        _count: { _all: true },
        orderBy: [{ _max: { createdAt: sortDir } }, { userId: 'asc' }],
        skip: cursor,
        take,
      });
      for (const g of t3Slice) {
        pageRows.push({
          userId: g.userId,
          uploadedCount: g._count?._all || 0,
          latestAt: g._max?.createdAt || null,
          tier: 'other',
        });
      }
    }

    // ---- Hydrate page user info (only for the small page slice) ----
    const pageUserIds = pageRows.map((r) => r.userId);
    if (pageUserIds.length === 0) {
      return res.json({
        items: [],
        page, pageSize, total, hasMore: false,
        requiredCount: required,
      });
    }

    const users = await prisma.user.findMany({
      where: { id: { in: pageUserIds } },
      select: {
        id: true, username: true, firstName: true, lastName: true,
        totalPoints: true,
        minime: {
          where: { isSaved: true },
          orderBy: { updatedAt: 'desc' },
          select: { avatarUrl: true },
          take: 1,
        },
      },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    // earnedPoints — ledger, just for the page slice
    const ledgerRows = await prisma.pointsLedger.findMany({
      where: {
        userId: { in: pageUserIds },
        createdAt: { gte: win.startUTC, lte: win.endUTC },
        reason: 'CHALLENGE_COMPLETION',
        refId: challenge.id,
      },
      select: { userId: true, finalPoints: true },
    });
    const earnedByUser = new Map();
    for (const r of ledgerRows) {
      earnedByUser.set(r.userId, (earnedByUser.get(r.userId) || 0) + (r.finalPoints || 0));
    }

    // weekly points — page slice only
    const { getWeeklyPointsForUsers } = require('../utils/weeklyPoints');
    const weekMapRaw = await getWeeklyPointsForUsers(pageUserIds);
    const weekMap =
      weekMapRaw instanceof Map
        ? weekMapRaw
        : new Map(Object.entries(weekMapRaw || {}).map(([k, v]) => [Number(k), Number(v) || 0]));

    // Per-user shared communities/groups (names) — only for the page slice.
    const sharedCommByUser = new Map();
    const sharedGroupByUser = new Map();
    if (myCommIds.length) {
      const rows = await prisma.communityMember.findMany({
        where: { userId: { in: pageUserIds }, communityId: { in: myCommIds } },
        select: { userId: true, communityId: true },
      });
      for (const r of rows) {
        const name = commNameById.get(r.communityId);
        if (!name) continue;
        const list = sharedCommByUser.get(r.userId) || [];
        if (!list.includes(name)) list.push(name);
        sharedCommByUser.set(r.userId, list);
      }
    }
    if (myGroupIds.length) {
      const rows = await prisma.userOnChat.findMany({
        where: { userId: { in: pageUserIds }, chatId: { in: myGroupIds } },
        select: { userId: true, chatId: true },
      });
      for (const r of rows) {
        const name = groupNameById.get(r.chatId);
        if (!name) continue;
        const list = sharedGroupByUser.get(r.userId) || [];
        if (!list.includes(name)) list.push(name);
        sharedGroupByUser.set(r.userId, list);
      }
    }

    const items = pageRows.map((row) => {
      const u = userById.get(row.userId);
      const uploadedCount = row.uploadedCount;
      const sharedCommunities = sharedCommByUser.get(row.userId) || [];
      const sharedGroups      = sharedGroupByUser.get(row.userId) || [];
      const isFriend = friendSet.has(row.userId);
      const badges = [];
      if (isFriend) badges.push('Friend');
      badges.push(...sharedCommunities.slice(0, 2));
      badges.push(...sharedGroups.slice(0, 2));
      return {
        userId: row.userId,
        username: `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || u?.username || '',
        avatarUrl: firstAvatar(u?.minime),
        uploadedCount,
        completed: uploadedCount >= required,
        earnedPoints: earnedByUser.get(row.userId) ?? 0,
        weeklyPoints: weekMap.get(row.userId) ?? 0,
        totalPoints: u?.totalPoints ?? 0,
        relationship: {
          isFriend,
          sharedCommunities,
          sharedGroups,
          badges,
        },
        submittedAt: row.latestAt,
      };
    });

    const hasMore = skip + items.length < total;

    return res.json({
      items,
      page,
      pageSize,
      total,
      hasMore,
      requiredCount: required, // kept for back-compat
    });
  } catch (err) {
    console.error('getSubmissions error:', err);
    return res.status(500).json({ error: 'Failed to fetch submissions' });
  }
};
// controllers/challengeController.js

exports.getMySubmission = async (req, res) => {
  try {
    const userId = req.authData.id;
    const challengeId = parseInt(req.params.challengeId, 10);
    if (!Number.isFinite(challengeId)) {
      return res.status(400).json({ error: 'Invalid challengeId' });
    }

    // challenge meta
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { id: true, frequency: true, requiredPhotos: true },
    });
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });

    const zone = currentZone(req);

    // ---- Window resolve ----
    // default: এখনকার উইন্ডো (DAILY=আজ, WEEKLY=এই সপ্তাহ Sun→Sat)
    // optional override: ?week=YYYY-MM-DD (ওই তারিখ যে উইকে পড়ে, সেই উইক নেবে)
    const overrideWeek = req.query.week ? new Date(req.query.week) : null;

    let window;
    if (challenge.frequency === 'DAILY') {
      // daily: আজকেই ধরো (overrideWeek থাকলেও daily-তে দরকার নেই)
      const now = new Date();
      window = { startUTC: startOfDayInZone(now, zone), endUTC: endOfDayInZone(now, zone) };
    } else {
      // weekly: override থাকলে ওই তারিখের সপ্তাহ, না হলে কারেন্ট সপ্তাহ
      const base = overrideWeek && !isNaN(overrideWeek) ? overrideWeek : new Date();
      window = getWeekStartEndInZone(base, zone);
    }

    const submissions = await prisma.submission.findMany({
      where: {
        userId,
        challengeId: challenge.id,
        createdAt: { gte: window.startUTC, lte: window.endUTC },
      },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({
      items: submissions,
      count: submissions.length,
      frequency: challenge.frequency,
      requiredCount: challenge.requiredPhotos || 1,
      window: {
        startUTC: window.startUTC,
        endUTC: window.endUTC,
        zone,
      },
    });
  } catch (err) {
    console.error('getMySubmission error:', err);
    return res.status(500).json({ error: 'Failed to fetch my submissions' });
  }
};

// ------------------ History (In Progress + Completed tabs) ------------------
//
// GET /api/challenges/history?tab=in_progress|completed
//                            [&frequency=all|daily|weekly]
//                            [&page=1&pageSize=20]
//
// Returns the user's full submission history aggregated per
// (challenge, window). Window = the day for DAILY challenges, the Sunday-start
// week for WEEKLY — using the same zone helpers that drive assignment, so
// historical buckets line up with the original assignment windows.
//
// Item shape mirrors getFilteredChallenges so the existing card widget on
// Flutter renders these unchanged. Extras (submissionMediaUrls, submittedAt)
// are appended for the history view's photo strip; old clients ignore them.
//
// Why no schema change:
//   • Submission rows already carry { userId, challengeId, mediaUrl, createdAt }
//   • Orphan-guard already keeps each Submission.mediaUrl alive forever
//     ([utils/s3Cleanup.js:26]) — every user's photos are preserved per-user
//   • Nothing in the codebase ever deletes Submission rows except User cascade
//     on account-delete, so this is true long-term history.
exports.getChallengeHistory = async (req, res) => {
  try {
    const userId = req.authData.id;
    const tab = String(req.query.tab || 'completed').toLowerCase();
    if (tab !== 'in_progress' && tab !== 'completed') {
      return res.status(400).json({ error: "tab must be 'in_progress' or 'completed'" });
    }
    const freqFilter = String(req.query.frequency || 'all').toLowerCase();
    if (!['all', 'daily', 'weekly'].includes(freqFilter)) {
      return res.status(400).json({ error: "frequency must be 'all', 'daily', or 'weekly'" });
    }
    const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize, 10) || 20));

    const zone = currentZone(req);
    const now  = new Date();

    // 1) Pull every submission the user has made, newest first, with the
    // challenge meta needed to compute windowKey + status.
    const whereClause = {
      userId,
      ...(freqFilter !== 'all'
        ? { challenge: { frequency: freqFilter === 'daily' ? 'DAILY' : 'WEEKLY' } }
        : {}),
    };
    const submissions = await prisma.submission.findMany({
      where: whereClause,
      include: {
        challenge: {
          select: {
            id: true, title: true, description: true, frequency: true,
            tier: true, points: true, requiredPhotos: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // 2) Group by (challengeId, windowKey).
    const groups = new Map(); // key → { challenge, windowKey, submissions[] }
    for (const s of submissions) {
      if (!s.challenge) continue;
      const wk = s.challenge.frequency === 'DAILY'
        ? dateKeyInZone(s.createdAt, zone)
        : weekKeyInZone(s.createdAt, zone);
      const gKey = `${s.challengeId}|${wk}`;
      let g = groups.get(gKey);
      if (!g) {
        g = { challenge: s.challenge, windowKey: wk, submissions: [] };
        groups.set(gKey, g);
      }
      g.submissions.push(s);
    }

    // 3) Build cards and filter by tab.
    const currentDailyKey  = dateKeyInZone(now, zone);
    const currentWeeklyKey = weekKeyInZone(now, zone);

    const cards = [];
    for (const g of groups.values()) {
      const requiredCount = g.challenge.requiredPhotos || 1;
      const uploadedCount = g.submissions.length;
      const status =
        uploadedCount >= requiredCount ? 'completed'
        : uploadedCount > 0            ? 'in_progress'
        : 'incomplete';

      if (tab === 'completed'  && status !== 'completed')  continue;
      if (tab === 'in_progress' && status !== 'in_progress') continue;

      const isCurrentWindow =
        (g.challenge.frequency === 'DAILY'  && g.windowKey === currentDailyKey) ||
        (g.challenge.frequency === 'WEEKLY' && g.windowKey === currentWeeklyKey);

      // Most-recent submission first inside the group → submittedAt reflects
      // the latest activity (sort key + display).
      const latestAt = g.submissions[0].createdAt;

      cards.push({
        id: g.challenge.id,
        title: g.challenge.title,
        preview: (g.challenge.description || '').slice(0, 120),
        frequency: g.challenge.frequency,
        tier: g.challenge.tier,
        points: g.challenge.points,
        requiredCount,
        uploadedCount,
        status,
        // 0 for past-window cards — no time left to add more photos
        timeRemainingMs: isCurrentWindow
          ? timeRemainingMs(g.challenge.frequency, zone, now)
          : 0,
        windowKey: g.windowKey,
        zone,
        // Extras for the history view (FE may ignore safely):
        submittedAt: latestAt,
        // Photos this user uploaded for this window — preserved forever.
        submissionMediaUrls: g.submissions
          .map((s) => s.mediaUrl)
          .filter(Boolean)
          .reverse(), // oldest→newest order for a clean strip
      });
    }

    // 4) Sort by submittedAt desc (newest activity first).
    cards.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    // 5) Paginate.
    const total = cards.length;
    const start = (page - 1) * pageSize;
    const items = cards.slice(start, start + pageSize);

    return res.json({
      items,
      total,
      page,
      pageSize,
      hasMore: start + items.length < total,
    });
  } catch (err) {
    console.error('getChallengeHistory error:', err);
    return res.status(500).json({ error: 'Failed to fetch challenge history' });
  }
};
