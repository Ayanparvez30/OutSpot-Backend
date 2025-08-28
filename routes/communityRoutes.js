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

router.get('/communities/mine', checkAuth, communityController.getMyCommunities);
router.get('/communities/:communityId', checkAuth, communityController.getCommunityDetails);
router.get('/communities/:communityId/chat-id', checkAuth, communityController.getCommunityChatId);



router.post('/communities/leave', checkAuth, communityController.leaveCommunity);


// Only the creator can delete a community
router.delete('/communities/:communityId', checkAuth, communityController.deleteCommunity);


// Recent communities for the current user (created + joined), sorted by recency
router.get('/communities/my/recent', checkAuth, communityController.getMyRecentCommunities);

module.exports = router;
