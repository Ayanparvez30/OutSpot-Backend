
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');
const userController = require('../controllers/userController');
const { checkAuth } = authMiddleware;
const path = require('path');

const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
      return cb(new Error('Only images are allowed'), false);
    }
    cb(null, true);
  }
});

router.post('/signup', authController.signup);

router.post('/verify-otp', authController.verifyOtp);

router.post('/resend-otp', authController.resendOtp);
router.post('/login', authController.login);

router.post('/forgot-password', authController.forgotPasswordRequest);
router.post('/verify-forgot-password-otp', authController.verifyForgotPasswordOtp);
router.post('/reset-password', authController.resetPassword);
router.post('/forgot-password/reset', authController.verifyOtpAndResetPassword);

router.post('/update-password', checkAuth, authController.updatePassword);
router.post('/logout', checkAuth, authController.logout);
router.post('/update-username', checkAuth, authController.updateUsername);
router.post('/contact-us', authController.contactUs);
router.post('/save-profile', checkAuth, userController.saveProfile);

router.post('/minime/generate', checkAuth, userController.generateMinime);
router.post('/minime/regenerate', checkAuth, userController.regenerateMinime);
router.post('/minime/save-latest', checkAuth, userController.saveLatestMinime);
router.post('/minime/:id/set-active', checkAuth, userController.setActiveMinime);
router.get('/minime/current', checkAuth, userController.getCurrentMinime);
router.get('/minime/locker', checkAuth, userController.getMiniMeLocker);
router.post('/me/privacy', checkAuth, userController.updatePrivacy);
router.get('/me/notification-setting', checkAuth, userController.getNotificationSetting);
router.post('/me/notification-setting', checkAuth, userController.setNotificationSetting);
// routes/userRoutes.js
router.get("/users/:userId/stats", checkAuth, userController.getUserStatsByUserId);
router.get("/users/:userId/visited-spots", checkAuth, userController.getUserVisitedSpots);
router.get("/users/:userId/completed-challenges", checkAuth, userController.getCompletedChallenges);

router.get('/me/profile', checkAuth, userController.getProfile);

router.post('/me/update-bio', checkAuth, userController.updateBio);
router.post('/me/update-name', checkAuth, userController.updateName);

router.get('/users/:userId/profile', checkAuth, userController.getUserProfile);

router.get('/users/points/:userId', checkAuth, userController.getUserPoints);

router.post('/submit-for-points', checkAuth,upload.single('media'), userController.submitForPoints);
router.get('/submit-for-points/status', checkAuth, userController.getSubmitForPointsStatus);

router.get('/me/achievements', checkAuth, userController.getAchievementStatus);
// const { getMyReferral } = require('../controllers/authController');
router.get('/referral', checkAuth, authController.getMyReferral);
router.get(
  "/users/:userId/minime-locker",checkAuth,
  userController.getMiniMeLockerByUserId
);

router.get('/minime/premades', checkAuth, userController.listPremadeAvatars);
router.get('/body-shapes', checkAuth, userController.listBodyShapes);

router.post(
  '/minime/upload-avatar',
  checkAuth,
upload.any()
,
  userController.uploadAvatarWithMulter
);
router.delete('/me/delete', checkAuth, userController.deleteAccount);

router.post('/me/fcm-token', checkAuth, authController.updateFcmToken);

module.exports = router;
