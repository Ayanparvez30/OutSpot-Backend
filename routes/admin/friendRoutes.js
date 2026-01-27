const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminFriendController');

router.get('/', ctrl.listFriendships);
router.post('/:id/approve', ctrl.approveFriendship);
router.post('/:id/revoke', ctrl.revokeFriendship);
router.post('/:id/remove', ctrl.removeFriendship);
router.get('/blocks', ctrl.listBlocks);
router.post('/blocks/:id/unblock', ctrl.unblock);
router.post('/blocks/create', ctrl.createBlock);

module.exports = router;
