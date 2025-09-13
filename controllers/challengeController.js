// controllers/challengeController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const uploadToS3 = require('../utils/s3Upload'); // তোমারটা ব্যবহার করো
const { addPointsWithMultiplier } = require('../utils/points');
const { notifyNewChallenge } = require('../utils/challengeNotifications');

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

    const s3Url = await uploadToS3(req.file, 'challenge-submissions');

    try {
      const result = await prisma.$transaction(async (tx) => {
  
        const countBefore = await tx.submission.count({
          where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
        });
        if (countBefore >= required) {
          // someone else completed in parallel
          const err = new Error('LIMIT_REACHED');
          err.code = 'LIMIT_REACHED';
          throw err;
        }


        const submission = await tx.submission.create({
          data: { userId, challengeId: challenge.id, mediaUrl: s3Url }
        });

        const newCount = await tx.submission.count({
          where: { userId, challengeId: challenge.id, createdAt: { gte: window.startUTC, lte: window.endUTC } },
        });

        if (newCount > required) {
          // went over the cap due to a concurrent insert — rollback the whole tx
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
       
          }
        }

        return { submission, newCount, awarded };
      }, { timeout: 15000 });

      return res.json({
        message: 'Submission saved',
        submission: result.submission,
        uploadedCount: result.newCount,
        requiredCount: required,
        isCompleted: result.newCount >= required,
        pointsAwarded: result.awarded ? challenge.points : 0,
        tier: challenge.tier,
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

    // 1) challenge + window (daily/week)
    const challenge = await prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { id: true, frequency: true, requiredPhotos: true, points: true },
    });
    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });

    const zone = currentZone(req);
    const now = new Date();
    const window =
      challenge.frequency === 'DAILY'
        ? { startUTC: startOfDayInZone(now, zone), endUTC: endOfDayInZone(now, zone) }
        : getWeekStartEndInZone(now, zone);
    const required = challenge.requiredPhotos || 1;

    // 2) this window-এর সব submissions (others only), সাথে basic user info
    const subs = await prisma.submission.findMany({
      where: {
        challengeId: challenge.id,
        userId: { not: me },
        createdAt: { gte: window.startUTC, lte: window.endUTC },
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            totalPoints: true,
            minime: {
              where: { isSaved: true },
              orderBy: { updatedAt: 'desc' },
              select: { avatarUrl: true },
              take: 1,
            },
          },
        },
      },
    });

    // 3) per-user aggregate
    const perUserCount = new Map();
    const perUserInfo = new Map();
    for (const s of subs) {
      const u = s.user;
      if (!u) continue;
      perUserInfo.set(u.id, u);
      perUserCount.set(u.id, (perUserCount.get(u.id) || 0) + 1);
    }
    const submitterIds = Array.from(perUserInfo.keys());
    if (!submitterIds.length) return res.json({ items: [] });

    // 4) earnedPoints (this window, this challenge only) — ledger থেকে
    const ledgerRows = await prisma.pointsLedger.findMany({
      where: {
        userId: { in: submitterIds },
        createdAt: { gte: window.startUTC, lte: window.endUTC },
        reason: 'CHALLENGE_COMPLETION',
        refId: challenge.id,
      },
      select: { userId: true, finalPoints: true },
    });
    const earnedByUser = ledgerRows.reduce((m, r) => {
      m.set(r.userId, (m.get(r.userId) || 0) + (r.finalPoints || 0));
      return m;
    }, new Map());

    // 5) weeklyPoints (batch helper)
    const { getWeeklyPointsForUsers } = require('../utils/weeklyPoints');
    const weekMapRaw = await getWeeklyPointsForUsers(submitterIds);
    // normalize Map
    const weekMap =
      weekMapRaw instanceof Map
        ? weekMapRaw
        : new Map(Object.entries(weekMapRaw || {}).map(([k, v]) => [Number(k), Number(v) || 0]));

    // friends
    const friendRows = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: me, receiverId: { in: submitterIds } },
          { receiverId: me, requesterId: { in: submitterIds } },
        ],
      },
      select: { requesterId: true, receiverId: true },
    });
    const friendSet = new Set(
      friendRows.map((r) => (r.requesterId === me ? r.receiverId : r.requesterId))
    );

   
    const myComms = await prisma.communityMember.findMany({
      where: { userId: me },
      include: { community: { select: { id: true, name: true } } },
    });
    const myCommIds = myComms.map((c) => c.communityId);
    const commNameById = new Map(myComms.map((c) => [c.communityId, c.community.name]));

  
    const sharedCommRows =
      myCommIds.length > 0
        ? await prisma.communityMember.findMany({
            where: { userId: { in: submitterIds }, communityId: { in: myCommIds } },
            select: { userId: true, communityId: true },
          })
        : [];
    const sharedCommunitiesByUser = new Map();
    for (const row of sharedCommRows) {
      const list = sharedCommunitiesByUser.get(row.userId) || [];
      const name = commNameById.get(row.communityId);
      if (name && !list.includes(name)) list.push(name);
      sharedCommunitiesByUser.set(row.userId, list);
    }

    const myGroups = await prisma.userOnChat.findMany({
      where: { userId: me, chat: { isGroup: true, isCommunity: false } },
      include: { chat: { select: { id: true, name: true } } },
    });
    const myGroupIds = myGroups.map((g) => g.chatId);
    const groupNameById = new Map(myGroups.map((g) => [g.chatId, g.chat.name || 'Group']));

    
    const sharedGroupRows =
      myGroupIds.length > 0
        ? await prisma.userOnChat.findMany({
            where: { userId: { in: submitterIds }, chatId: { in: myGroupIds } },
            select: { userId: true, chatId: true },
          })
        : [];
    const sharedGroupsByUser = new Map();
    for (const row of sharedGroupRows) {
      const list = sharedGroupsByUser.get(row.userId) || [];
      const gname = groupNameById.get(row.chatId);
      if (gname && !list.includes(gname)) list.push(gname);
      sharedGroupsByUser.set(row.userId, list);
    }

    const buildBadges = (uid) => {
      const badges = [];
      if (friendSet.has(uid)) badges.push('Friend');
      const comms = (sharedCommunitiesByUser.get(uid) || []).slice(0, 2);
      const groups = (sharedGroupsByUser.get(uid) || []).slice(0, 2);
      return [...badges, ...comms, ...groups]; 
    };

    const items = submitterIds
      .map((uid) => {
        const u = perUserInfo.get(uid);
        const uploadedCount = perUserCount.get(uid) || 0;
        return {
          userId: uid,
          username: u?.username || '',
          avatarUrl: firstAvatar(u?.minime),
          uploadedCount,
          completed: uploadedCount >= required,
          earnedPoints: earnedByUser.get(uid) ?? 0,
          weeklyPoints: weekMap.get(uid) ?? 0,
          totalPoints: u?.totalPoints ?? 0,
          relationship: {
            isFriend: friendSet.has(uid),
            sharedCommunities: sharedCommunitiesByUser.get(uid) || [],
            sharedGroups: sharedGroupsByUser.get(uid) || [],
            badges: buildBadges(uid),
          },
        };
      })
    
      .sort(
        (a, b) =>
          (b.completed - a.completed) ||
          (b.weeklyPoints - a.weeklyPoints) ||
          String(a.username).localeCompare(String(b.username))
      )
      .slice(0, 100);

    return res.json({ items, requiredCount: required });
  } catch (err) {
    console.error('getSubmissions (updated) error:', err);
    return res.status(500).json({ error: 'Failed to fetch submissions' });
  }
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

// ------------------ Manual Challenge Notifications (for testing/admin) ------------------
exports.sendChallengeNotifications = async (req, res) => {
  try {
    const { type } = req.body; // 'daily' or 'weekly'
    const { notifyAllUsersAboutDailyChallenge, notifyAllUsersAboutWeeklyChallenge } = require('../utils/challengeNotifications');
    
    if (!type || !['daily', 'weekly'].includes(type)) {
      return res.status(400).json({ 
        error: 'Invalid type. Must be "daily" or "weekly"' 
      });
    }

    let result;
    if (type === 'daily') {
      result = await notifyAllUsersAboutDailyChallenge();
    } else {
      result = await notifyAllUsersAboutWeeklyChallenge();
    }

    res.json({ 
      success: true, 
      message: `${type} challenge notifications sent successfully`,
      type 
    });
  } catch (error) {
    console.error('Send challenge notifications error:', error);
    res.status(500).json({ 
      error: 'Failed to send challenge notifications',
      details: error.message 
    });
  }
};

// ------------------ Individual Challenge Notification (for testing) ------------------
exports.sendChallengeNotificationToUser = async (req, res) => {
  try {
    const userId = req.authData.id; // Current authenticated user
    const { frequency } = req.body; // 'DAILY' or 'WEEKLY'
    
    if (!frequency || !['DAILY', 'WEEKLY'].includes(frequency)) {
      return res.status(400).json({ 
        error: 'Invalid frequency. Must be "DAILY" or "WEEKLY"' 
      });
    }

    const zone = currentZone(req);
    const now = new Date();
    
    const assignment = await getAssignedChallenge(prisma, userId, frequency, zone, now);
    
    if (!assignment?.challenge) {
      return res.status(404).json({ 
        error: `No ${frequency.toLowerCase()} challenge available` 
      });
    }

    await notifyNewChallenge(userId, assignment.challenge, frequency);

    res.json({ 
      success: true, 
      message: `${frequency.toLowerCase()} challenge notification sent`,
      challenge: {
        id: assignment.challenge.id,
        title: assignment.challenge.title,
        points: assignment.challenge.points
      }
    });
  } catch (error) {
    console.error('Send individual challenge notification error:', error);
    res.status(500).json({ 
      error: 'Failed to send challenge notification',
      details: error.message 
    });
  }
};
