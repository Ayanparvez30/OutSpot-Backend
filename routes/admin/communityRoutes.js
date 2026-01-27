const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminCommunityController');

router.get('/', ctrl.listCommunities);
router.get('/:id/edit', ctrl.editForm);
router.post('/:id/edit', ctrl.updateCommunity);

module.exports = router;
