const admin = require('../firebaseAdmin');

async function verifyFirebaseIdToken(idToken) {
  const decoded = await admin.auth().verifyIdToken(idToken); // throws if invalid/expired
  return decoded; // { uid, phone_number, email, ... }
}

module.exports = { verifyFirebaseIdToken };
