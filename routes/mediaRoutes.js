// routes/mediaRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { checkAuth } = require('../middlewares/authMiddleware');
const mediaController = require('../controllers/mediaController');

const upload = multer({
  storage: multer.memoryStorage(), 
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.mp4', '.mov'].includes(ext)) {
      return cb(new Error('Only images and videos are allowed'), false);
    }
    cb(null, true);
  }
});


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
