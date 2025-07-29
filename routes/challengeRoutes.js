const express = require('express');
const router = express.Router();
const challengeController = require('../controllers/challengeController');
const { checkAuth } = require('../middlewares/authMiddleware');
const multer = require('multer');

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`);
  }
});
const upload = multer({ storage });

router.post('/challenges', checkAuth, challengeController.createChallenge);

router.get('/challenges', checkAuth, challengeController.getFilteredChallenges); 

router.post('/challenges/submit', checkAuth, upload.single('media'), challengeController.submitToChallenge);

router.get('/challenges/:challengeId/submissions', checkAuth, challengeController.getSubmissions);

router.get('/challenges/:challengeId/my-submission', checkAuth, challengeController.getMySubmission);


module.exports = router;
