const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middlewares/authMiddleware');
const notificationController = require('../controllers/notificationController');

router.get('/notifications', checkAuth, notificationController.getNotifications);
router.get('/notifications/unread', checkAuth, notificationController.getUnreadNotifications);
router.get('/notifications/friendrequestfilter', checkAuth, notificationController.getFriendRequestNotifications);
router.put('/notifications/read/:id', checkAuth, notificationController.markAsRead);
router.delete('/notifications/clearAll', checkAuth, notificationController.clearAll);
module.exports = router;
