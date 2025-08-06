const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middlewares/authMiddleware');
const leaderboardController = require('../controllers/leaderboardController');

router.get('/leaderboard/weekly/global', checkAuth, leaderboardController.getWeeklyGlobalLeaderboard);
router.get('/leaderboard/weekly/communities', checkAuth, leaderboardController.getWeeklyCommunityRanks);


module.exports = router;
