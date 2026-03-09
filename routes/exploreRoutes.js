const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middlewares/authMiddleware');
const {
  getCategoryPlaces,
  recordVisit,
  getPlaceDetail,
  searchPlaces,

  // ✅ Restaurants
  getRestaurantCategories,
  getRestaurantsByCategory,
  getTopTrendingWeekRestaurants
} = require('../controllers/exploreController');

// Category list
router.get('/explore/category/:key/places', checkAuth, getCategoryPlaces);

// Manual search
router.get('/explore/search', checkAuth, searchPlaces);

// Optional detail
router.get('/explore/place/:placeId', checkAuth, getPlaceDetail);

// Visit/Check-in → points award
router.post('/explore/visit', checkAuth, recordVisit);

// ===================== Restaurants =====================
// Tabs list: Trending | Popular | Bars | Outdoors | Events
router.get('/restaurants/categories', checkAuth, getRestaurantCategories);

// Category wise places
router.get('/restaurants/category/:key/places', checkAuth, getRestaurantsByCategory);
router.get(
  '/restaurants/top-trending/week',
  checkAuth,
  getTopTrendingWeekRestaurants
);

module.exports = router;
