const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { checkAuth } = require('../middlewares/authMiddleware');

// Chat routes
router.post('/chats', checkAuth, chatController.createChat);
router.get('/chats', checkAuth, chatController.getMyChats);
router.get('/chats/:chatId/messages', checkAuth, chatController.getMessages);
router.get('/chats/:chatId/messages-paginated', checkAuth, chatController.getMessagesPaginated);

// ✅ Image upload support
const multer = require('multer');
const path = require('path');
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const upload = multer({ storage });

router.post('/chat/upload', checkAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const fileUrl = `/uploads/${req.file.filename}`;
  return res.json({ imageUrl: fileUrl });
});

module.exports = router;

