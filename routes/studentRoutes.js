const express = require('express');
const { db, auth } = require('../config/firebase');
const cloudinary = require('../config/cloudinary');
const verifyToken = require('../middleware/authMiddleware');
const multer = require('multer');
const router = express.Router();

// Multer - memory storage (no temp files on disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'), false);
  }
});

// Upload Photo to Cloudinary (Protected)
router.post('/upload-photo', verifyToken, upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No photo file provided' });
  }

  try {
    // Upload buffer directly to Cloudinary via stream
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'students/profile', resource_type: 'image' },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    res.status(200).json({ success: true, photoURL: result.secure_url });
  } catch (error) {
    console.error('Photo upload error:', error);
    res.status(500).json({ success: false, message: 'Failed to upload photo' });
  }
});



// 1. Complete Profile (Protected)
router.post('/complete-profile', verifyToken, async (req, res) => {
  const { uid } = req.user; // from JWT middleware
  const { address, phone, dob, photoURL, name, courseId, password } = req.body;

  if (!phone || !name || !courseId) {
    return res.status(400).json({ success: false, message: 'Name, Course, and Phone are required' });
  }

  try {
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Optionally update password in Firebase Auth
    if (password && password.length >= 6) {
      await auth.updateUser(uid, { password: password });
    }

    // Update Firestore User Document
    await userRef.update({
      name: name,
      courseId: courseId,
      address: address || '',
      phone: phone,
      dob: dob || '2000-01-01',
      ...(photoURL && { photoURL }),
      profileComplete: true,
      updatedAt: new Date()
    });

    // Return the updated user info
    const updatedDoc = await userRef.get();

    res.status(200).json({ 
      success: true, 
      message: 'Profile completed successfully',
      user: updatedDoc.data()
    });

  } catch (error) {
    console.error('Complete Profile Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating profile' });
  }
});

// 2. Get Student Profile
router.get('/profile', verifyToken, async (req, res) => {
  const { uid } = req.user;
  
  try {
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    res.status(200).json({ success: true, user: doc.data() });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error fetching profile' });
  }
});

// 2b. Update Student Profile
router.put('/update-profile', verifyToken, async (req, res) => {
  const { uid } = req.user;
  const { name, phone, photoURL } = req.body;

  try {
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const updates = { updatedAt: new Date() };
    if (name) updates.name = name;
    if (phone) updates.phone = phone;
    if (photoURL !== undefined) updates.photoURL = photoURL; // allow nulling photo

    await userRef.update(updates);

    // If name was updated, optionally try to update Firebase Auth displayName
    if (name) {
      try {
        await auth.updateUser(uid, { displayName: name });
      } catch (authErr) {
        console.warn('Failed to update auth display name:', authErr);
      }
    }

    const updatedDoc = await userRef.get();

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: updatedDoc.data()
    });
  } catch (error) {
    console.error('Update Profile Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating profile' });
  }
});

// 3. Get Student Enrolled Courses (From enrollments collection)
router.get('/courses', verifyToken, async (req, res) => {
  const { uid } = req.user;
  
  try {
    // 1. Fetch enrollment records for this student
    const enrollmentsSnapshot = await db.collection('enrollments')
      .where('studentId', '==', uid)
      .get();

    if (enrollmentsSnapshot.empty) {
      // Fallback: If no enrollments exist yet, check the legacy courseId on the user doc
      const userDoc = await db.collection('users').doc(uid).get();
      const legacyCourseId = userDoc.data()?.courseId;
      
      if (legacyCourseId) {
        const courseDoc = await db.collection('courses').doc(legacyCourseId).get();
        if (courseDoc.exists) {
           return res.status(200).json({ success: true, courses: [{ id: courseDoc.id, ...courseDoc.data() }] });
        }
      }
      return res.status(200).json({ success: true, courses: [] });
    }

    // 2. Map enrollment records to course data
    const coursePromises = enrollmentsSnapshot.docs.map(async doc => {
      const enrData = doc.data();
      const courseDoc = await db.collection('courses').doc(enrData.courseId).get();
      if (courseDoc.exists) {
        return { 
          id: courseDoc.id, 
          ...courseDoc.data(),
          enrollmentStatus: enrData.status || 'active'
        };
      }
      return null;
    });

    const coursesUnfiltered = await Promise.all(coursePromises);
    const courses = coursesUnfiltered.filter(c => c !== null);

    res.status(200).json({ success: true, courses });
  } catch (error) {
    console.error('Fetch Enrolled Courses Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching courses' });
  }
});

// 6. Get Test Questions (When starting a test)
router.get('/tests/:testId', verifyToken, async (req, res) => {
  const { testId } = req.params;
  
  try {
    const testDoc = await db.collection('tests').doc(testId).get();
    if (!testDoc.exists) return res.status(404).json({ success: false, message: 'Test not found' });
    
    // We fetch questions, but WE DO NOT SEND correctAnswer to the client!
    const qSnapshot = await db.collection('tests').doc(testId).collection('questions').get();
    const questions = qSnapshot.docs.map(doc => {
      const data = doc.data();
      delete data.correctAnswer; // Critical: Remove the answer!
      return { id: doc.id, ...data };
    });

    res.status(200).json({ 
      success: true, 
      test: { id: testDoc.id, ...testDoc.data() },
      questions 
    });
  } catch (error) {
    console.error('Fetch Test Details Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching test' });
  }
});

// 7. Submit Test Answers
router.post('/tests/:testId/submit', verifyToken, async (req, res) => {
  const { uid } = req.user;
  const { testId } = req.params;
  const { answers } = req.body; // e.g., { q1: 'A', q2: 'C' }

  try {
    // 1. Get test and questions (with correct answers this time)
    const testDoc = await db.collection('tests').doc(testId).get();
    if (!testDoc.exists) return res.status(404).json({ success: false, message: 'Test not found' });
    const testData = testDoc.data();

    // Calculate attempt number based on existing results
    const existingResult = await db.collection('test_results')
      .where('studentId', '==', uid)
      .where('testId', '==', testId)
      .get();
    
    // Allow multiple attempts for all tests based on recent user feedback
    const attemptNumber = existingResult.size + 1;

    const qSnapshot = await db.collection('tests').doc(testId).collection('questions').get();
    let score = 0;
    const detailedReport = [];
    
    qSnapshot.docs.forEach(doc => {
      const qData = doc.data();
      const studentAnswer = answers[doc.id];
      let isCorrect = false;
      
      if (studentAnswer && qData.correctAnswer) {
        isCorrect = String(studentAnswer).toUpperCase() === String(qData.correctAnswer).toUpperCase();
      }
      
      if (isCorrect) {
        score += Number(qData.marks) || 1;
      }

      detailedReport.push({
        questionId: doc.id,
        question: qData.question,
        options: qData.options,
        studentAnswer: studentAnswer || null,
        correctAnswer: qData.correctAnswer,
        marks: qData.marks,
        isCorrect
      });
    });

    const percentage = (score / testData.totalMarks) * 100;
    
    let grade = 'F';
    if (percentage >= 90) grade = 'A+';
    else if (percentage >= 80) grade = 'A';
    else if (percentage >= 70) grade = 'B';
    else if (percentage >= 60) grade = 'C';
    else if (percentage >= 50) grade = 'D';

    const resultData = {
      studentId: uid,
      testId: testId,
      score,
      totalMarks: testData.totalMarks,
      percentage,
      grade,
      detailedReport,
      attemptNumber,
      submittedAt: new Date()
    };

    // Save result
    await db.collection('test_results').add(resultData);

    res.status(200).json({ 
      success: true, 
      message: 'Test submitted successfully',
      result: resultData
    });

  } catch (error) {
    console.error('Submit Test Error:', error);
    res.status(500).json({ success: false, message: 'Server error submitting test' });
  }
});

// 8. Get All Available Courses (For Catalog)
router.get('/all-courses', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('courses').where('status', '==', 'active').get();
    const courses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ success: true, courses });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error fetching catalog' });
  }
});

// 7. Join/Enroll in a Course
router.post('/enroll', verifyToken, async (req, res) => {
  const { uid } = req.user;
  const { courseId } = req.body;

  if (!courseId) return res.status(400).json({ success: false, message: 'Course ID is required' });

  try {
    // Check if already enrolled
    const existing = await db.collection('enrollments')
      .where('studentId', '==', uid)
      .where('courseId', '==', courseId)
      .get();

    if (!existing.empty) {
      return res.status(400).json({ success: false, message: 'You are already enrolled in this course' });
    }

    // Create enrollment record
    const enrollmentData = {
      studentId: uid,
      courseId,
      enrolledAt: new Date(),
      status: 'pending' // New enrollments require admin approval
    };

    await db.collection('enrollments').add(enrollmentData);

    // Optional: Increment student count in course doc
    const courseRef = db.collection('courses').doc(courseId);
    const courseDoc = await courseRef.get();
    if (courseDoc.exists) {
      await courseRef.update({
        students: (courseDoc.data().students || 0) + 1
      });
    }

    res.status(201).json({ success: true, message: 'Enrolled successfully!' });
  } catch (error) {
    console.error('Enrollment Error:', error);
    res.status(500).json({ success: false, message: 'Server error during enrollment' });
  }
});

// 4. Get Student Attendance Stats
router.get('/attendance', verifyToken, async (req, res) => {
  const { uid } = req.user;
  try {
    // Mocking attendance data since we don't have an attendance cron/logger
    const stats = {
      totalPresent: 45,
      totalAbsent: 3,
      percentage: '93.7%',
      recent: [
        { date: '2026-03-07', status: 'present' },
        { date: '2026-03-06', status: 'present' },
        { date: '2026-03-05', status: 'absent' }
      ]
    };
    
    res.status(200).json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error fetching attendance' });
  }
});

// 5. Get Student Tests (Based on their courses)
router.get('/tests', verifyToken, async (req, res) => {
  const { uid } = req.user;
  
  try {
    // 1. Get student's enrolled courseIds
    const enrollmentsSnapshot = await db.collection('enrollments')
      .where('studentId', '==', uid)
      .get();

    let courseIds = enrollmentsSnapshot.docs.map(doc => doc.data().courseId);

    // Legacy fallback check
    if (courseIds.length === 0) {
      const userDoc = await db.collection('users').doc(uid).get();
      const legacyCourseId = userDoc.data()?.courseId;
      if (legacyCourseId) courseIds.push(legacyCourseId);
    }

    if (courseIds.length === 0) return res.status(200).json({ success: true, tests: [] });

    // 2. Fetch course names for these courseIds
    const coursePromises = courseIds.map(id => db.collection('courses').doc(id).get());
    const courseDocs = await Promise.all(coursePromises);
    
    // Extract names and also handle fallback hardcoded names for mock courses
    const courseNames = courseDocs.map((doc, idx) => {
      if (doc.exists && doc.data().name) return doc.data().name;
      const id = courseIds[idx];
      if (id === 'webdev01') return 'Full Stack Web Development';
      if (id === 'appdev01') return 'App Development Mastery';
      if (id === 'uiux01') return 'UI/UX Design Masterclass';
      return null;
    }).filter(Boolean); // Remove nulls

    if (courseNames.length === 0) return res.status(200).json({ success: true, tests: [] });

    // 3. Fetch tests for ALL these courses
    // Note: Firestore 'in' query supports up to 10 items. Assuming < 10 enrolled courses for now.
    // If > 10, we need to batch them.
    const chunks = [];
    for (let i = 0; i < courseNames.length; i += 10) {
      chunks.push(courseNames.slice(i, i + 10));
    }

    let allTests = [];
    for (const chunk of chunks) {
      const snapshot = await db.collection('tests')
        .where('course', 'in', chunk)
        .get();
        
      const testsArr = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      allTests = [...allTests, ...testsArr];
    }

    // 4. Incorporate Student test results
    const resultsSnapshot = await db.collection('test_results')
      .where('studentId', '==', uid)
      .get();
    
    // Group results by testId
    const studentResultsMap = {};
    resultsSnapshot.docs.forEach(doc => {
      const data = doc.data();
      if (!studentResultsMap[data.testId]) studentResultsMap[data.testId] = [];
      studentResultsMap[data.testId].push(data);
    });

    const enrichedTests = allTests.map(test => {
      const results = studentResultsMap[test.id] || [];
      const attemptsCount = results.length;

      // Base test info
      let testObj = { ...test };

      if (attemptsCount > 0) {
        testObj.attemptsCount = attemptsCount;
        testObj.hasAttempts = true; // Flag to place in "Completed" tab
        
        // Calculate best score and best grade across all attempts
        const bestScore = Math.max(...results.map(r => r.score || 0));
        const bestResult = results.find(r => r.score === bestScore) || results[0];
          
        testObj.status = 'published'; // Keep published so they can re-attempt it
        testObj.score = bestResult.score;
        testObj.grade = bestResult.grade;
      }

      return testObj;
    });

    res.status(200).json({ success: true, tests: enrichedTests });
  } catch (error) {
    console.error('Fetch Student Tests Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching tests' });
  }
});

module.exports = router;
