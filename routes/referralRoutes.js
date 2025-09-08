// routes/referralRoutes.js
const express = require('express');
const router = express.Router();

const rc = require('../controllers/referralController');

const authMiddleware = require('../middlewares/authMiddleware');

const { checkAuth } = authMiddleware;

router.get('/referrals/link', checkAuth, rc.getInviteLink);
router.get('/referrals/summary', checkAuth, rc.getReferralSummary);

// optional utility endpoint if needed
router.post('/referrals/attach', checkAuth, rc.attachReferralIfAny);

module.exports = router;
