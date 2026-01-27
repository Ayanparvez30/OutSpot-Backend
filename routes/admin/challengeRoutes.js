const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminChallengeController');

router.get('/', ctrl.listChallenges);
router.get('/create', ctrl.createForm);
router.post('/create', ctrl.createChallenge);
router.get('/:id/edit', ctrl.editForm);
router.post('/:id/edit', ctrl.updateChallenge);
router.post('/:id/activate', ctrl.activateChallenge);
router.post('/:id/deactivate', ctrl.deactivateChallenge);
router.post('/:id/feature', ctrl.toggleFeature);
router.post('/:id/delete', ctrl.deleteChallenge);
router.get('/:id/submissions', ctrl.viewSubmissions);

module.exports = router;
