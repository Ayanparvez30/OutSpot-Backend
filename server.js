// Default timezone — app launches in Boston, so all server-side date
// computations (cron triggers, daily/weekly challenge windows, new Date()
// formatting) align with Eastern Time unless an explicit TZ env var is set.
// Must be assigned BEFORE any require() that uses time.
process.env.TZ = process.env.TZ || 'America/New_York';

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const session = require('express-session');
const flash = require('connect-flash');
const expressLayouts = require('express-ejs-layouts');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const app = express();
app.use(cors());
app.use(express.json());

app.use('/uploads', express.static('uploads'));
app.use('/pose', express.static('public/pose'));

// --- Admin Panel Setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', false); // Disable global layout; each render specifies its own

app.use('/admin/assets', express.static(path.join(__dirname, 'public/admin')));

app.use('/admin', session({
  secret: process.env.ADMIN_SESSION_SECRET || 'outspot-admin-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000,
    sameSite: 'lax',
  },
}));
app.use('/admin', flash());
app.use('/admin', express.urlencoded({ extended: true }));
app.use('/admin', (req, res, next) => {
  res.locals.req = req;
  next();
});
app.use('/admin', require('./routes/admin/index'));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((req, res, next) => {
  console.log(`➡️  ${req.method} ${req.originalUrl}`);
  next();
});



const communityRoutes   = require('./routes/communityRoutes');
const challengeRoutes   = require('./routes/challengeRoutes');
const leaderboardRoutes = require('./routes/leaderboardRoutes');
const authRoutes        = require('./routes/authRoutes');
const chatRoutes        = require('./routes/chatRoutes');
const friendRoutes      = require('./routes/friendRoutes');
const mapRoutes         = require('./routes/mapRoutes');
const mediaRoutes       = require('./routes/mediaRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const exploreRoutes = require('./routes/exploreRoutes');
const reportRoutes = require('./routes/reportRoutes');
const adminChallengeRoutes = require('./routes/adminChallengeRoutes');

app.use('/api', require('./routes/shopRoutes'));
app.use('/api', require('./routes/referralRoutes'));

app.use('/api', authRoutes);
app.use('/api', communityRoutes);
app.use('/api', mediaRoutes);
app.use('/api', challengeRoutes);
app.use('/api', adminChallengeRoutes);
app.use('/api', leaderboardRoutes);
app.use('/api', chatRoutes);
app.use('/api', friendRoutes);
app.use('/api', mapRoutes);
app.use('/api', notificationRoutes);
app.use('/api', reportRoutes);
app.use('/api', exploreRoutes);

// ---- Story expiry cron ----
// TTL minutes (same logic as controller)
const STORY_TTL_MINUTES = Number(
  process.env.STORY_TTL_MINUTES || (process.env.NODE_ENV === 'development' ? 5 : 24 * 60)
);

// dev: every minute; prod: top of hour
const CRON_EXPR = process.env.NODE_ENV === 'development' ? '* * * * *' : '0 * * * *';

cron.schedule(CRON_EXPR, async () => {
  try {
    const expiry = new Date(Date.now() - STORY_TTL_MINUTES * 60 * 1000);

    // ✅ DO NOT delete stories that are referenced by any SavedStory (SAVED or VAULT)
    // Capture URLs BEFORE deleting so we can attempt orphan S3 cleanup after.
    const doomed = await prisma.story.findMany({
      where: {
        status: 'ACTIVE',
        createdAt: { lt: expiry },
        savedBy: { none: {} },
      },
      select: { id: true, mediaUrl: true, userId: true },
    });

    if (doomed.length === 0) {
      console.log('✅ Expired stories: 0');
      return;
    }

    const ids = doomed.map(s => s.id);
    await prisma.story.deleteMany({ where: { id: { in: ids } } });
    console.log(`✅ Expired stories deleted: ${ids.length}`);

    // Realtime: each owner's friends (+ the owner) drop the expired story
    try {
      const realtime = require('./utils/realtime');
      const ownerIds = [...new Set(doomed.map(s => s.userId))];
      for (const ownerId of ownerIds) {
        realtime.toFriends(ownerId, 'story.expired', { userId: ownerId });
        realtime.toUser(ownerId, 'story.expired', { userId: ownerId });
      }
    } catch (e) {
      console.error('story.expired realtime emit error:', e);
    }

    // Orphan-only S3 cleanup — checks every URL column in every table first.
    const { deleteS3IfOrphanBulk } = require('./utils/s3Cleanup');
    const urls = [...new Set(doomed.map(s => s.mediaUrl).filter(Boolean))];
    const cleanup = await deleteS3IfOrphanBulk(urls);
    console.log(`✅ S3 cleanup: deleted=${cleanup.deleted} kept=${cleanup.kept} failed=${cleanup.failed}`);
  } catch (e) {
    console.error('❌ Cron error:', e);
  }
});

// ---- Disappearing messages cleanup cron ----
// Runs every minute to ensure timely deletion
const MSG_CLEANUP_CRON = '* * * * *';
cron.schedule(MSG_CLEANUP_CRON, async () => {
  try {
    // Find expired messages — include imageUrl so we can clean up S3
    const expired = await prisma.message.findMany({
      where: {
        expiresAt: { not: null, lte: new Date() },
      },
      select: { id: true, chatId: true, imageUrl: true },
    });

    if (expired.length === 0) return;

    // Delete DB records
    await prisma.message.deleteMany({
      where: { id: { in: expired.map(m => m.id) } },
    });

    console.log(`🗑️  Disappearing messages cleaned up: ${expired.length}`);

    // Orphan-only S3 cleanup — same upload may also live on a Story (e.g.
    // user sent a photo to chat AND posted it as a story), so a blind
    // deleteFromS3 would kill the still-alive story's image. Guarded version
    // skips S3 delete if any other table row still references the URL.
    const { deleteS3IfOrphanBulk } = require('./utils/s3Cleanup');
    const msgUrls = [...new Set(expired.map(m => m.imageUrl).filter(Boolean))];
    if (msgUrls.length) {
      const c = await deleteS3IfOrphanBulk(msgUrls);
      console.log(`✅ Message S3 cleanup: deleted=${c.deleted} kept=${c.kept} failed=${c.failed}`);
    }

    // Group by chatId and emit per-chat messagesDeleted events
    try {
      const { getIO } = require('./utils/socket');
      const io = getIO();

      const byChatId = {};
      for (const m of expired) {
        if (!byChatId[m.chatId]) byChatId[m.chatId] = [];
        byChatId[m.chatId].push(m.id);
      }
      for (const [chatId, messageIds] of Object.entries(byChatId)) {
        io.to(`chat_${chatId}`).emit('messagesDeleted', {
          chatId: parseInt(chatId, 10),
          messageIds,
        });
      }
    } catch (_) { /* socket not ready yet */ }
  } catch (e) {
    console.error('❌ Disappearing messages cron error:', e);
  }
});

// ---- Daily DB backup cron (02:00 UTC) ----
const { backup: backupDb } = require('./scripts/backup-db');
cron.schedule('0 2 * * *', async () => {
  try {
    await backupDb();
  } catch (e) {
    console.error('❌ DB backup cron error:', e.message);
  }
}, { timezone: 'UTC' });

// ---- Challenge notification scheduler ----
const { midnightChallengeScheduler } = require('./schedulers/midnightChallengeScheduler');
midnightChallengeScheduler.start();

// ---- Challenge reminder pushes (a few hours before window closes) ----
const { sendDailyReminders, sendWeeklyReminders } = require('./utils/challengeReminders');
// Daily reminder — 20:00 Boston (TZ = America/New_York set at top of file)
cron.schedule('0 20 * * *', async () => {
  try {
    const r = await sendDailyReminders();
    console.log(`📬 Daily reminder: sent=${r.sent} candidates=${r.candidates} done=${r.alreadyDone} already=${r.alreadyReminded} noChallenge=${r.noChallenge}`);
  } catch (e) { console.error('❌ Daily reminder cron error:', e.message); }
});
// Weekly reminder — Sat 18:00 Boston (~30 hours before Mon 00:00 roll)
cron.schedule('0 18 * * 6', async () => {
  try {
    const r = await sendWeeklyReminders();
    console.log(`📬 Weekly reminder: sent=${r.sent} candidates=${r.candidates} done=${r.alreadyDone} already=${r.alreadyReminded} noChallenge=${r.noChallenge}`);
  } catch (e) { console.error('❌ Weekly reminder cron error:', e.message); }
});

// ---- Leaderboard cash-prize reminders ----
const { sendLeaderboardReminders, REMINDER_TYPES: LB_TYPES } = require('./utils/leaderboardReminder');
// Mid-week — Wed 18:00 Boston: "climb the board"
cron.schedule('0 18 * * 3', async () => {
  try {
    const r = await sendLeaderboardReminders(LB_TYPES.MIDWEEK);
    console.log(`🏆 Leaderboard MID-WEEK: sent=${r.sent} candidates=${r.candidates} already=${r.alreadyReminded}`);
  } catch (e) { console.error('❌ Leaderboard midweek cron error:', e.message); }
});
// Final day — Sun 10:00 Boston: "last chance for prize"
cron.schedule('0 10 * * 0', async () => {
  try {
    const r = await sendLeaderboardReminders(LB_TYPES.FINAL);
    console.log(`🏆 Leaderboard FINAL: sent=${r.sent} candidates=${r.candidates} already=${r.alreadyReminded}`);
  } catch (e) { console.error('❌ Leaderboard final cron error:', e.message); }
});

const server = http.createServer(app);
const { initSocket } = require('./utils/socket');
initSocket(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Server running on ${PORT}`);
  console.log(`ℹ️  Health: GET http://localhost:${PORT}/health`);
  console.log(`ℹ️  Story TTL (minutes): ${STORY_TTL_MINUTES} | Cron: ${CRON_EXPR}`);

  // TODO: REMOVE after first deploy — one-time fix for community chat flags
  try {
    const bad = await prisma.chat.count({
      where: {
        communityId: { not: null },
        OR: [{ isCommunity: false }, { isGroup: true }],
      },
    });
    if (bad > 0) {
      const fixed = await prisma.chat.updateMany({
        where: {
          communityId: { not: null },
          OR: [{ isCommunity: false }, { isGroup: true }],
        },
        data: { isCommunity: true, isGroup: false },
      });
      console.log(`🔧 Fixed ${fixed.count} community chat flags (one-time migration)`);
    }
  } catch (_) { }
});
