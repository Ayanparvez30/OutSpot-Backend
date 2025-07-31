

const express = require('express');
const router = express.Router();
const friendController = require('../controllers/friendController');
const { checkAuth } = require('../middlewares/authMiddleware');

// Protect all friend/block routes with auth middleware
router.use(checkAuth);

// Friend request routes
router.post('/friends/request/:userId', friendController.sendFriendRequest);
router.post('/friends/accept/:userId', friendController.acceptFriendRequest);
router.post('/friends/decline/:userId', friendController.declineFriendRequest);

// Unfriend route
router.delete('/friends/:userId', friendController.unfriend);

// Friend list retrieval
router.get('/friends', friendController.getFriendList);
router.get('/friends/recommended', friendController.getRecommendedFriends);
router.post('/contacts/sync', friendController.syncContacts);

// Block/unblock routes
router.post('/users/:userId/block', friendController.blockUser);
router.delete('/users/:userId/block', friendController.unblockUser);
router.get('/friends/requests/count', friendController.getPendingFriendRequestCount);


module.exports = router;
