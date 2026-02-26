const express = require('express');
const router = express.Router();
const adminAuth = require('../../middlewares/adminAuth');

// Auth routes (no middleware needed)
router.use('/', require('./authRoutes'));

// All routes below require admin authentication
router.use(adminAuth);

router.use('/dashboard', require('./dashboardRoutes'));
router.use('/users', require('./userRoutes'));
router.use('/communities', require('./communityRoutes'));
router.use('/friends', require('./friendRoutes'));
router.use('/challenges', require('./challengeRoutes'));
router.use('/shop', require('./shopRoutes'));
router.use('/premades', require('./premadeRoutes'));
router.use('/body-shapes', require('./bodyShapeRoutes'));
router.use('/points', require('./pointsRoutes'));
router.use('/reports', require('./reportRoutes'));
router.use('/locations', require('./locationRoutes'));

// Redirect /admin to /admin/dashboard
router.get('/', (req, res) => res.redirect('/admin/dashboard'));

module.exports = router;
