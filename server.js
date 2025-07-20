
const express = require('express');
const app = express();
app.use(express.json());


app.use((req, res, next) => {
  console.log(`Incoming request: ${req.method} ${req.originalUrl}`);
  next();
});



const authRoutes = require('./routes/authRoutes');

app.use('/api', authRoutes);

// Serve a simple HTML page at the root
app.use('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Server Status</title></head>
      <body style="font-family:sans-serif; text-align:center; margin-top:50px;">
        <h1>✅ Server is running ✅</h1>
      </body>
    </html>
  `);
});



const PORT = process.env.PORT || 3000;
app.listen(PORT,'0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
