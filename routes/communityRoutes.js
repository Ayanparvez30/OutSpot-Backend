const express = require('express');
const router = express.Router();
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

const { checkAuth } = require('../middlewares/authMiddleware');
const communityController = require('../controllers/communityController');

router.post('/communities', checkAuth, upload.single('image'), communityController.createCommunity);
router.put('/communities/:communityId', checkAuth, upload.single('image'), communityController.editCommunity);
router.get('/communities', checkAuth, communityController.getAllCommunities);
router.post('/communities/join', checkAuth, communityController.joinCommunity);
router.post('/communities/leave', checkAuth, communityController.leaveCommunity);
router.get('/communities/:communityId', checkAuth, communityController.getCommunityDetails);
router.get('/communities/:communityId/chat-id', checkAuth, communityController.getCommunityChatId);
router.get('/communities/recent', checkAuth, communityController.getMyRecentCommunities);
module.exports = router;
