const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middlewares/authMiddleware');
const reportController = require('../controllers/reportController');

router.use(checkAuth); // Ensure the user is authenticated

// POST route to report a user (no reason needed)
router.post('/report', reportController.reportUser);

module.exports = router;
