const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middlewares/authMiddleware');
const communityController = require('../controllers/communityController');
router.post('/communities', checkAuth, communityController.createCommunity);

router.get('/communities', checkAuth, communityController.getAllCommunities);
router.post('/communities/join', checkAuth, communityController.joinCommunity);
router.post('/communities/leave', checkAuth, communityController.leaveCommunity);
router.get('/communities/:communityId', checkAuth, communityController.getCommunityDetails);
router.get('/communities/:communityId/chat-id', checkAuth, communityController.getCommunityChatId);

module.exports = router;
