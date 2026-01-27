const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminDashboardController');

router.get('/', ctrl.renderDashboard);

module.exports = router;
