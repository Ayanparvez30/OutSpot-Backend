// utils/iapVerify.js
exports.verifyApple = async (receipt, productId) => {
  if (!receipt || !productId) return { ok: false, message: 'Missing receipt or productId' };
  return { ok: true, transactionId: `apple_${productId}_${Buffer.from(receipt).toString('base64').slice(0,16)}` };
};
exports.verifyGoogle = async (receipt, productId) => {
  if (!receipt || !productId) return { ok: false, message: 'Missing receipt or productId' };
  return { ok: true, transactionId: `google_${productId}_${Buffer.from(receipt).toString('base64').slice(0,16)}` };
};

