// firebaseAdmin.js
require('dotenv').config(); // make sure this is BEFORE anything else that imports this file
const admin = require('firebase-admin');

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY_BASE64 } = process.env;

if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY_BASE64) {
  throw new Error('Missing FIREBASE_* env vars. Check .env is loaded and variables are set.');
}

const privateKey = Buffer.from(FIREBASE_PRIVATE_KEY_BASE64, 'base64').toString('utf8').trim();

if (!privateKey.includes('BEGIN PRIVATE KEY') || !privateKey.includes('END PRIVATE KEY')) {
  throw new Error('Decoded private key is malformed. Check your Base64 content.');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}

module.exports = admin;
