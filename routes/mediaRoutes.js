const express = require('express');
const router = express.Router();
const multer = require('multer');
const { checkAuth } = require('../middlewares/authMiddleware');
const mediaController = require('../controllers/mediaController');  // Ensure this is correctly imported
const path = require('path');

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
router.post('/stories/purge-local-paths', checkAuth, mediaController.purgeLocalPathStories);
router.get('/stories/vault', checkAuth, mediaController.getVaultStories);
router.get('/stories/saved', checkAuth, mediaController.getSavedStories);  
router.get('/stories/me', checkAuth, mediaController.getMyStories);
router.get('/stories/feed', checkAuth, mediaController.getStoriesFeed);
module.exports = router;
