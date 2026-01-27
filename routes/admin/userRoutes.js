const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminUserController');

router.get('/export/csv', ctrl.exportCsv);
router.get('/', ctrl.listUsers);
router.get('/:id', ctrl.showUser);
router.get('/:id/edit', ctrl.editUserForm);
router.post('/:id/edit', ctrl.updateUser);
router.post('/:id/ban', ctrl.banUser);
router.post('/:id/unban', ctrl.unbanUser);
router.post('/:id/deactivate', ctrl.deactivateUser);
router.post('/:id/activate', ctrl.activateUser);
router.post('/:id/adjust-points', ctrl.adjustPoints);
router.post('/:id/grant-item', ctrl.grantItem);
router.post('/:id/remove-item', ctrl.removeItem);
router.get('/:id/inventory', ctrl.viewInventory);
router.get('/:id/points', ctrl.viewPointsLedger);

module.exports = router;
