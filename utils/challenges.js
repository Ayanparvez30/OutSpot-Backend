// utils/challenges.js
const { DateTime } = require('luxon');
const { notifyUser } = require('../utils/notificationService'); // Import notification service

function resolveZone(userZone) {
  return userZone || process.env.APP_TIMEZONE || 'America/New_York';
}
function startOfDayInZone(now = new Date(), zone) {
  return DateTime.fromJSDate(now, { zone }).startOf('day').toUTC().toJSDate();
}
function endOfDayInZone(now = new Date(), zone) {
  return DateTime.fromJSDate(now, { zone }).endOf('day').toUTC().toJSDate();
}
// AFTER (US week: Sunday–Saturday)
function getWeekStartEndInZone(now = new Date(), zone) {
  const dt = DateTime.fromJSDate(now, { zone });
  const sundayStart = dt.minus({ days: dt.weekday % 7 }).startOf('day');
  const saturdayEnd = sundayStart.plus({ days: 6 }).endOf('day'); // ✅ Sat 23:59:59.999
  return { startUTC: sundayStart.toUTC().toJSDate(), endUTC: saturdayEnd.toUTC().toJSDate() };
}
function dateKeyInZone(now = new Date(), zone) {
  return DateTime.fromJSDate(now, { zone }).toFormat('yyyy-LL-dd');
}
function weekKeyInZone(now = new Date(), zone) {
  const dt = DateTime.fromJSDate(now, { zone });
  const sundayStart = dt.minus({ days: dt.weekday % 7 }).startOf('day');
  return sundayStart.toFormat('yyyy-LL-dd'); // label by week start (Sunday)
}
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t ^ (t >>> 7)) * (t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededPick(array, seedStr) {
  if (!array.length) return null;
  const seed = xmur3(seedStr)();
  const rand = mulberry32(seed);
  const idx = Math.floor(rand() * array.length);
  return array[idx];
}
async function maybeNotify(prisma, userId, assign, freq, zone) {
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
async function getAssignedChallenge(prisma, userId, frequency, zone, now = new Date()) {
  const list = await prisma.challenge.findMany({ where: { frequency }, orderBy: { id: 'asc' } });
  if (!list.length) return { challenge: null, windowKey: null };
  const windowKey = frequency === 'DAILY' ? dateKeyInZone(now, zone) : weekKeyInZone(now, zone);
  const seed = `${frequency}:${windowKey}:USER:${userId}`;
  const challenge = seededPick(list, seed);

  // Create notifications for assigned challenges if not already present
  await maybeNotify(prisma, userId, { challenge }, frequency, zone);

  return { challenge, windowKey };
}
function timeRemainingMs(frequency, zone, now = new Date()) {
  const dt = DateTime.fromJSDate(now, { zone });
  if (frequency === 'DAILY') {
    return Math.max(0, dt.endOf('day').toMillis() - dt.toMillis());
  }
  const sundayStart = dt.minus({ days: dt.weekday % 7 }).startOf('day');
  const saturdayEnd = sundayStart.plus({ days: 6 }).endOf('day'); // ✅
  return Math.max(0, saturdayEnd.toMillis() - dt.toMillis());
}
module.exports = {
  resolveZone,
  startOfDayInZone,
  endOfDayInZone,
  getWeekStartEndInZone,
  dateKeyInZone,
  weekKeyInZone,
  getAssignedChallenge,
  timeRemainingMs,
};
