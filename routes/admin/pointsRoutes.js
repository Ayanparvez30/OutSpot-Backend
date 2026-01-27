const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminPointsController');

router.get('/multipliers', ctrl.listMultipliers);
router.get('/multipliers/create', ctrl.createMultiplierForm);
router.post('/multipliers/create', ctrl.createMultiplier);
router.get('/multipliers/:id/edit', ctrl.editMultiplierForm);
router.post('/multipliers/:id/edit', ctrl.updateMultiplier);
router.get('/ledger', ctrl.viewLedger);
router.get('/bundles', ctrl.listBundles);
router.get('/bundles/create', ctrl.createBundleForm);
router.post('/bundles/create', ctrl.createBundle);
router.get('/bundles/:id/edit', ctrl.editBundleForm);
router.post('/bundles/:id/edit', ctrl.updateBundle);
router.get('/purchases', ctrl.listPurchases);

module.exports = router;
