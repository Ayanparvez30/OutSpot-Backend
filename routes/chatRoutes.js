const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { checkAuth } = require('../middlewares/authMiddleware');

router.post('/chats/create', checkAuth, chatController.createPrivateChat);
router.delete('/chats/delete/:chatId', checkAuth, chatController.deleteChat);
router.delete('/chats/delete', checkAuth, chatController.deleteBulkChats);
router.get('/chats/global-id', checkAuth, chatController.getGlobalChatId);
router.get('/chats', checkAuth, chatController.getMyChats);
router.get('/chats/unread', checkAuth, chatController.getUnreadChats);
router.get('/chats/groupsOnly', checkAuth, chatController.getMyGroupChats);
router.get('/chats/messages/:chatId', checkAuth, chatController.getMessages);
router.get('/chats/global-rooms', checkAuth, chatController.getGlobalChatRooms);
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

// 🚀 NEW: Mark entire chat as read (simpler approach) - MUST come before /:chatId route
router.put('/chats/markChatAsRead', checkAuth, chatController.markChatAsRead);

// 🚀 NEW: Get chat read status
router.get('/chats/readStatus/:chatId', checkAuth, chatController.getChatReadStatus);

// Group chat lock/unlock (admin only)
router.put('/chats/lock/:chatId', checkAuth, chatController.lockGroupChat);
router.put('/chats/unlock/:chatId', checkAuth, chatController.unlockGroupChat);

// Disappearing messages (MUST be before the catch-all PUT /chats/:chatId)
router.put('/chats/:chatId/disappearing', checkAuth, chatController.setDisappearingMessages);
router.get('/chats/:chatId/disappearing', checkAuth, chatController.getDisappearingMessages);

router.put(
  '/chats/:chatId',
  checkAuth,
  multer({ storage: multer.memoryStorage() }).single('image'),  chatController.updateGroupChat
);

// Add route for searching chats
router.get('/chats/search', checkAuth, chatController.searchChats);

router.post('/chats/messages', checkAuth, chatController.sendTextMessage);
router.post('/chats/confirm-delivery', checkAuth, chatController.confirmDelivery);

// Disappear-on-exit: client signals leaving the conversation screen
router.post('/chats/:chatId/exit', checkAuth, chatController.exitChat);

// Moderation (additive) — item 2: report a message
router.post('/chats/messages/:messageId/report', checkAuth, chatController.reportMessage);

// Moderation (additive) — item 5b: group ban / unban (group admin only)
router.post('/chats/:chatId/members/:userId/ban',   checkAuth, chatController.banGroupMember);
router.delete('/chats/:chatId/members/:userId/ban', checkAuth, chatController.unbanGroupMember);

// Moderation (additive) — item 5c: admin-delete any message in group/community
router.post('/chats/messages/:messageId/admin-delete', checkAuth, chatController.adminDeleteMessage);

module.exports = router;

