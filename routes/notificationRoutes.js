const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middlewares/authMiddleware');
const notificationController = require('../controllers/notificationController');

// Single endpoint with query parameters for filtering
router.get('/notifications', checkAuth, notificationController.getNotifications);

// Get unread notifications
router.get('/notifications/unread', checkAuth, notificationController.getUnreadNotifications);

// Friend request specific notifications
router.get('/notifications/friend-requests', checkAuth, notificationController.getFriendRequestNotifications);
router.get('/notifications/friend-requests/unread', checkAuth, notificationController.getFriendRequestsUnread);

// Challenge specific notifications
router.get('/notifications/challenges', checkAuth, notificationController.getChallengeNotifications);
router.get('/notifications/challenges/unread', checkAuth, notificationController.getChallengeNotificationsUnread);

router.put('/notifications/read/:id', checkAuth, notificationController.markAsRead);
router.delete('/notifications/clearAll', checkAuth, notificationController.clearAll);

module.exports = router;
