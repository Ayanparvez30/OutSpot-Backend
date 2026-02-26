const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');

const { checkAuth } = authMiddleware;
const shop = require('../controllers/shopController');

router.get('/shop/clothing', checkAuth, shop.listClothing);
router.get('/shop/clothing/featured', checkAuth, shop.listFeatured);
router.get('/shop/inventory', checkAuth, shop.getInventory);

router.get('/shop/multipliers', checkAuth, shop.listMultipliers);
router.get('/shop/multiplier/active', checkAuth, shop.getActiveMultiplier);

router.post('/shop/iap/confirm', checkAuth, shop.confirmIAPPurchase);

router.post('/shop/equip', checkAuth, shop.equipItem);

router.get('/shop/bundles', checkAuth, shop.listPointBundles);
router.post('/shop/bundles/purchase', checkAuth, shop.purchasePointBundle);

router.post('/shop/custom/preview', checkAuth, shop.previewCustomOutfit);
router.post('/shop/custom/quick-buy', checkAuth, shop.quickBuyFromPreview);

router.get('/shop/wardrobe', checkAuth, shop.getWardrobeInventory);

router.get('/shop/catalog', checkAuth, shop.getCatalog);
router.get('/shop/catalog/free', checkAuth, shop.getCatalogFree);
router.get('/shop/catalog/paid', checkAuth, shop.getCatalogPaid);

module.exports = router;
