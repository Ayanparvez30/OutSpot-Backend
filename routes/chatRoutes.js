
const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { checkAuth } = require('../middlewares/authMiddleware');

router.post('/chats/create', checkAuth, chatController.createPrivateChat);
router.delete('/chats/delete/:chatId', checkAuth, chatController.deleteChat);

router.get('/chats', checkAuth, chatController.getMyChats);
router.get('/chats/messages/:chatId', checkAuth, chatController.getMessages);
router.get('/chats/messages-paginated/:chatId', checkAuth, chatController.getMessagesPaginated);
router.get('/chats/:user2Id', checkAuth, chatController.getChatsByUsers);
router.get('/chats/groupMembers/:chatId', checkAuth, chatController.getGroupMembers);

// add users (admin only)
router.put('/chats/addUser/:chatId', checkAuth, chatController.addUsersToGroup);

// remove user (admin only)
router.delete('/chats/:chatId/users/:userId', checkAuth, chatController.removeUserFromGroup);
// NEW: self-leave
router.delete('/chats/leave/:chatId', checkAuth, chatController.leaveGroup);

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


router.post('/chat/upload', checkAuth, chatController.uploadChatImage);

router.post(
  '/chats/createGroupChat',
  checkAuth,
  multer({ storage: multer.memoryStorage() }).single('image'),
  chatController.createGroupChat
);

router.put(
  '/chats/:chatId',
  checkAuth,
  multer({ storage: multer.memoryStorage() }).single('image'),  chatController.updateGroupChat
);

// Group chat lock/unlock (admin only)
router.put('/chats/lock/:chatId', checkAuth, chatController.lockGroupChat);
router.put('/chats/unlock/:chatId', checkAuth, chatController.unlockGroupChat);


// 🚀 NEW: Mark entire chat as read (simpler approach)
router.put('/chats/markChatAsRead', checkAuth, chatController.markChatAsRead);

// 🚀 NEW: Get chat read status
router.get('/chats/readStatus/:chatId', checkAuth, chatController.getChatReadStatus);

module.exports = router; 

