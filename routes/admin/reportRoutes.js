const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminReportController');

router.get('/', ctrl.listReports);
router.get('/:id', ctrl.showReport);
router.post('/:id/status', ctrl.updateStatus);
router.post('/:id/action', ctrl.takeAction);

module.exports = router;
