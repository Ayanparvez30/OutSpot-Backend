// routes/challengeRoutes.js
const express = require('express');
const router = express.Router();
const challengeController = require('../controllers/challengeController');
const { checkAuth } = require('../middlewares/authMiddleware');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

// ---- Cards + Full challenge pages ----
router.get('/challenges/cards',   checkAuth, challengeController.getChallengeCards);
router.get('/challenges/daily',   checkAuth, challengeController.getDailyChallenge);
router.get('/challenges/weekly',  checkAuth, challengeController.getWeeklyChallenge);

// ---- Filtered cards (server-side filter) ----
// /challenges/filter?status=all|in_progress|completed|incomplete&frequency=both|daily|weekly
router.get('/challenges/filter',  checkAuth, challengeController.getFilteredChallenges);

// ---- Full history for the In Progress + Completed tabs ----
// /challenges/history?tab=in_progress|completed
//                    [&frequency=all|daily|weekly]
//                    [&page=1&pageSize=20]
router.get('/challenges/history', checkAuth, challengeController.getChallengeHistory);

// ---- Submit (file field must be 'media') ----
router.post('/challenges/submit', checkAuth, upload.single('media'), challengeController.submitToChallenge);


// ---- Admin/Creator create (keep if you use this) ----
router.post('/challenges',        checkAuth, challengeController.createChallenge);

// ---- Legacy helpers (optional) ----
router.get('/challenges/:challengeId/submissions',  checkAuth, challengeController.getSubmissions);
router.get('/challenges/:challengeId/my-submission',checkAuth, challengeController.getMySubmission);

module.exports = router;
