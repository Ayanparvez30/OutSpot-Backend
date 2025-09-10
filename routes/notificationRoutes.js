const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middlewares/authMiddleware');
const notificationController = require('../controllers/notificationController');

// Single endpoint with query parameters for filtering
router.get('/notifications', checkAuth, notificationController.getNotifications);

router.put('/notifications/read/:id', checkAuth, notificationController.markAsRead);
router.delete('/notifications/clearAll', checkAuth, notificationController.clearAll);

module.exports = router;
