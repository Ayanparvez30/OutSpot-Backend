// routes/mediaRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { checkAuth } = require('../middlewares/authMiddleware');
const mediaController = require('../controllers/mediaController');

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`);
  }
});
const upload = multer({ storage });

router.post('/upload', checkAuth, upload.single('media'), mediaController.uploadMedia);
router.get('/stories', checkAuth, mediaController.getStories);
router.post('/stories/profile', checkAuth, mediaController.saveToProfile);
router.post('/stories/vault', checkAuth, mediaController.saveToVault);
router.delete('/stories/:storyId', checkAuth, mediaController.removeStory);
router.get('/debug-stories', checkAuth, mediaController.debugAllStories);
router.get('/stories/vault', checkAuth, mediaController.getVaultStories);
// Update own location
router.post('/location', checkAuth, mediaController.updateLocation);
// Get locations of friends
router.get('/friends/locations', checkAuth, mediaController.getFriendLocations);
router.get('/trail/:userId', checkAuth, mediaController.getVisitedTrail);
router.get('/stories/with-location', checkAuth, mediaController.getStoriesWithLocation);



module.exports = router;
