const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminLocationController');

router.get('/', ctrl.listLocationPoints);
router.post('/:id/adjust', ctrl.adjustPoints);
router.post('/:id/delete', ctrl.removePoint);

module.exports = router;
