

const express = require('express');
const router = express.Router();
const friendController = require('../controllers/friendController');
const blockController = require('../controllers/blockController');
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

// Block/unblock routes
router.post('/users/:userId/block', blockController.blockUser);
router.delete('/users/:userId/block', blockController.unblockUser);
router.get('/friends/requests/count', friendController.getPendingFriendRequestCount);


module.exports = router;
