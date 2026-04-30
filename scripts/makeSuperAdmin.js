require('dotenv').config();
const { auth, db } = require('../config/firebase');

const makeSuperAdmin = async () => {
  const email = process.argv[2];
  if (!email) {
    console.error('Please provide an email address as an argument.');
    console.error('Usage: node makeSuperAdmin.js <email>');
    process.exit(1);
  }

  try {
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(email);
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        console.log(`User with email ${email} not found in Firebase Auth. Creating one...`);
        userRecord = await auth.createUser({
          email: email,
          emailVerified: true
        });
      } else {
        throw error;
      }
    }

    const { uid } = userRecord;

    const userData = {
      uid,
      email,
      role: 'superadmin',
      status: 'active',
      profileComplete: true,
      createdAt: new Date()
    };

    await db.collection('users').doc(uid).set(userData, { merge: true });

    console.log(`Successfully assigned Super Admin role to ${email}`);
    process.exit(0);
  } catch (error) {
    console.error('Error making user super admin:', error);
    process.exit(1);
  }
};

makeSuperAdmin();
