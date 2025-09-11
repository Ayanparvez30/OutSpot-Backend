
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
router.get('/minime/current', checkAuth, userController.getCurrentMinime);
router.get('/minime/locker', checkAuth, userController.getMiniMeLocker);
router.post('/me/privacy', checkAuth, userController.updatePrivacy);

router.get('/me/profile', checkAuth, userController.getProfile);

router.post('/me/update-bio', checkAuth, userController.updateBio);
router.post('/me/update-name', checkAuth, userController.updateName);

router.get('/users/:userId/profile', checkAuth, userController.getUserProfile);

router.get('/users/points/:userId', checkAuth, userController.getUserPoints);

router.post('/submit-for-points', checkAuth,upload.single('media'), userController.submitForPoints);

router.get('/me/achievements', checkAuth, userController.getAchievementStatus);
// const { getMyReferral } = require('../controllers/authController');
router.get('/referral', checkAuth, authController.getMyReferral);

router.post(
  '/minime/upload-avatar',
  checkAuth,
upload.any()
,
  userController.uploadAvatarWithMulter
);
router.delete('/me/delete', checkAuth, userController.deleteAccount);

router.post('/me/fcm-token', checkAuth, authController.updateFcmToken);

// Subscribe to specific chat topic  
router.post('/chat/:chatId/subscribe', checkAuth, authController.subscribeToChatTopic);

module.exports = router;
