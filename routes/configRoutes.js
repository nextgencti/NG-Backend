const express = require('express');
const router = express.Router();

/**
 * @route GET /api/config/firebase
 * @desc Returns public Firebase configuration for the frontend
 * @access Public
 */
router.get('/firebase', (req, res) => {
  try {
    const config = {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID
    };

    // Check if variables are missing
    const missing = Object.entries(config)
      .filter(([_, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      console.warn(`[CONFIG] Missing Firebase environment variables: ${missing.join(', ')}`);
    }

    res.status(200).json(config);
  } catch (error) {
    console.error('Error fetching Firebase config:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

module.exports = router;
