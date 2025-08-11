const express = require('express');
const router = express.Router();
const { uploadImageToS3 } = require('../controllers/upload');

router.post('/upload-image', uploadImageToS3);

module.exports = router;
