
const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middlewares/authMiddleware');

const {
  updateLocation,
  getFriendLocations,
  getVisitedTrail,
  getRecentStoriesWithLocation,
  searchOnMap
} = require('../controllers/mapController');

router.post('/map/location',  checkAuth, updateLocation);
router.get('/map/friends',    checkAuth, getFriendLocations);
router.get('/map/trail/:userId', checkAuth, getVisitedTrail);
router.get('/map/stories/recent',    checkAuth,getRecentStoriesWithLocation);
router.get('/map/search',     checkAuth, searchOnMap);

module.exports = router;
