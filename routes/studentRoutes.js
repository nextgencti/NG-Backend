const express = require('express');
const { admin, db, auth } = require('../config/firebase');
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
  const { address, phone, dob, photoURL, name, courseId, instituteId, password } = req.body;

  if (!phone || !name || !courseId || !instituteId) {
    return res.status(400).json({ success: false, message: 'Name, Course, Institute, and Phone are required' });
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
      instituteId: instituteId,
      address: address || '',
      phone: phone,
      dob: dob || '2000-01-01',
      ...(photoURL && { photoURL }),
      profileComplete: true,
      updatedAt: new Date()
    });

    // Return the updated user info
    const updatedDoc = await userRef.get();
    const updatedData = updatedDoc.data();

    // Fetch Institute Name
    if (updatedData.instituteId) {
      try {
        const instDoc = await db.collection('institutes').doc(updatedData.instituteId).get();
        if (instDoc.exists) {
          updatedData.instituteName = instDoc.data().name;
        }
      } catch (err) {
        console.warn('Failed to fetch institute name:', err.message);
      }
    }

    res.status(200).json({ 
      success: true, 
      message: 'Profile completed successfully',
      user: updatedData
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
    const updatedData = updatedDoc.data();

    // Fetch Institute Name
    if (updatedData.instituteId) {
      try {
        const instDoc = await db.collection('institutes').doc(updatedData.instituteId).get();
        if (instDoc.exists) {
          updatedData.instituteName = instDoc.data().name;
        }
      } catch (err) {
        console.warn('Failed to fetch institute name:', err.message);
      }
    }

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: updatedData
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
        const courseData = courseDoc.data();
        
        // Calculate total lessons
        let totalLessons = 0;
        (courseData.curriculum || []).forEach(module => {
          totalLessons += (module.lessons || []).length;
        });

        // Fetch student progress
        const progressSnap = await db.collection('student_progress')
          .where('studentId', '==', uid)
          .where('courseId', '==', courseDoc.id)
          .limit(1)
          .get();

        let progress = 0;
        let completedLessonsCount = 0;
        if (!progressSnap.empty) {
          const pData = progressSnap.docs[0].data();
          completedLessonsCount = (pData.completedLessons || []).length;
          progress = pData.progressPercentage || 0;
        }

        return { 
          id: courseDoc.id, 
          ...courseData,
          enrollmentStatus: enrData.status || 'active',
          progress: progress,
          completedModules: completedLessonsCount,
          totalModules: totalLessons
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

// Get Completed Test Result Details for Student
router.get('/tests/:testId/result', verifyToken, async (req, res) => {
  const { uid } = req.user;
  const { testId } = req.params;

  console.log(`[Result] Fetching result for studentId=${uid}, testId=${testId}`);

  try {
    const resultsSnapshot = await db.collection('test_results')
      .where('studentId', '==', uid)
      .where('testId', '==', testId)
      .get();

    if (resultsSnapshot.empty) {
      // Debug: Check what test_results exist for this student at all
      const allStudentResults = await db.collection('test_results')
        .where('studentId', '==', uid)
        .get();
      
      console.log(`[Result] No result found for testId=${testId}. Student has ${allStudentResults.size} total results.`);
      if (allStudentResults.size > 0) {
        allStudentResults.docs.forEach(doc => {
          const d = doc.data();
          console.log(`[Result]   - resultDoc=${doc.id}, testId=${d.testId}, score=${d.score}`);
        });
      }

      // Fallback: Try to find any result for this test by checking test_results without studentId filter
      // This helps diagnose if the result was stored with a different studentId format
      const testOnlyResults = await db.collection('test_results')
        .where('testId', '==', testId)
        .limit(5)
        .get();
      
      if (!testOnlyResults.empty) {
        console.log(`[Result] Found ${testOnlyResults.size} results for this testId with OTHER students:`);
        testOnlyResults.docs.forEach(doc => {
          const d = doc.data();
          console.log(`[Result]   - studentId=${d.studentId}, score=${d.score}`);
        });
      }

      return res.status(200).json({ success: false, message: 'No result found for this test.', result: null });
    }

    // Sort results by score (highest first) to show their best performance
    const results = resultsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    const bestResult = results[0];

    // Fetch test details to get the test title
    const testDoc = await db.collection('tests').doc(testId).get();
    const testTitle = testDoc.exists ? testDoc.data().title : 'Completed Test';
    const testCourse = testDoc.exists ? testDoc.data().course : 'Course';

    console.log(`[Result] Found ${results.length} result(s). Best score: ${bestResult.score}/${bestResult.totalMarks}`);

    res.status(200).json({
      success: true,
      result: {
        ...bestResult,
        testTitle,
        testCourse
      }
    });
  } catch (error) {
    console.error('Fetch Student Test Result Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching test result' });
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
  const { uid } = req.user;
  try {
    // Fetch student's instituteId
    const userDoc = await db.collection('users').doc(uid).get();
    const studentInstId = userDoc.data()?.instituteId;

    let query = db.collection('courses').where('status', '==', 'active');
    
    if (studentInstId) {
      query = query.where('instituteId', '==', studentInstId);
    }

    const snapshot = await query.get();
    const courses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ success: true, courses });
  } catch (error) {
    console.error('Fetch Catalog Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching catalog' });
  }
});

// 9. Get All Available Institutes (For Signup Profile Completion)
router.get('/all-institutes', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('institutes').where('status', '==', 'active').get();
    const institutes = snapshot.docs.map(doc => ({ id: doc.id, name: doc.data().name }));
    res.status(200).json({ success: true, institutes });
  } catch (error) {
    console.error('Fetch Institutes Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching institutes' });
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

    // Fetch student's instituteId to link enrollment to tenant
    const userDoc = await db.collection('users').doc(uid).get();
    const studentInstId = userDoc.data()?.instituteId;

    // Create enrollment record
    const enrollmentData = {
      studentId: uid,
      courseId,
      instituteId: studentInstId || null,
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

// 4. Get Student Activity & Auto-Attendance
router.get('/activity', verifyToken, async (req, res) => {
  const { uid } = req.user;
  try {
    // 1. Get User Last Login
    const userDoc = await db.collection('users').doc(uid).get();
    const lastLogin = userDoc.data()?.lastLogin ? userDoc.data().lastLogin.toDate() : null;

    // 2. Get Learning Activity Logs
    const activitySnapshot = await db.collection('student_activity')
      .where('studentId', '==', uid)
      .limit(50)
      .get();

    const logs = activitySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate()
    }))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 20);

    // 3. Auto-Calculate Attendance (Present if any activity on that date)
    // We'll check the last 30 days
    const attendance = [];
    let presentDays = 0;
    const today = new Date();
    
    for (let i = 0; i < 30; i++) {
      const date = new Date();
      date.setDate(today.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      const hasActivity = logs.some(log => 
        log.timestamp && log.timestamp.toISOString().split('T')[0] === dateStr
      );

      if (hasActivity) {
        presentDays++;
        attendance.push({ date: dateStr, status: 'present', activity: 'Platform Activity Recorded' });
      } else {
        // Only mark absent if it's not today (unless no activity yet today)
        attendance.push({ date: dateStr, status: 'absent', activity: 'No activity found' });
      }
    }

    const attendancePercentage = Math.round((presentDays / 30) * 100);

    // 4. Overall Progress & Top Course
    const enrollmentsSnapshot = await db.collection('enrollments').where('studentId', '==', uid).get();
    const courseIds = enrollmentsSnapshot.docs.map(doc => doc.data().courseId);
    
    let totalProgress = 0;
    let topCourse = 'N/A';
    let maxProgress = -1;

    if (courseIds.length > 0) {
      const progressSnapshot = await db.collection('student_progress').where('studentId', '==', uid).get();
      
      const progressMap = {};
      progressSnapshot.forEach(doc => {
        const pData = doc.data();
        progressMap[pData.courseId] = pData.progressPercentage || 0;
        totalProgress += pData.progressPercentage || 0;
      });

      // Find top course
      for (const cid of courseIds) {
        const prog = progressMap[cid] || 0;
        if (prog > maxProgress) {
          maxProgress = prog;
          const cDoc = await db.collection('courses').doc(cid).get();
          topCourse = cDoc.exists ? cDoc.data().name : cid;
        }
      }

      totalProgress = Math.round(totalProgress / courseIds.length);
    }

    res.status(200).json({ 
      success: true, 
      stats: {
        lastLogin,
        studyTime: '2.4 Hours', // Mocked
        activeDays: `${presentDays}/30`,
        progress: `${totalProgress}%`,
        attendancePercentage: `${attendancePercentage}%`,
        topCourse
      },
      logs,
      attendance
    });
  } catch (error) {
    console.error('Activity Fetch Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching activity' });
  }
});

// Legacy Alias
router.get('/attendance', verifyToken, async (req, res) => {
  res.redirect('/api/student/activity');
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
      // Bulletproof fallback for other legacy/mock course IDs in database
      if (id === 'OpkuOM4Yrv1ok8FSCTnY' || id === 'Z6Y453FdcneP2WRc4kqe' || id === 'NybP5qxXEuGI5yar2HKZ' || id === 'eqs5V9lVJyUSE68UAUc7' || id === '96YlDdgTtcyKA5Erz39d') {
        return 'CCC (Course of computer concepts)';
      }
      return null;
    }).filter(Boolean); // Remove nulls

    if (courseNames.length === 0) return res.status(200).json({ success: true, tests: [] });

    // Get student's instituteId once
    const userDoc = await db.collection('users').doc(uid).get();
    const studentInstId = userDoc.data()?.instituteId;

    // 3. Fetch all tests and filter flexibly in JavaScript to handle:
    // - Shorthand names (e.g. "CCC" matching "CCC (Course of computer concepts)")
    // - Case-insensitivity (e.g. "ccc" matching "CCC")
    // - Global tests (missing instituteId) or institute-specific tests
    const snapshot = await db.collection('tests').get();
    const allTests = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })).filter(test => {
      const testCourseName = (test.course || '').trim().toLowerCase();
      if (!testCourseName) return false;

      // Check if test course name matches any of the student's enrolled course names loosely
      const matchesCourse = courseNames.some(cName => {
        const studentCourseName = cName.trim().toLowerCase();
        
        // Exact match
        if (studentCourseName === testCourseName) return true;
        
        // Loose shorthand matching (e.g. "ccc" in "ccc (course of computer concepts)")
        // Match if student's course contains test's course (e.g. "CCC (Course...)" contains "CCC")
        // OR test's course contains student's course (e.g. "CCC" contains "CCC")
        if (studentCourseName.includes(testCourseName) || testCourseName.includes(studentCourseName)) return true;

        // Clean match (removing all spaces and special characters)
        const cleanStudent = studentCourseName.replace(/[^a-z0-9]/g, '');
        const cleanTest = testCourseName.replace(/[^a-z0-9]/g, '');
        if (cleanStudent && cleanTest && (cleanStudent.includes(cleanTest) || cleanTest.includes(cleanStudent))) return true;

        return false;
      });

      if (!matchesCourse) return false;

      // Filter by instituteId
      // Include the test if:
      // 1. Student has no instituteId (show all course-matching tests)
      // 2. Test has no instituteId (created by SuperAdmin or global)
      // 3. Test's instituteId matches the student's instituteId
      if (!studentInstId) return true;
      if (!test.instituteId || test.instituteId === 'NONE' || test.instituteId === 'undefined') return true;
      return test.instituteId === studentInstId;
    });

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

// ─── CLASSROOM ROUTES ─────────────────────────────────────────────────────────

// 10. Get Course Classroom Data (Curriculum + Student Progress)
router.get('/courses/:courseId/classroom', verifyToken, async (req, res) => {
  const { uid } = req.user;
  const { courseId } = req.params;

  try {
    // 1. Fetch the course document
    const courseDoc = await db.collection('courses').doc(courseId).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    const courseData = { id: courseDoc.id, ...courseDoc.data() };
    const curriculum = courseData.curriculum || [];

    // 2. Fetch student progress for this course
    const progressSnapshot = await db.collection('student_progress')
      .where('studentId', '==', uid)
      .where('courseId', '==', courseId)
      .limit(1)
      .get();

    let completedLessons = [];
    if (!progressSnapshot.empty) {
      completedLessons = progressSnapshot.docs[0].data().completedLessons || [];
    }

    // 3. Calculate total lessons and progress percentage
    let totalLessons = 0;
    curriculum.forEach(module => {
      totalLessons += (module.lessons || []).length;
    });

    const progressPercentage = totalLessons > 0 
      ? Math.round((completedLessons.length / totalLessons) * 100) 
      : 0;

    res.status(200).json({
      success: true,
      course: {
        id: courseData.id,
        name: courseData.name,
        thumbnailUrl: courseData.thumbnailUrl,
        duration: courseData.duration
      },
      curriculum,
      completedLessons,
      progressPercentage,
      totalLessons
    });
  } catch (error) {
    console.error('Fetch Classroom Data Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching classroom data' });
  }
});

// 11. Mark Lesson as Complete
router.post('/courses/:courseId/lessons/:lessonId/complete', verifyToken, async (req, res) => {
  const { uid } = req.user;
  const { courseId, lessonId } = req.params;

  try {
    // 1. Fetch course to validate lesson exists and check sequential order
    const courseDoc = await db.collection('courses').doc(courseId).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    const curriculum = courseDoc.data().curriculum || [];
    
    // Build flat list of all lesson IDs in order
    const allLessonIds = [];
    curriculum.forEach(module => {
      (module.lessons || []).forEach(lesson => {
        allLessonIds.push(lesson.id);
      });
    });

    const lessonIndex = allLessonIds.indexOf(lessonId);
    if (lessonIndex === -1) {
      return res.status(404).json({ success: false, message: 'Lesson not found in curriculum' });
    }

    // 2. Fetch or create student progress document
    const progressSnapshot = await db.collection('student_progress')
      .where('studentId', '==', uid)
      .where('courseId', '==', courseId)
      .limit(1)
      .get();

    let completedLessons = [];
    let progressDocRef;

    if (progressSnapshot.empty) {
      // Create new progress document
      progressDocRef = db.collection('student_progress').doc();
      completedLessons = [];
    } else {
      progressDocRef = progressSnapshot.docs[0].ref;
      completedLessons = progressSnapshot.docs[0].data().completedLessons || [];
    }

    // 3. Check if already completed
    if (completedLessons.includes(lessonId)) {
      return res.status(200).json({
        success: true,
        message: 'Lesson already completed',
        completedLessons,
        progressPercentage: Math.round((completedLessons.length / allLessonIds.length) * 100)
      });
    }

    // 4. Sequential unlock validation — previous lesson must be completed (except first)
    if (lessonIndex > 0) {
      const previousLessonId = allLessonIds[lessonIndex - 1];
      if (!completedLessons.includes(previousLessonId)) {
        return res.status(400).json({
          success: false,
          message: 'Please complete the previous lesson first'
        });
      }
    }

    // 5. Add lesson to completed list
    completedLessons.push(lessonId);
    const progressPercentage = Math.round((completedLessons.length / allLessonIds.length) * 100);

    await progressDocRef.set({
      studentId: uid,
      courseId: courseId,
      completedLessons: completedLessons,
      progressPercentage: progressPercentage,
      updatedAt: new Date()
    }, { merge: true });

    // 6. Log Activity
    await db.collection('student_activity').add({
      studentId: uid,
      courseId: courseId,
      type: 'lesson_complete',
      action: `Completed lesson in ${courseDoc.data().name || 'Course'}`,
      timestamp: new Date()
    });

    res.status(200).json({
      success: true,
      message: 'Lesson marked as complete',
      completedLessons,
      progressPercentage
    });
  } catch (error) {
    console.error('Mark Lesson Complete Error:', error);
    res.status(500).json({ success: false, message: 'Server error marking lesson complete' });
  }
});

// 12. Get Course Progress
router.get('/courses/:courseId/progress', verifyToken, async (req, res) => {
  const { uid } = req.user;
  const { courseId } = req.params;

  try {
    const progressSnapshot = await db.collection('student_progress')
      .where('studentId', '==', uid)
      .where('courseId', '==', courseId)
      .limit(1)
      .get();

    if (progressSnapshot.empty) {
      return res.status(200).json({
        success: true,
        completedLessons: [],
        progressPercentage: 0
      });
    }

    const data = progressSnapshot.docs[0].data();
    res.status(200).json({
      success: true,
      completedLessons: data.completedLessons || [],
      progressPercentage: data.progressPercentage || 0
    });
  } catch (error) {
    console.error('Fetch Progress Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching progress' });
  }
});

// 13. Get Student Notifications
router.get('/notifications', verifyToken, async (req, res) => {
  const { uid } = req.user;

  try {
    // 1. Fetch user's instituteId to filter broadcasts
    const userDoc = await db.collection('users').doc(uid).get();
    const userInstituteId = userDoc.exists ? userDoc.data().instituteId : null;

    // 2. Fetch notifications where recipientId is either the student's uid or 'all'
    const snapshot = await db.collection('notifications')
      .where('recipientId', 'in', [uid, 'all'])
      .get();

    let notifications = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      
      // Filter out broadcast notifications that do not match student's instituteId
      if (data.recipientId === 'all') {
        const notifInstId = data.instituteId;
        if (notifInstId && notifInstId !== 'all' && notifInstId !== userInstituteId) {
          return; // Skip this broadcast notification
        }
      }

      // Determine if read
      let isRead = false;
      if (data.recipientId === 'all') {
        const readBy = data.readBy || [];
        isRead = readBy.includes(uid);
      } else {
        isRead = data.isRead || false;
      }

      notifications.push({
        id: doc.id,
        title: data.title || '',
        message: data.message || '',
        type: data.type || 'info',
        link: data.link || '',
        courseId: data.courseId || null,
        isRead,
        createdAt: data.createdAt ? data.createdAt.toDate() : new Date()
      });
    });

    // Sort by createdAt descending
    notifications.sort((a, b) => b.createdAt - a.createdAt);

    res.status(200).json({
      success: true,
      notifications
    });
  } catch (error) {
    console.error('Fetch Notifications Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching notifications' });
  }
});

// 14. Mark Notification as Read
router.put('/notifications/:id/read', verifyToken, async (req, res) => {
  const { uid } = req.user;
  const { id } = req.params;

  try {
    const notifRef = db.collection('notifications').doc(id);
    const notifDoc = await notifRef.get();

    if (!notifDoc.exists) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    const data = notifDoc.data();

    if (data.recipientId === 'all') {
      // Add student uid to the readBy array using arrayUnion
      await notifRef.update({
        readBy: admin.firestore.FieldValue.arrayUnion(uid)
      });
    } else {
      // Ensure the student owns this notification
      if (data.recipientId !== uid) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }
      await notifRef.update({
        isRead: true
      });
    }

    res.status(200).json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Mark Notification Read Error:', error);
    res.status(500).json({ success: false, message: 'Server error marking notification as read' });
  }
});

module.exports = router;

