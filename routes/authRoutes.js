const express = require('express');
const { admin, db, auth } = require('../config/firebase');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const emailService = require('../utils/emailService');
const router = express.Router();

// Mock store for OTPs (In production, use Redis)
const otpStore = new Map();

// Generate Token helper
const generateToken = (uid, role) => {
  return jwt.sign({ uid, role }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
};

// 1. Send OTP
router.post('/send-otp', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required' });
  }

  // Rate limiting: Check if an OTP was sent in the last 5 minutes
  const existingRecord = otpStore.get(email);
  if (existingRecord && Date.now() < existingRecord.canResendAt) {
    const waitTime = Math.ceil((existingRecord.canResendAt - Date.now()) / 1000 / 60);
    return res.status(429).json({ 
      success: false, 
      message: `Please wait ${waitTime} minute(s) before requesting a new OTP.` 
    });
  }

  // Generate a mock or real 6 digit OTP (using static for demo or random)
  const otp = Math.floor(100000 + Math.random() * 900000).toString(); 
  
  // Store it 
  otpStore.set(email, {
    otp,
    expires: Date.now() + 5 * 60 * 1000, // 5 minutes validity
    canResendAt: Date.now() + 5 * 60 * 1000 // 5 minutes rate limit
  });

  // Mail Send via centralized Email Service
  try {
    await emailService.sendOTPEmail(email, otp);
    console.log(`Email service triggered for OTP: ${otp} to ${email}`);
  } catch (error) {
    console.error('Failed to send email via service:', error.message);
    // Proceeding anyway so dev doesn't break if script fails
  }

  res.status(200).json({ success: true, message: 'OTP sent successfully' });
});

// 2. Verify OTP
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: 'Email and OTP required' });
  }

  const record = otpStore.get(email);

  if (!record) {
    return res.status(400).json({ success: false, message: 'OTP expired or not requested' });
  }

  if (record.otp !== otp) {
    return res.status(400).json({ success: false, message: 'Invalid OTP' });
  }

  if (Date.now() > record.expires) {
    otpStore.delete(email);
    return res.status(400).json({ success: false, message: 'OTP expired' });
  }

  // OTP Valid
  otpStore.delete(email);

  try {
    // 3. User Resolution Flow (Create if not exists)
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(email);
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        // Create new Firebase Auth User
        userRecord = await auth.createUser({
          email: email,
          emailVerified: true
        });
      } else {
        throw error;
      }
    }

    const { uid } = userRecord;

    // 4. Check Firestore for existing user profile
    const userDoc = await db.collection('users').doc(uid).get();
    let userData = {
      uid,
      email,
      role: 'student',
      status: 'pending', // New accounts need admin approval
      profileComplete: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (!userDoc.exists) {
      // Create new Firestore document
      await db.collection('users').doc(uid).set(userData);
    } else {
      userData = userDoc.data();
    }

    // 5. Generate JWT
    const token = generateToken(uid, userData.role);

    return res.status(200).json({
      success: true,
      message: 'Verified successfully',
      token,
      user: userData
    });

  } catch (error) {
    console.error('Verify OTP Error:', error);
    res.status(500).json({ success: false, message: 'Server Verification Error' });
  }
});

// 3. Google Login
router.post('/google-login', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ success: false, message: 'Google ID token required' });
  }

  try {
    // Verify the Firebase ID token from the client
    const decodedToken = await auth.verifyIdToken(idToken);
    const { uid, email, name, picture } = decodedToken;

    // Check Firestore for existing user profile
    const userDocRef = db.collection('users').doc(uid);
    const userDoc = await userDocRef.get();
    
    let isNewUser = false;
    let userData = {
      uid,
      email,
      name: name || '',
      photoURL: picture || null,
      provider: 'google',
      role: 'student',
      status: 'pending', // New accounts need admin approval
      profileComplete: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (!userDoc.exists) {
      // Create new Firestore document for the Google user
      await userDocRef.set(userData);
      isNewUser = true;
    } else {
      userData = userDoc.data();
      // Ensure we merge existing photo/name if not set initially
      if (!userData.photoURL && picture) {
        await userDocRef.update({ photoURL: picture });
        userData.photoURL = picture;
      }
    }

    // Generate session JWT
    const token = generateToken(uid, userData.role);

    return res.status(200).json({
      success: true,
      message: 'Google Login successful',
      token,
      user: userData,
      isNewUser
    });

  } catch (error) {
    console.error('Google Login Verification Error:', error);
    res.status(401).json({ success: false, message: 'Unauthorized / Invalid Google Token' });
  }
});

module.exports = router;
