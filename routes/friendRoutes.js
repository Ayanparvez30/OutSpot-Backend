

const express = require('express');
const router = express.Router();
const friendController = require('../controllers/friendController');
const { checkAuth } = require('../middlewares/authMiddleware');


router.use(checkAuth);
router.post('/friends/request/:userId', friendController.sendFriendRequest);
router.post('/friends/accept/:userId', friendController.acceptFriendRequest);
router.post('/friends/decline/:userId', friendController.declineFriendRequest);
router.delete('/friends/:userId', friendController.unfriend);

router.post('/users/:userId/block', friendController.blockUser);
router.delete('/users/:userId/block', friendController.unblockUser);
router.get('/friends/requests/count', friendController.getPendingFriendRequestCount);
//oporer routes gulo fix koren




router.get('/friends/requests/incoming', friendController.getFriendRequests);
router.get('/friends', friendController.getFriendList);
router.get('/friends/recommended', friendController.getRecommendedFriends);
router.post('/contacts/sync', friendController.syncContacts);
router.get('/friends/search', friendController.searchUsers);




module.exports = router;
