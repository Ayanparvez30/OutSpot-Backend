const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminShopController');

router.get('/', ctrl.listItems);
router.get('/create', ctrl.createForm);
router.post('/create', ctrl.createItem);
router.get('/:id/edit', ctrl.editForm);
router.post('/:id/edit', ctrl.updateItem);
router.post('/:id/delete', ctrl.deleteItem);
router.post('/:id/feature', ctrl.toggleFeature);

module.exports = router;
