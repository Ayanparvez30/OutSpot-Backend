const express = require('express');
const http = require('http');
const cors = require('cors');

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

app.use('/api', authRoutes);
app.use('/api', communityRoutes);
app.use('/api', mediaRoutes);
app.use('/api', challengeRoutes);
app.use('/api', leaderboardRoutes);
app.use('/api', chatRoutes);
app.use('/api', friendRoutes);
app.use('/api', mapRoutes);

// SOCKET
const server = http.createServer(app);
const { initSocket } = require('./utils/socket');
initSocket(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on ${PORT}`);
  console.log(`ℹ️  Health: GET http://localhost:${PORT}/health`);
});
