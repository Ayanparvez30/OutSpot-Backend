const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const ctrl = require('../../controllers/admin/adminShopController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (jpg, png, webp, gif) are allowed'), false);
    }
  },
});

router.get('/', ctrl.listItems);
router.get('/create', ctrl.createForm);
router.post('/create', upload.single('imageFile'), ctrl.createItem);
router.get('/:id/edit', ctrl.editForm);
router.post('/:id/edit', upload.single('imageFile'), ctrl.updateItem);
router.post('/:id/delete', ctrl.deleteItem);
router.post('/:id/feature', ctrl.toggleFeature);

module.exports = router;
