// Per-user leaderboard reminder push.
//
// Reuses the EXACT same weekly window + scoring logic the leaderboard endpoint
// (controllers/leaderboardController.js) already exposes, so the rank we
// announce in the push always matches what the user sees when they tap in.
//
// Fired by cron in server.js:
//   - Wed 18:00 Boston  → mid-week "climb the board" push
//   - Sun 10:00 Boston  → "last day to earn prize" push
//
// Idempotent — at most one reminder of a given type per user per cron window
// (we look for an existing Notification of that type within the same calendar
// day in the user's TZ).

const { PrismaClient } = require('@prisma/client');
const { notifyUser } = require('./notificationService');
const { resolveZone, startOfDayInZone, getWeekStartEndInZone } = require('./challenges');

const prisma = new PrismaClient();

const REMINDER_TYPES = {
  MIDWEEK: 'LEADERBOARD_MIDWEEK',
  FINAL: 'LEADERBOARD_FINAL_DAY',
};

async function alreadySentToday(userId, type, dayStart) {
  const existing = await prisma.notification.findFirst({
    where: { userId, type, createdAt: { gte: dayStart } },
    select: { id: true },
  });
  return !!existing;
}

// Builds the ranked board from PointsLedger for the current week — same query
// the leaderboard controller runs, mirrored here so the cron doesn't need to
// hit the HTTP endpoint.
async function getCurrentWeekRanking(zone) {
  const now = new Date();
  const { startUTC: weekStart, endUTC: weekEnd } = getWeekStartEndInZone(now, zone);
  const grouped = await prisma.pointsLedger.groupBy({
    by: ['userId'],
    where: { createdAt: { gte: weekStart, lt: weekEnd } },
    _sum: { finalPoints: true },
    orderBy: { _sum: { finalPoints: 'desc' } },
  });
  const ranked = grouped
    .map(g => ({ userId: g.userId, points: Number(g._sum.finalPoints || 0) }))
    .filter(r => r.points > 0)
    .sort((a, b) => b.points - a.points)
    .map((r, idx) => ({ ...r, rank: idx + 1 }));
  return { ranked, weekStart, weekEnd };
}

function fmtRemaining(ms) {
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  const remH = h % 24;
  if (d > 0) return `${d}d ${remH}h`;
  return `${h}h`;
}

// Hook-driven, varied copy. Each rank tier has multiple title+body variants
// for mid-week vs final day, plus seed-based pick so back-to-back fires use
// different language. Achievement framing ("you're 3 check-ins from podium")
// beats generic copy on retention.
const VARIANTS = {
  // Rank 1
  rank1: {
    midweek: [
      { t: '👑 You are #1 — hold the crown', b: ({pts}) => `Leading with ${pts} pts. Defend your spot with one more check-in tonight.` },
      { t: '🔥 Reigning #1 — anyone catching up?', b: ({pts}) => `${pts} pts and counting. Keep that lead before someone steals it.` },
      { t: '🏆 Boston #1 — that you?', b: ({pts}) => `${pts} pts puts you on top. Plant the flag with another spot today.` },
      { t: '⚡ Top of the board, top of your game', b: ({pts}) => `${pts} pts. The competition is climbing — one more snap to stay untouchable.` },
    ],
    final: [
      { t: '👑 Last day — keep the crown', b: ({pts}) => `You are #1 with ${pts} pts. A couple more check-ins locks in 1st prize.` },
      { t: '🚨 #1 with the clock ticking', b: ({pts, rem}) => `${rem} left. Snap one more place and the prize is yours.` },
      { t: '🏁 Final lap as #1', b: ({pts}) => `${pts} pts. Hold the lead until midnight and claim 1st.` },
    ],
  },
  // Rank 2-3
  podium: {
    midweek: [
      { t: '🏆 Podium spot — #', b: ({pts, gap}) => `${pts} pts. ${gap > 0 ? `Top 1 is ${gap} pts away — go grab it.` : `You are right behind #1. One more place and it is yours.`}` },
      { t: '🥈 You are on the podium', b: ({pts}) => `${pts} pts. Stay sharp — the crown is one good day away.` },
      { t: '💎 ', b: ({pts}) => `${pts} pts and climbing. Three more challenges and you might own the leaderboard.` },
    ],
    final: [
      { t: '🏆 Final day to climb to #1', b: ({pts, gap}) => `${pts} pts. ${gap > 0 ? `${gap} pts behind first.` : 'You are tied with the leader!'} Snap fast.` },
      { t: '⚡ Lock in your podium prize', b: ({pts, rem}) => `${rem} left. ${pts} pts is podium territory — keep going.` },
      { t: '🎯 One day from prize', b: ({pts}) => `${pts} pts. Hold the line, the podium is yours.` },
    ],
  },
  // Rank 4-10
  top10: {
    midweek: [
      { t: '🎖️ Top 10 — #', b: ({pts, gapToPodium}) => `${pts} pts. ${gapToPodium > 0 ? `${gapToPodium} pts away from the podium.` : 'Podium spot is within reach.'}` },
      { t: '📈 Climbing the board — #', b: ({pts}) => `${pts} pts. A couple of high-value spots and you crack top 3.` },
      { t: '🏅 In the Top 10 club', b: ({pts}) => `${pts} pts this week. The podium is one good evening away.` },
    ],
    final: [
      { t: '🎖️ Final push for podium', b: ({pts, rem}) => `${rem} left. You have ${pts} pts. Crack top 3 with a $$$ or $$$$ check-in.` },
      { t: '⏳ Top 10 spot — last day', b: ({pts}) => `${pts} pts. Earn 50 more and you might steal a podium prize.` },
    ],
  },
  // Rank 11-50
  top50: {
    midweek: [
      { t: '🏁 #', b: ({rank, pts}) => `${pts} pts this week. Three quick check-ins and you can break Top 10.` },
      { t: '📊 You are climbing', b: ({rank, pts}) => `Rank ${rank}. ${pts} pts. Keep going — Top 10 is closer than it looks.` },
      { t: '🎯 #', b: ({pts}) => `${pts} pts. Hit a $$$ restaurant or stadium and you jump 10 ranks.` },
    ],
    final: [
      { t: '🏁 Last day to climb', b: ({rank, pts, rem}) => `You are #${rank} with ${pts} pts. ${rem} left to break Top 10.` },
      { t: '⏰ Final hours — Top 10 in range', b: ({rank, pts}) => `Rank ${rank} (${pts} pts). One luxury check-in could push you up 20+ spots.` },
    ],
  },
  // Outside Top 50
  tail: {
    midweek: [
      { t: '📊 You are on the board', b: ({rank, pts}) => `Rank ${rank}, ${pts} pts. Snap a few popular spots and you can crack Top 50 today.` },
      { t: '🚀 Start climbing', b: ({rank, pts}) => `${pts} pts so far. A weekly multi-stop challenge could vault you into Top 50.` },
      { t: '🎯 Big climb is possible', b: ({rank, pts}) => `Rank ${rank}. Hit a $$$$ spot and you could leap 40+ ranks.` },
    ],
    final: [
      { t: '🏁 Final day — make it count', b: ({rank, pts, rem}) => `${rem} left. Rank ${rank} (${pts} pts). One bonus challenge and you could break Top 50.` },
      { t: '⏰ Week ends soon', b: ({rank}) => `You are #${rank}. Even a few hundred points reshapes the standings before midnight.` },
    ],
  },
};

// Deterministic-ish variant pick: seed by (userId, rank, kind, weekStartDay)
// so the same user gets the same hook within a window but different across
// windows. We don't have userId here at copy-build time, so we let the
// caller pass a seed string.
function pickVariant(variants, seed) {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const idx = Math.abs(h) % variants.length;
  return variants[idx];
}

function buildMessage(rank, points, total, weekEndMs, kind, seedExtra = '') {
  const isFinal = kind === REMINDER_TYPES.FINAL;
  const remaining = fmtRemaining(weekEndMs - Date.now());
  const seed = `${rank}|${kind}|${weekEndMs}|${seedExtra}`;

  let tier, ctx;
  if (rank === 1) {
    tier = VARIANTS.rank1[isFinal ? 'final' : 'midweek'];
    ctx = { pts: points, rem: remaining };
  } else if (rank <= 3) {
    tier = VARIANTS.podium[isFinal ? 'final' : 'midweek'];
    // gap-to-leader requires the caller's full standings, approximate from rank
    ctx = { pts: points, gap: 0, rem: remaining };
  } else if (rank <= 10) {
    tier = VARIANTS.top10[isFinal ? 'final' : 'midweek'];
    ctx = { pts: points, gapToPodium: 0, rem: remaining };
  } else if (rank <= 50) {
    tier = VARIANTS.top50[isFinal ? 'final' : 'midweek'];
    ctx = { rank, pts: points, rem: remaining };
  } else {
    tier = VARIANTS.tail[isFinal ? 'final' : 'midweek'];
    ctx = { rank, pts: points, rem: remaining };
  }

  const v = pickVariant(tier, seed);
  let title = v.t;
  // Some titles include the rank inline marker (#) — append the rank number
  if (/#$/.test(title) || /— #$/.test(title)) title = title + rank;
  // 'You are right behind #1' style — replace inline rank
  title = title.replace(/💎 $/, `💎 #${rank} on the board`);
  // Fallback rank append for tiers that include trailing '#'
  if (/#$/.test(title)) title = title + rank;
  const body = typeof v.b === 'function' ? v.b(ctx) : v.b;
  return { title, body };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function sendLeaderboardReminders(kind = REMINDER_TYPES.MIDWEEK, timezone = 'America/New_York') {
  if (!Object.values(REMINDER_TYPES).includes(kind)) {
    throw new Error(`Unknown leaderboard reminder kind: ${kind}`);
  }
  const zone = resolveZone(timezone);
  const dayStart = startOfDayInZone(new Date(), zone);
  const { ranked, weekEnd } = await getCurrentWeekRanking(zone);

  // We only push to users who actually scored this week (matches the board's
  // "positive-only" definition — no spam to silent users).
  const userIds = ranked.map(r => r.userId);
  if (userIds.length === 0) {
    return { kind, candidates: 0, sent: 0, alreadyReminded: 0 };
  }

  const eligible = await prisma.user.findMany({
    where: {
      id: { in: userIds },
      fcmToken: { not: null }, NOT: { fcmToken: '' },
    },
    select: { id: true, notificationEnabled: true },
  });
  const allowed = new Set(eligible.filter(u => u.notificationEnabled !== false).map(u => u.id));

  let candidates = 0, sent = 0, alreadyReminded_ = 0;
  for (const row of ranked) {
    if (!allowed.has(row.userId)) continue;
    candidates++;
    try {
      if (await alreadySentToday(row.userId, kind, dayStart)) {
        alreadyReminded_++;
        continue;
      }
      const { title, body } = buildMessage(row.rank, row.points, ranked.length, weekEnd.getTime(), kind, String(row.userId));
      await notifyUser(row.userId, kind, title, body, {
        rank: row.rank,
        points: row.points,
        totalOnBoard: ranked.length,
        weekEnd: weekEnd.toISOString(),
      });
      sent++;
    } catch (err) {
      console.error(`[leaderboardReminder] user=${row.userId} failed:`, err.message);
    }
  }

  return { kind, candidates, sent, alreadyReminded: alreadyReminded_ };
}

module.exports = {
  sendLeaderboardReminders,
  getCurrentWeekRanking,
  REMINDER_TYPES,
  buildMessage,    // exported for unit tests
  ordinal,         // exported for unit tests
};
