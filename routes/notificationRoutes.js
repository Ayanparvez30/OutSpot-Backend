
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
// Mark a notification as unread
router.put('/notifications/unread/:id', checkAuth, notificationController.markAsUnread);
router.delete('/notifications/clearAll', checkAuth, notificationController.clearAll);

// Delete a single notification by id
router.delete('/notifications/:id', checkAuth, notificationController.deleteNotification);

// New endpoint to reset notificationRedDot
router.post('/notifications/reset-red-dot', checkAuth, notificationController.resetNotificationRedDot);

// Add routes for mute/unmute chat functionality
router.put('/notifications/mute/:chatId', checkAuth, notificationController.muteChat);
router.put('/notifications/unmute/:chatId', checkAuth, notificationController.unmuteChat);

// Add route for getting chat mute status
router.get('/notifications/mute-status/:chatId', checkAuth, notificationController.getChatMuteStatus);
// Get notificationRedDot value
router.get('/notifications/red-dot', checkAuth, notificationController.getNotificationRedDot);
// New endpoint to reset notificationRedDot
router.post('/notifications/reset-red-dot', checkAuth, notificationController.resetNotificationRedDot);
module.exports = router;
