const express = require('express');
const router = express.Router();
const challengeController = require('../controllers/challengeController');
const { checkAuth } = require('../middlewares/authMiddleware');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

router.post('/challenges/submit', checkAuth, upload.single('media'), challengeController.submitToChallenge);


router.post('/challenges', checkAuth, challengeController.createChallenge);

router.get('/challenges', checkAuth, challengeController.getFilteredChallenges); 



router.get('/challenges/:challengeId/submissions', checkAuth, challengeController.getSubmissions);

router.get('/challenges/:challengeId/my-submission', checkAuth, challengeController.getMySubmission);


module.exports = router;
