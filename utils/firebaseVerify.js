// utils/firebaseVerify.js
const admin = require('../firebaseAdmin');

function normalizeIdToken(raw) {
  if (!raw) {
    const e = new Error('Missing Firebase ID token');
    e.code = 'auth/missing-id-token';
    throw e;
  }
  let t = String(raw).trim();
  if (t.startsWith('Bearer ')) t = t.slice(7).trim(); // <-- ✅ "Bearer " কেটে দাও
  // basic JWT shape check
  if (t.split('.').length !== 3 || t.length < 100) {
    const e = new Error('Invalid JWT format for Firebase ID token');
    e.code = 'auth/argument-error';
    throw e;
  }
  return t;
}

async function verifyFirebaseIdToken(idTokenRaw) {
  const idToken = normalizeIdToken(idTokenRaw);
  const decoded = await admin.auth().verifyIdToken(idToken, true); // throws if invalid/revoked
  const pid = process.env.FIREBASE_PROJECT_ID;

  // ✅ extra safety: project must match
  if (decoded.aud !== pid || decoded.iss !== `https://securetoken.google.com/${pid}`) {
    const err = new Error('Token project mismatch');
    err.code = 'auth/invalid-project';
    throw err;
  }
  return decoded; // { uid, phone_number, email, ... }
}

module.exports = { verifyFirebaseIdToken };
