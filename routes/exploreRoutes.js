const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middlewares/authMiddleware');
const {
  getExploreHome,
  getCategoryPlaces,
  recordVisit,
  getPlaceDetail,

  // ✅ Restaurants
  getRestaurantCategories,
  getRestaurantsByCategory,
  getTopTrendingWeekRestaurants
} = require('../controllers/exploreController');

// Footer Explore landing (category cards + "new" badges)
router.get('/explore/home', checkAuth, getExploreHome);

// Category list (Rooftop Bars ইত্যাদি)
router.get('/explore/category/:key/places', checkAuth, getCategoryPlaces);

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
