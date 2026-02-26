const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const ctrl = require('../../controllers/admin/adminBodyShapeController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (jpg, png, webp) are allowed'), false);
    }
  },
});

router.get('/', ctrl.list);
router.get('/create', ctrl.createForm);
router.post('/create', upload.single('imageFile'), ctrl.create);
router.get('/:id/edit', ctrl.editForm);
router.post('/:id/edit', upload.single('imageFile'), ctrl.update);
router.post('/:id/delete', ctrl.delete);

module.exports = router;
