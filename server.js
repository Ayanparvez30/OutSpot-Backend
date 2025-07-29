
const express = require('express');
const app = express();
app.use(express.json());

const http = require('http');
const server = http.createServer(app);
const challengeRoutes = require('./routes/challengeRoutes');
const { initSocket } = require('./utils/socket');
initSocket(server);
const mediaRoutes = require('./routes/mediaRoutes');
app.use('/api', mediaRoutes);
app.use('/uploads', express.static('uploads')); 
app.use('/pose', express.static('public/pose'));

app.use('/api', challengeRoutes);


app.use((req, res, next) => {
  console.log(`Incoming request: ${req.method} ${req.originalUrl}`);
  next();
});



const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const friendRoutes = require('./routes/friendRoutes');

app.use('/api', authRoutes);
app.use('/api', chatRoutes);
app.use('/api', friendRoutes);

// Serve a simple HTML page at the root
// app.use('/home', (req, res) => {
//   res.send(`
//     <html>
//       <head><title>Server Status</title></head>
//       <body style="font-family:sans-serif; text-align:center; margin-top:50px;">
//         <h1>✅ Server is running ✅</h1>
//       </body>
//     </html>
//   `);
// });



const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
