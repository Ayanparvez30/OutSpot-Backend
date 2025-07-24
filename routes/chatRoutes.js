const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const authMiddleware = require('../middlewares/authMiddleware');
const { checkAuth } = authMiddleware;

router.post('/chats', checkAuth, chatController.createChat);
router.get('/chats', checkAuth, chatController.getMyChats);
router.get('/chats/:chatId/messages', checkAuth, chatController.getMessages);
router.get('/chats/:chatId/messages-paginated', checkAuth, chatController.getMessagesPaginated);


module.exports = router;
