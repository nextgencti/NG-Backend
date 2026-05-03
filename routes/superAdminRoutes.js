const express = require('express');
const { admin, db, auth } = require('../config/firebase');
const verifyToken = require('../middleware/authMiddleware');
const requireRole = require('../middleware/roleMiddleware');
const emailService = require('../utils/emailService');
const router = express.Router();


// 1. Get All Institutes
router.get('/institutes', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const snapshot = await db.collection('institutes').orderBy('createdAt', 'desc').get();
    const institutes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ success: true, institutes });
  } catch (error) {
    console.error('Fetch Institutes Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching institutes' });
  }
});

// 2. Create Institute
router.post('/institutes', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { name, address, phone, email } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Institute name is required' });
    }

    const instituteData = {
      name,
      address: address || '',
      phone: phone || '',
      email: email || '',
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('institutes').add(instituteData);

    res.status(201).json({ 
      success: true, 
      message: 'Institute created successfully', 
      institute: { id: docRef.id, ...instituteData } 
    });
  } catch (error) {
    console.error('Create Institute Error:', error);
    res.status(500).json({ success: false, message: 'Server error creating institute' });
  }
});

// 3. Get All Admins
router.get('/admins', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const snapshot = await db.collection('users').where('role', '==', 'admin').get();
    
    // Also fetch institute details to attach names
    const institutesSnapshot = await db.collection('institutes').get();
    const institutesMap = {};
    institutesSnapshot.forEach(doc => {
      institutesMap[doc.id] = doc.data().name;
    });

    const admins = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        instituteName: data.instituteId ? (institutesMap[data.instituteId] || 'Unknown Institute') : 'Unassigned'
      };
    });

    res.status(200).json({ success: true, admins });
  } catch (error) {
    console.error('Fetch Admins Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching admins' });
  }
});

// 4. Create Regular Admin
router.post('/admins', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { name, email, instituteId } = req.body;

    if (!name || !email || !instituteId) {
      return res.status(400).json({ success: false, message: 'Name, email, and institute are required' });
    }

    // Verify Institute exists
    const instituteDoc = await db.collection('institutes').doc(instituteId).get();
    if (!instituteDoc.exists) {
      return res.status(404).json({ success: false, message: 'Institute not found' });
    }

    // Create Firebase Auth User
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(email);
    } catch (authError) {
      if (authError.code === 'auth/user-not-found') {
        userRecord = await auth.createUser({
          email: email,
          displayName: name,
          emailVerified: true
        });
      } else {
        throw authError;
      }
    }

    const { uid } = userRecord;

    const userData = {
      uid,
      email,
      name,
      fullName: name,
      role: 'admin',
      instituteId,
      profileComplete: true,
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('users').doc(uid).set(userData, { merge: true });

    res.status(201).json({ 
      success: true, 
      message: 'Admin created successfully',
      admin: userData
    });

  } catch (error) {
    console.error('Create Admin Error:', error);
    res.status(500).json({ success: false, message: 'Server error creating admin' });
  }
});

// 5. Get Dashboard Stats for Super Admin
router.get('/stats', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const institutesSnapshot = await db.collection('institutes').get();
    const studentsSnapshot = await db.collection('users').where('role', '==', 'student').get();
    const adminsSnapshot = await db.collection('users').where('role', '==', 'admin').get();

    const stats = {
      totalInstitutes: institutesSnapshot.size,
      totalStudents: studentsSnapshot.size,
      totalAdmins: adminsSnapshot.size
    };

    res.status(200).json({ success: true, stats });
  } catch (error) {
    console.error('Super Admin Stats Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching super admin stats' });
  }
});

// 6. Verify Super Admin PIN
router.post('/verify-pin', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { pin } = req.body;
    const SA_SECRET_PIN = process.env.SUPERADMIN_PIN || '12345678';
    
    if (String(pin) === String(SA_SECRET_PIN)) {
      return res.status(200).json({ success: true, message: 'PIN Verified' });
    }
    
    return res.status(401).json({ success: false, message: 'Invalid PIN' });
  } catch (error) {
    console.error('Verify PIN Error:', error);
    res.status(500).json({ success: false, message: 'Server error verifying PIN' });
  }
});

// 7. Get All Institute Registration Requests
router.get('/institute-requests', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const snapshot = await db.collection('institute_requests').orderBy('createdAt', 'desc').get();
    const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ success: true, requests });
  } catch (error) {
    console.error('Fetch Institute Requests Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching requests' });
  }
});

// 8. Approve Institute Request
router.post('/institute-requests/:id/approve', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { id } = req.params;
    const requestDoc = await db.collection('institute_requests').doc(id).get();
    
    if (!requestDoc.exists) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    const requestData = requestDoc.data();
    if (requestData.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Request is already processed' });
    }

    // 1. Create Institute
    const instituteData = {
      name: requestData.instituteName,
      address: requestData.address,
      phone: requestData.phone,
      email: requestData.email,
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const instRef = await db.collection('institutes').add(instituteData);

    // 2. Create Admin User
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(requestData.email);
    } catch (authError) {
      if (authError.code === 'auth/user-not-found') {
        userRecord = await auth.createUser({
          email: requestData.email,
          displayName: requestData.adminName,
          emailVerified: true
        });
      } else {
        throw authError;
      }
    }

    const { uid } = userRecord;
    
    // 2.1 Generate temporary 4-digit PIN
    const tempPin = Math.floor(1000 + Math.random() * 9000).toString();
    
    const userData = {
      uid,
      email: requestData.email,
      name: requestData.adminName,
      fullName: requestData.adminName,
      role: 'admin',
      instituteId: instRef.id,
      profileComplete: true,
      status: 'active',
      tempPin, // Store temp PIN
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('users').doc(uid).set(userData, { merge: true });

    // 3. Update Request Status
    await db.collection('institute_requests').doc(id).update({ 
      status: 'approved',
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // 4. Send Approval Email
    try {
      await emailService.sendInstituteApprovalEmail(
        requestData.email, 
        requestData.adminName, 
        requestData.instituteName,
        tempPin
      );
    } catch (err) {
      console.error('Failed to send approval email:', err.message);
    }


    res.status(200).json({ success: true, message: 'Institute and Admin created successfully' });
  } catch (error) {
    console.error('Approve Institute Request Error:', error);
    res.status(500).json({ success: false, message: 'Server error approving request' });
  }
});


// 9. Reject Institute Request
router.post('/institute-requests/:id/reject', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const requestDoc = await db.collection('institute_requests').doc(id).get();
    if (!requestDoc.exists) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    await db.collection('institute_requests').doc(id).update({ 
      status: 'rejected',
      rejectionReason: reason || 'No reason provided',
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    });


    // Send Rejection Email
    try {
      const requestData = requestDoc.data();
      await emailService.sendInstituteRejectionEmail(
        requestData.email,
        requestData.adminName,
        requestData.instituteName,
        reason
      );
    } catch (err) {
      console.error('Failed to send rejection email:', err.message);
    }

    res.status(200).json({ success: true, message: 'Request rejected' });

  } catch (error) {
    console.error('Reject Institute Request Error:', error);
    res.status(500).json({ success: false, message: 'Server error rejecting request' });
  }
});

// 10. Update Public Test Leaderboard Settings (Auto-Reset)
router.patch('/tests/:testId/leaderboard-settings', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { testId } = req.params;
    const { autoResetDuration } = req.body; // 'daily', 'weekly', 'monthly', 'never'

    await db.collection('tests').doc(testId).update({
      leaderboardResetDuration: autoResetDuration || 'never',
      lastLeaderboardReset: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({ success: true, message: 'Leaderboard settings updated successfully' });
  } catch (error) {
    console.error('Update Leaderboard Settings Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating settings' });
  }
});

// 11. Manually Reset Public Leaderboard
router.post('/tests/:testId/reset-leaderboard', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { testId } = req.params;
    console.log(`[SuperAdmin] Resetting leaderboard for testId: ${testId}`);

    const snapshot = await db.collection('public_test_results')
      .where('testId', '==', testId)
      .get();

    console.log(`[SuperAdmin] Found ${snapshot.size} records matching testId: ${testId}`);

    if (snapshot.empty) {
      // Still return success but with a specific message
      return res.status(200).json({ 
        success: true, 
        message: 'No records found for this test. Leaderboard is already clean.',
        count: 0 
      });
    }

    // Delete in batches
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();

    // Update last reset timestamp
    await db.collection('tests').doc(testId).update({
      lastLeaderboardReset: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({ success: true, message: 'Leaderboard reset successfully' });
  } catch (error) {
    console.error('Reset Leaderboard Error:', error);
    res.status(500).json({ success: false, message: 'Server error resetting leaderboard' });
  }
});

// 12. Delete Individual Public Test Result (Lead)
router.delete('/tests/public-results/:id', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('public_test_results').doc(id).delete();
    res.status(200).json({ success: true, message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Delete Lead Error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting lead' });
  }
});

module.exports = router;

