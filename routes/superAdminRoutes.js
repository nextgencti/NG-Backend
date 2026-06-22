const express = require('express');
const { admin, db, auth } = require('../config/firebase');
const verifyToken = require('../middleware/authMiddleware');
const requireRole = require('../middleware/roleMiddleware');
const emailService = require('../utils/emailService');
const upload = require('../middleware/uploadMiddleware');
const cloudinary = require('../config/cloudinary');
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

// 13. Get Web Controls Settings
router.get('/web-controls', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const docRef = db.collection('settings').doc('web_controls');
    const doc = await docRef.get();
    
    const defaultSettings = {
      homepageStats: {
        showStats: true,
        dataSource: 'dummy',
        dummyData: {
          studentsCount: 14,
          coursesCount: 1,
          successRate: 95,
          certificatesCount: 24
        }
      }
    };

    if (!doc.exists) {
      return res.status(200).json({ success: true, settings: defaultSettings });
    }

    const docData = doc.data();
    // Merge in case there are missing fields in future updates
    const settings = {
      homepageStats: {
        ...defaultSettings.homepageStats,
        ...(docData.homepageStats || {})
      }
    };

    res.status(200).json({ success: true, settings });
  } catch (error) {
    console.error('Fetch Web Controls Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching settings' });
  }
});

// 14. Update Web Controls Settings
router.post('/web-controls', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { homepageStats } = req.body;
    
    if (!homepageStats) {
      return res.status(400).json({ success: false, message: 'Invalid settings data' });
    }

    const docRef = db.collection('settings').doc('web_controls');
    await docRef.set({ homepageStats }, { merge: true });

    res.status(200).json({ success: true, message: 'Settings updated successfully' });
  } catch (error) {
    console.error('Update Web Controls Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating settings' });
  }
});

// Utility for uploading memory buffer to cloudinary
const uploadToCloudinary = (fileBuffer, folder, mimetype = '') => {
  return new Promise((resolve, reject) => {
    const resourceType = mimetype === 'application/pdf' ? 'raw' : 'auto';
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        folder: folder,
        resource_type: resourceType
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    uploadStream.end(fileBuffer);
  });
};

// 15. Get All Government Services
router.get('/gov-services', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const snapshot = await db.collection('gov_services').orderBy('createdAt', 'desc').get();
    const services = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ success: true, services });
  } catch (error) {
    console.error('Fetch Gov Services Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching government services' });
  }
});

// 16. Create Government Service
router.post('/gov-services', verifyToken, requireRole('superadmin'), upload.single('image'), async (req, res) => {
  try {
    const { name, tagline, description, link, category } = req.body;
    let imageUrl = null;

    if (!name || !link || !category) {
      return res.status(400).json({ success: false, message: 'Name, link, and category are required' });
    }

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'gov_services', req.file.mimetype);
      imageUrl = result.secure_url;
    }

    const serviceData = {
      name,
      tagline: tagline || '',
      description: description || '',
      link,
      category,
      imageUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('gov_services').add(serviceData);

    res.status(201).json({
      success: true,
      message: 'Government service created successfully',
      service: { id: docRef.id, ...serviceData }
    });
  } catch (error) {
    console.error('Create Gov Service Error:', error);
    res.status(500).json({ success: false, message: 'Server error creating government service' });
  }
});

// 17. Update Government Service
router.put('/gov-services/:id', verifyToken, requireRole('superadmin'), upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, tagline, description, link, category } = req.body;

    const docRef = db.collection('gov_services').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Government service not found' });
    }

    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (name !== undefined) updateData.name = name;
    if (tagline !== undefined) updateData.tagline = tagline;
    if (description !== undefined) updateData.description = description;
    if (link !== undefined) updateData.link = link;
    if (category !== undefined) updateData.category = category;

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'gov_services', req.file.mimetype);
      updateData.imageUrl = result.secure_url;
    }

    await docRef.update(updateData);

    res.status(200).json({
      success: true,
      message: 'Government service updated successfully',
      service: { id, ...doc.data(), ...updateData }
    });
  } catch (error) {
    console.error('Update Gov Service Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating government service' });
  }
});

// 18. Delete Government Service
router.delete('/gov-services/:id', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection('gov_services').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Government service not found' });
    }

    await docRef.delete();

    res.status(200).json({ success: true, message: 'Government service deleted successfully' });
  } catch (error) {
    console.error('Delete Gov Service Error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting government service' });
  }
});

// 19. Get All Typing Paragraphs
router.get('/typing-paragraphs', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const snapshot = await db.collection('typing_paragraphs').orderBy('createdAt', 'desc').get();
    const paragraphs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ success: true, paragraphs });
  } catch (error) {
    console.error('Fetch Typing Paragraphs Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching typing paragraphs' });
  }
});

// 20. Create Typing Paragraph
router.post('/typing-paragraphs', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { language, mode, text } = req.body;
    
    if (!language || !mode || !text) {
      return res.status(400).json({ success: false, message: 'Language, mode, and text are required' });
    }

    const paragraphData = {
      language, // 'english', 'javascript', 'numbers'
      mode, // 'normal', 'advanced'
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('typing_paragraphs').add(paragraphData);

    res.status(201).json({ 
      success: true, 
      message: 'Typing paragraph created successfully',
      paragraph: { id: docRef.id, ...paragraphData }
    });
  } catch (error) {
    console.error('Create Typing Paragraph Error:', error);
    res.status(500).json({ success: false, message: 'Server error creating paragraph' });
  }
});

// 21. Delete Typing Paragraph
router.delete('/typing-paragraphs/:id', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection('typing_paragraphs').doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Paragraph not found' });
    }

    await docRef.delete();
    res.status(200).json({ success: true, message: 'Paragraph deleted successfully' });
  } catch (error) {
    console.error('Delete Typing Paragraph Error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting paragraph' });
  }
});

// 22. Get All Student Activity Logs (with User details resolved)
router.get('/student-activities', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const activitySnapshot = await db.collection('student_activity')
      .orderBy('timestamp', 'desc')
      .limit(1000)
      .get();
      
    // Resolve student user details
    const studentMap = {};
    const studentsSnapshot = await db.collection('users').where('role', '==', 'student').get();
    studentsSnapshot.forEach(doc => {
      const u = doc.data();
      studentMap[doc.id] = {
        name: u.name || 'Unknown Student',
        email: u.email || 'N/A',
        rollNumber: u.rollNumber || 'N/A',
        photoURL: u.photoURL || null
      };
    });

    const activities = activitySnapshot.docs.map(doc => {
      const data = doc.data();
      const sDetails = studentMap[data.studentId] || {
        name: 'Unknown Student',
        email: 'N/A',
        rollNumber: 'N/A',
        photoURL: null
      };
      let ts = null;
      if (data.timestamp) {
        if (typeof data.timestamp.toDate === 'function') {
          ts = data.timestamp.toDate();
        } else if (data.timestamp._seconds) {
          ts = new Date(data.timestamp._seconds * 1000);
        } else if (data.timestamp.seconds) {
          ts = new Date(data.timestamp.seconds * 1000);
        } else {
          ts = new Date(data.timestamp);
        }
      }
      
      return {
        id: doc.id,
        ...data,
        timestamp: ts,
        studentName: sDetails.name,
        studentEmail: sDetails.email,
        studentRollNumber: sDetails.rollNumber,
        studentPhotoURL: sDetails.photoURL
      };
    });

    res.status(200).json({ success: true, activities });
  } catch (error) {
    console.error('Fetch Student Activities Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching student activities' });
  }
});

// 23. Get Specific Student Detailed Activity & Analytics
router.get('/students/:id/activity-details', verifyToken, requireRole('superadmin'), async (req, res) => {
  const { id } = req.params;

  try {
    // 1. Fetch Student User Profile
    const userDoc = await db.collection('users').doc(id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const uData = userDoc.data();
    
    // 2. Fetch all student_activity records for this student
    const activitySnapshot = await db.collection('student_activity')
      .where('studentId', '==', id)
      .get();
      
    const activities = activitySnapshot.docs.map(doc => {
      const data = doc.data();
      let ts = null;
      if (data.timestamp) {
        if (typeof data.timestamp.toDate === 'function') {
          ts = data.timestamp.toDate();
        } else if (data.timestamp._seconds) {
          ts = new Date(data.timestamp._seconds * 1000);
        } else if (data.timestamp.seconds) {
          ts = new Date(data.timestamp.seconds * 1000);
        } else {
          ts = new Date(data.timestamp);
        }
      }
      return {
        id: doc.id,
        ...data,
        timestamp: ts
      };
    }).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // 3. Fetch all test_results for this student
    const testResultsSnapshot = await db.collection('test_results')
      .where('studentId', '==', id)
      .get();
      
    // Fetch test details to map names
    const testsSnapshot = await db.collection('tests').get();
    const testsMap = {};
    testsSnapshot.forEach(doc => {
      testsMap[doc.id] = doc.data().title || 'Untitled Test';
    });

    const testResults = testResultsSnapshot.docs.map(doc => {
      const data = doc.data();
      let subTime = null;
      if (data.submittedAt) {
        if (typeof data.submittedAt.toDate === 'function') {
          subTime = data.submittedAt.toDate();
        } else if (data.submittedAt._seconds) {
          subTime = new Date(data.submittedAt._seconds * 1000);
        } else if (data.submittedAt.seconds) {
          subTime = new Date(data.submittedAt.seconds * 1000);
        } else {
          subTime = new Date(data.submittedAt);
        }
      }
      return {
        id: doc.id,
        ...data,
        submittedAt: subTime,
        testTitle: testsMap[data.testId] || 'Unknown Test'
      };
    }).sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

    res.status(200).json({
      success: true,
      student: {
        id: userDoc.id,
        name: uData.name || 'Unknown Student',
        email: uData.email || 'N/A',
        rollNumber: uData.rollNumber || 'N/A',
        photoURL: uData.photoURL || null,
        lastLogin: uData.lastLogin ? (typeof uData.lastLogin.toDate === 'function' ? uData.lastLogin.toDate() : new Date(uData.lastLogin)) : null,
        createdAt: uData.createdAt ? (typeof uData.createdAt.toDate === 'function' ? uData.createdAt.toDate() : new Date(uData.createdAt)) : null
      },
      activities,
      testResults
    });

  } catch (error) {
    console.error('Fetch Student Activity Details Error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving student details' });
  }
});

// 24. Upload Student Certificate
router.post('/students/:studentId/certificates', verifyToken, requireRole('superadmin'), upload.single('file'), async (req, res) => {
  const { studentId } = req.params;
  const { title, courseId, courseName, issueDate } = req.body;

  if (!title || !issueDate) {
    return res.status(400).json({ success: false, message: 'Title and Issue Date are required' });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Certificate file is required' });
  }

  try {
    // 1. Fetch student info
    const studentDoc = await db.collection('users').doc(studentId).get();
    if (!studentDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const studentData = studentDoc.data();

    // 2. Upload to Cloudinary
    const result = await uploadToCloudinary(req.file.buffer, 'student_certificates', req.file.mimetype);
    const pdfUrl = result.secure_url;

    // 3. Save to Firestore certificates collection
    const certData = {
      studentId,
      studentName: studentData.name || 'Unknown Student',
      studentRollNumber: studentData.rollNumber || 'N/A',
      courseId: courseId || studentData.courseId || null,
      courseName: courseName || studentData.courseName || null,
      title,
      issueDate,
      pdfUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('certificates').add(certData);

    res.status(201).json({
      success: true,
      message: 'Certificate uploaded successfully',
      certificate: { id: docRef.id, ...certData }
    });
  } catch (error) {
    console.error('Upload Student Certificate Error:', error);
    res.status(500).json({ success: false, message: 'Server error uploading certificate' });
  }
});

// 25. Get Student Certificates (Super Admin View)
router.get('/students/:studentId/certificates', verifyToken, requireRole('superadmin'), async (req, res) => {
  const { studentId } = req.params;

  try {
    const snapshot = await db.collection('certificates')
      .where('studentId', '==', studentId)
      .get();

    const certificates = snapshot.docs.map(doc => {
      const data = doc.data();
      let created = null;
      if (data.createdAt) {
        created = typeof data.createdAt.toDate === 'function' ? data.createdAt.toDate() : new Date(data.createdAt);
      }
      return {
        id: doc.id,
        ...data,
        createdAt: created
      };
    }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    res.status(200).json({ success: true, certificates });
  } catch (error) {
    console.error('Fetch Student Certificates Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching certificates' });
  }
});

// 26. Delete Certificate
router.delete('/certificates/:certificateId', verifyToken, requireRole('superadmin'), async (req, res) => {
  const { certificateId } = req.params;

  try {
    const certRef = db.collection('certificates').doc(certificateId);
    const certDoc = await certRef.get();
    if (!certDoc.exists) {
      return res.status(404).json({ success: false, message: 'Certificate not found' });
    }

    await certRef.delete();

    res.status(200).json({ success: true, message: 'Certificate deleted successfully' });
  } catch (error) {
    console.error('Delete Certificate Error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting certificate' });
  }
});

module.exports = router;



