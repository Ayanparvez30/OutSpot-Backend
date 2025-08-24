const express = require('express');
const router = express.Router();
const friendController = require('../controllers/friendController');
const { checkAuth } = require('../middlewares/authMiddleware');


router.use(checkAuth);
router.post('/friends/request/:userId', friendController.sendFriendRequest);
router.post('/friends/accept/:userId', friendController.acceptFriendRequest);
router.post('/friends/decline/:userId', friendController.declineFriendRequest);
router.delete('/friends/:userId', friendController.unfriend);
router.post('/block/:userId', friendController.blockUser);
router.delete('/block/:userId', friendController.unblockUser);
router.get('/friends/requests/count', friendController.getPendingFriendRequestCount);
router.get('/friends/sent-requests', friendController.getSentFriendRequests);
router.get('/users/blocked', friendController.getBlockedUsers);



router.get('/friends/requests/incoming', friendController.getFriendRequests);
router.get('/friends', friendController.getFriendList);
router.get('/friends/recommended', friendController.getRecommendedFriends);
router.post('/contacts/sync', friendController.syncContacts);
router.get('/friends/search', friendController.searchUsers);
router.get('/friends-profile/:friendId', friendController.getFriendProfile);
router.get('/users/profile/:userId', friendController.getUserProfile);

module.exports = router;
