// utils/firebaseVerify.js
const admin = require('../firebaseAdmin');

async function verifyFirebaseIdToken(idToken) {
  const decoded = await admin.auth().verifyIdToken(idToken, true); // force check revocation
  const pid = process.env.FIREBASE_PROJECT_ID;

  // ✅ extra safety: project mismatch হলে রিজেক্ট করো
  if (decoded.aud !== pid || decoded.iss !== `https://securetoken.google.com/${pid}`) {
    const err = new Error('Token project mismatch');
    err.code = 'auth/invalid-project';
    throw err;
  }
  return decoded; // { uid, phone_number, email, ... }
}

module.exports = { verifyFirebaseIdToken };
