

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');
const userController = require('../controllers/userController');
const { checkAuth } = authMiddleware;
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
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
router.post('/upload-avatar', checkAuth, userController.uploadAvatarWithMulter);
router.post('/minime/generate', checkAuth, userController.generateMinime);
router.post('/minime/regenerate', checkAuth, userController.regenerateMinime);
router.post('/minime/save-latest', checkAuth, userController.saveLatestMinime);
router.get('/minime/current', checkAuth, userController.getCurrentMinime);
router.get('/minime/locker', checkAuth, userController.getMiniMeLocker);

router.get('/users/:userId/profile', checkAuth, userController.getUserProfile);

router.get('/users/:userId/points', checkAuth, userController.getUserPoints);

router.post('/submit-points', checkAuth, upload.single('media'), userController.submitForPoints);
router.get('/me/achievements', checkAuth, userController.getAchievementStatus);

router.post(
  '/minime/upload-avatar',
  checkAuth,
upload.any() // accept any key
,
  userController.uploadAvatarWithMulter
);
router.delete('/me/delete', checkAuth, userController.deleteAccount);


module.exports = router;
