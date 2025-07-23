

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');
const userController = require('../controllers/userController');
const { checkAuth } = authMiddleware;
router.post('/signup', authController.signup);

router.post('/verify-otp', authController.verifyOtp);

router.post('/resend-otp', authController.resendOtp);
router.post('/login', authController.login);

router.post('/forgot-password', authController.forgotPasswordRequest);
router.post('/verify-forgot-password-otp', authController.verifyForgotPasswordOtp);
router.post('/reset-password', authController.resetPassword);
router.post('/update-password', checkAuth, authController.updatePassword);
router.post('/logout', checkAuth, authController.logout);
router.post('/update-username', checkAuth, authController.updateUsername);
router.post('/contact-us', authController.contactUs);
router.post('/save-profile', checkAuth, userController.saveProfile);
router.post('/upload-avatar', checkAuth, userController.uploadAvatar);
router.post('/save-minime-options', checkAuth, userController.saveMinimeOptions);
router.post('/generateOrRegenerateMinime', checkAuth, userController.generateOrRegenerateMinime);
module.exports = router;
