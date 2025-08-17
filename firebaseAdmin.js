// firebaseAdmin.js
require('dotenv').config(); // make sure .env loads before reading vars
const admin = require('firebase-admin');

const projectId   = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
let   privateKey  = process.env.FIREBASE_PRIVATE_KEY;

if (!projectId || !clientEmail || !privateKey) {
  throw new Error('Missing FIREBASE_* env vars. Check .env is loaded and variables are set.');
}

// If the key is quoted and contains literal \n, normalize it
privateKey = privateKey.replace(/^"|"$/g, '').replace(/\\n/g, '\n').trim();

if (!privateKey.includes('BEGIN PRIVATE KEY') || !privateKey.includes('END PRIVATE KEY')) {
  throw new Error('FIREBASE_PRIVATE_KEY looks malformed (BEGIN/END missing).');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

module.exports = admin;
