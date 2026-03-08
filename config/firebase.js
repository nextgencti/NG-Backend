const admin = require('firebase-admin');
require('dotenv').config();

let serviceAccount;
try {
  // Parsing the entire JSON string provided in the .env file
  serviceAccount = JSON.parse(process.env.FIREBASE_PRIVATE_KEY);
} catch (error) {
  console.error("Failed to parse FIREBASE_PRIVATE_KEY. Ensure it contains the valid JSON.");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
