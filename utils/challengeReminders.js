// Push reminders for users who were assigned a daily/weekly challenge but
// haven't completed it yet, fired a few hours before the window closes.
//
// Triggered by cron jobs in server.js:
//   - Daily reminder   → 20:00 Boston (4 hours before midnight reset)
//   - Weekly reminder  → Saturday 18:00 Boston (~30 hours before week roll)
//
// Idempotent — we look up an existing Notification of the same type for the
// same user within the current window before sending a fresh one.

const { PrismaClient } = require('@prisma/client');
const { notifyUser } = require('./notificationService');
const {
  getAssignedChallenge,
  resolveZone,
  startOfDayInZone,
  endOfDayInZone,
  getWeekStartEndInZone,
  dateKeyInZone,
  weekKeyInZone,
} = require('./challenges');

const prisma = new PrismaClient();

const REMINDER_TYPES = {
  DAILY: 'DAILY_CHALLENGE_REMINDER',
  WEEKLY: 'WEEKLY_CHALLENGE_REMINDER',
};

async function alreadyReminded(userId, type, windowStart) {
  const existing = await prisma.notification.findFirst({
    where: { userId, type, createdAt: { gte: windowStart } },
    select: { id: true },
  });
  return !!existing;
}

// Returns submission count for (user, challenge) inside the active window.
async function submissionsInWindow(userId, challengeId, startUTC, endUTC) {
  return prisma.submission.count({
    where: { userId, challengeId, createdAt: { gte: startUTC, lte: endUTC } },
  });
}

// Format a friendly remaining-time string ("3h 45m"). Returns "<1m" near zero.
function fmtRemaining(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// Deterministic-ish variant picker: same user + same day + same kind → same
// hook; different days/kinds rotate so users don't see identical copy twice.
function seededPick(arr, seed) {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return arr[Math.abs(h) % arr.length];
}

// ---- Hook copy variants — daily ----
const DAILY_VARIANTS = {
  partial: [
    { t: '⏰ {challenge} closes in {rem}', b: ({pts, need, cnt, req}) => `${cnt}/${req} done. ${need} more snap${need===1?'':'s'} = ${pts} pts.` },
    { t: '🎯 Almost there — {rem} left today', b: ({pts, need, cnt, req}) => `${cnt}/${req} captured. Finish the last ${need} for ${pts} pts.` },
    { t: '🔥 Don\'t lose your streak', b: ({pts, need, rem}) => `${need} more spot${need===1?'':'s'} in the next ${rem} earns you ${pts} pts.` },
    { t: '📸 {rem} to lock in points', b: ({pts, need}) => `Need ${need} more for today\'s challenge. ${pts} pts on the line.` },
  ],
  fresh: [
    { t: '⏰ Today\'s challenge ends in {rem}', b: ({title, pts}) => `${title} — earn ${pts} pts before midnight.` },
    { t: '🎯 Don\'t miss today\'s {pts} pts', b: ({title, rem}) => `${title}. ${rem} left to claim them.` },
    { t: '🔥 Quick win before midnight', b: ({title, pts}) => `${title}. One snap, ${pts} pts on your weekly total.` },
    { t: '📸 {rem} to climb the board', b: ({title, pts}) => `${title} pays ${pts} pts. Every point counts this week.` },
    { t: '✨ Today\'s pick: {title}', b: ({pts, rem}) => `Snap it before ${rem} — banks ${pts} pts toward the leaderboard.` },
  ],
};

// ---- Hook copy variants — weekly ----
const WEEKLY_VARIANTS = {
  partial: [
    { t: '📅 Weekly challenge — {rem} left', b: ({title, cnt, req, need, pts}) => `${title}: ${cnt}/${req}. ${need} more for ${pts} pts.` },
    { t: '🏆 Finish your week strong', b: ({cnt, req, need, pts}) => `You\'ve done ${cnt}/${req}. ${need} more spot${need===1?'':'s'} = ${pts} pts.` },
    { t: '⚡ Halfway there — keep going', b: ({title, need, pts}) => `${need} more for ${title}. ${pts} pts waiting.` },
    { t: '📍 So close to the bonus', b: ({title, cnt, req, pts}) => `${title} — ${cnt} of ${req} done. Finish for ${pts} pts.` },
  ],
  fresh: [
    { t: '📅 This week\'s challenge ends in {rem}', b: ({title, pts}) => `${title}. ${pts} pts before the week closes.` },
    { t: '🏆 Big weekly bonus — {pts} pts', b: ({title, rem}) => `${title}. ${rem} left to grab the bonus.` },
    { t: '⚡ Multi-stop bonus expiring', b: ({title, pts}) => `${title}. Lock in ${pts} pts before Monday rolls in.` },
    { t: '📍 Take the weekly streak', b: ({title, pts, rem}) => `${title} pays ${pts} pts. ${rem} to make it count.` },
  ],
};

function fillTemplate(s, ctx) {
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null ? String(ctx[k]) : ''));
}

function buildDailyMessage({ challenge, cnt, required, remainingMs, seedExtra = '' }) {
  const need = required - cnt;
  const rem = fmtRemaining(remainingMs);
  const ctx = { title: challenge.title, pts: challenge.points, need, cnt, req: required, rem };
  const variants = cnt > 0 ? DAILY_VARIANTS.partial : DAILY_VARIANTS.fresh;
  const v = seededPick(variants, `daily|${challenge.id}|${seedExtra}`);
  return { title: fillTemplate(v.t, ctx), body: typeof v.b === 'function' ? v.b(ctx) : fillTemplate(v.b, ctx) };
}

function buildWeeklyMessage({ challenge, cnt, required, remainingMs, seedExtra = '' }) {
  const need = required - cnt;
  const rem = fmtRemaining(remainingMs);
  const ctx = { title: challenge.title, pts: challenge.points, need, cnt, req: required, rem };
  const variants = cnt > 0 ? WEEKLY_VARIANTS.partial : WEEKLY_VARIANTS.fresh;
  const v = seededPick(variants, `weekly|${challenge.id}|${seedExtra}`);
  return { title: fillTemplate(v.t, ctx), body: typeof v.b === 'function' ? v.b(ctx) : fillTemplate(v.b, ctx) };
}

async function sendDailyReminders(timezone = 'America/New_York') {
  const zone = resolveZone(timezone);
  const now = new Date();
  const dayStart = startOfDayInZone(now, zone);
  const dayEnd = endOfDayInZone(now, zone);
  const windowKey = dateKeyInZone(now, zone);
  const remainingMs = dayEnd.getTime() - now.getTime();

  // Only users who can actually receive a push.
  const users = await prisma.user.findMany({
    where: { fcmToken: { not: null }, NOT: { fcmToken: '' } },
    select: { id: true, notificationEnabled: true },
  });

  let candidates = 0, sent = 0, alreadyDone = 0, alreadyReminded_ = 0, noChallenge = 0;

  for (const user of users) {
    if (user.notificationEnabled === false) continue;
    candidates++;
    try {
      const assignment = await getAssignedChallenge(prisma, user.id, 'DAILY', zone, now);
      const challenge = assignment?.challenge;
      if (!challenge) { noChallenge++; continue; }

      const cnt = await submissionsInWindow(user.id, challenge.id, dayStart, dayEnd);
      const required = challenge.requiredPhotos || 1;
      if (cnt >= required) { alreadyDone++; continue; }

      if (await alreadyReminded(user.id, REMINDER_TYPES.DAILY, dayStart)) {
        alreadyReminded_++;
        continue;
      }

      const { title, body: description } = buildDailyMessage({
        challenge, cnt, required, remainingMs,
        seedExtra: `${windowKey}|${user.id}`,
      });

      await notifyUser(user.id, REMINDER_TYPES.DAILY, title, description, {
        challengeId: challenge.id,
        frequency: 'DAILY',
        points: challenge.points,
        windowKey,
        requiredPhotos: required,
        completedPhotos: cnt,
        remainingMs,
      });
      sent++;
    } catch (err) {
      console.error(`[dailyReminder] user=${user.id} failed:`, err.message);
    }
  }

  return { kind: 'daily', candidates, sent, alreadyDone, alreadyReminded: alreadyReminded_, noChallenge };
}

async function sendWeeklyReminders(timezone = 'America/New_York') {
  const zone = resolveZone(timezone);
  const now = new Date();
  const { startUTC: weekStart, endUTC: weekEnd } = getWeekStartEndInZone(now, zone);
  const windowKey = weekKeyInZone(now, zone);
  const remainingMs = weekEnd.getTime() - now.getTime();

  const users = await prisma.user.findMany({
    where: { fcmToken: { not: null }, NOT: { fcmToken: '' } },
    select: { id: true, notificationEnabled: true },
  });

  let candidates = 0, sent = 0, alreadyDone = 0, alreadyReminded_ = 0, noChallenge = 0;

  for (const user of users) {
    if (user.notificationEnabled === false) continue;
    candidates++;
    try {
      const assignment = await getAssignedChallenge(prisma, user.id, 'WEEKLY', zone, now);
      const challenge = assignment?.challenge;
      if (!challenge) { noChallenge++; continue; }

      const cnt = await submissionsInWindow(user.id, challenge.id, weekStart, weekEnd);
      const required = challenge.requiredPhotos || 1;
      if (cnt >= required) { alreadyDone++; continue; }

      if (await alreadyReminded(user.id, REMINDER_TYPES.WEEKLY, weekStart)) {
        alreadyReminded_++;
        continue;
      }

      const { title, body: description } = buildWeeklyMessage({
        challenge, cnt, required, remainingMs,
        seedExtra: `${windowKey}|${user.id}`,
      });

      await notifyUser(user.id, REMINDER_TYPES.WEEKLY, title, description, {
        challengeId: challenge.id,
        frequency: 'WEEKLY',
        points: challenge.points,
        windowKey,
        requiredPhotos: required,
        completedPhotos: cnt,
        remainingMs,
      });
      sent++;
    } catch (err) {
      console.error(`[weeklyReminder] user=${user.id} failed:`, err.message);
    }
  }

  return { kind: 'weekly', candidates, sent, alreadyDone, alreadyReminded: alreadyReminded_, noChallenge };
}

module.exports = {
  sendDailyReminders,
  sendWeeklyReminders,
  REMINDER_TYPES,
  // exported for unit tests
  buildDailyMessage,
  buildWeeklyMessage,
};
