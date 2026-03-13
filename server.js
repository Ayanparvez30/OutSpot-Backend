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
    const result = await prisma.story.deleteMany({
      where: {
        status: 'ACTIVE',
        createdAt: { lt: expiry },
        savedBy: { none: {} } // keep if has any saved/vault link
      }
    });

    console.log(`✅ Expired stories deleted (kept saved/vault): ${result.count}`);
  } catch (e) {
    console.error('❌ Cron error:', e);
  }
});

// ---- Disappearing messages cleanup cron ----
// Runs every minute to ensure timely deletion
const MSG_CLEANUP_CRON = '* * * * *';
cron.schedule(MSG_CLEANUP_CRON, async () => {
  try {
    const result = await prisma.message.deleteMany({
      where: {
        expiresAt: { not: null, lte: new Date() },
      },
    });
    if (result.count > 0) {
      console.log(`🗑️  Disappearing messages cleaned up: ${result.count}`);

      // Notify connected clients so they can remove expired messages from UI
      try {
        const { getIO } = require('./utils/socket');
        const io = getIO();
        io.emit('messagesExpired', { count: result.count, at: new Date().toISOString() });
      } catch (_) { /* socket not ready yet */ }
    }
  } catch (e) {
    console.error('❌ Disappearing messages cron error:', e);
  }
});

// ---- Challenge notification scheduler ----
const { midnightChallengeScheduler } = require('./schedulers/midnightChallengeScheduler');
midnightChallengeScheduler.start();

const server = http.createServer(app);
const { initSocket } = require('./utils/socket');
initSocket(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on ${PORT}`);
  console.log(`ℹ️  Health: GET http://localhost:${PORT}/health`);
  console.log(`ℹ️  Story TTL (minutes): ${STORY_TTL_MINUTES} | Cron: ${CRON_EXPR}`);
});
