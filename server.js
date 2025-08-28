const express = require('express');
const http = require('http');
const cors = require('cors');
const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const app = express();
app.use(cors());
app.use(express.json());

app.use('/uploads', express.static('uploads'));
app.use('/pose', express.static('public/pose'));

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


app.use('/api', authRoutes);
app.use('/api', communityRoutes);
app.use('/api', mediaRoutes);
app.use('/api', challengeRoutes);
app.use('/api', leaderboardRoutes);
app.use('/api', chatRoutes);
app.use('/api', friendRoutes);
app.use('/api', mapRoutes);
app.use('/api', notificationRoutes);

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

const server = http.createServer(app);
const { initSocket } = require('./utils/socket');
initSocket(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on ${PORT}`);
  console.log(`ℹ️  Health: GET http://localhost:${PORT}/health`);
  console.log(`ℹ️  Story TTL (minutes): ${STORY_TTL_MINUTES} | Cron: ${CRON_EXPR}`);
});
