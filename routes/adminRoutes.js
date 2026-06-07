const express = require('express');
const { admin, db, auth } = require('../config/firebase');
const verifyToken = require('../middleware/authMiddleware');
const requireRole = require('../middleware/roleMiddleware');
const upload = require('../middleware/uploadMiddleware');
const cloudinary = require('../config/cloudinary');
const emailService = require('../utils/emailService');
const router = express.Router();

// Utility for uploading memory buffer to cloudinary
const uploadToCloudinary = (fileBuffer, folder, mimetype = '') => {
  return new Promise((resolve, reject) => {
    // Determine the correct resource type. Cloudinary often blocks PDFs uploaded as 'image' (401 Unauthorized)
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

// 1. Get Dashboard System Stats
router.get('/stats', verifyToken, requireRole('admin'), async (req, res) => {
  // ... (unchanged)
  try {
    let studentsQuery = db.collection('users').where('role', '==', 'student');
    if (req.user.role === 'admin' && req.user.instituteId) {
      studentsQuery = studentsQuery.where('instituteId', '==', req.user.instituteId);
    }
    const studentsSnapshot = await studentsQuery.get();
    const studentsCount = studentsSnapshot.size;

    let coursesQuery = db.collection('courses');
    if (req.user.role === 'admin' && req.user.instituteId) {
      coursesQuery = coursesQuery.where('instituteId', '==', req.user.instituteId);
    }
    const coursesSnapshot = await coursesQuery.get();
    const coursesCount = coursesSnapshot.size;

    const stats = {
      totalStudents: studentsCount || 1248, 
      activeCourses: coursesCount || 24, 
      totalRevenue: '₹4.2M'
    };

    res.status(200).json({ success: true, stats });
  } catch (error) {
    console.error('Admin Stats Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching stats' });
  }
});

// 2. Get All Students
router.get('/students', verifyToken, requireRole('admin'), async (req, res) => {
  // ... (unchanged)
  try {
    let studentsQuery = db.collection('users').where('role', '==', 'student');
    if (req.user.role === 'admin' && req.user.instituteId) {
      studentsQuery = studentsQuery.where('instituteId', '==', req.user.instituteId);
    } else if (req.user.role === 'superadmin' && req.query.instituteId) {
      studentsQuery = studentsQuery.where('instituteId', '==', req.query.instituteId);
    }
    const studentsSnapshot = await studentsQuery.get();
    
    let studentsData = [];
    studentsSnapshot.forEach(doc => {
      const data = doc.data();
      studentsData.push({
        id: doc.id,
        name: data.name || data.fullName || 'Unknown Student',
        email: data.email,
        course: data.courseId || 'Unassigned',
        enrolledDate: data.createdAt ? new Date(data.createdAt.toDate()).toLocaleDateString() : 'N/A',
        status: data.status || 'active', // Respect actual status, fallback to active
        payment: 'cleared',
        ...data
      });
    });

    res.status(200).json({ success: true, students: studentsData });
  } catch (error) {
    console.error('Fetch Students Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching students' });
  }
});

// 2a. Update Student Status (Approve/Reject)
router.put('/students/:id/status', verifyToken, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // e.g., 'active', 'rejected', 'inactive'

  if (!['active', 'rejected', 'pending', 'inactive'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status value' });
  }

  try {
    const studentRef = db.collection('users').doc(id);
    const studentDoc = await studentRef.get();

    if (!studentDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    await studentRef.update({
      status: status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Assign Roll Number if approving for the first time
    if (status === 'active' && !studentDoc.data().rollNumber) {
      await db.runTransaction(async (transaction) => {
        const counterRef = db.collection('counters').doc('students');
        const counterDoc = await transaction.get(counterRef);
        
        let nextCount = 1;
        if (!counterDoc.exists) {
          transaction.set(counterRef, { count: 1 });
        } else {
          nextCount = counterDoc.data().count + 1;
          transaction.update(counterRef, { count: nextCount });
        }

        const year = new Date().getFullYear();
        const rollNumber = `NG-${year}-${String(nextCount).padStart(3, '0')}`;
        transaction.update(studentRef, { rollNumber });
      });
    }

    // Send approval email if status is active
    if (status === 'active') {
      try {
        const studentData = studentDoc.data();
        await emailService.sendApprovalEmail(studentData.email, studentData.name || studentData.fullName);
      } catch (emailError) {
        console.error('Failed to send approval email:', emailError);
        // We don't fail the request if email fails, but we log it
      }
    }

    res.status(200).json({ success: true, message: `Student status updated to ${status}` });
  } catch (error) {
    console.error('Update Student Status Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating student status' });
  }
});

// 2b. Delete a Student
router.delete('/students/:id', verifyToken, requireRole(['superadmin', 'admin']), async (req, res) => {
  const { id } = req.params;
  const { pin } = req.body;

  if (!pin) {
    return res.status(400).json({ success: false, message: 'PIN is required to delete a student' });
  }

  try {
    // Determine which PIN to check based on context / user role
    const correctSuperAdminPin = process.env.SUPERADMIN_PIN;
    const correctAdminPin = process.env.ADMIN_PIN;
    
    // We allow either PIN if they are a superadmin. Just admin pin if they are an admin.
    let isValidPin = false;
    if (req.user.role === 'superadmin' && String(pin) === String(correctSuperAdminPin)) {
      isValidPin = true;
    } else if (String(pin) === String(correctAdminPin)) {
      isValidPin = true;
    }

    if (!isValidPin) {
      return res.status(403).json({ success: false, message: 'Invalid PIN provided' });
    }

    const studentRef = db.collection('users').doc(id);
    const studentDoc = await studentRef.get();

    if (!studentDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    // Optional: Delete from Firebase Auth if desired
    try {
      await auth.deleteUser(id);
    } catch (authErr) {
      console.log(`Auth deletion skipped or failed for ${id}:`, authErr.message);
    }

    // Delete related enrollments (if you want to clean up)
    const enrollmentsSnapshot = await db.collection('enrollments').where('studentId', '==', id).get();
    const batch = db.batch();
    enrollmentsSnapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    
    batch.delete(studentRef);
    await batch.commit();

    res.status(200).json({ success: true, message: 'Student deleted successfully' });
  } catch (error) {
    console.error('Delete Student Error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting student' });
  }
});

// 3. Get All Courses
router.get('/courses', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    let coursesQuery = db.collection('courses');
    if (req.user.role === 'admin' && req.user.instituteId) {
      coursesQuery = coursesQuery.where('instituteId', '==', req.user.instituteId);
    } else if (req.user.role === 'superadmin' && req.query.instituteId) {
      coursesQuery = coursesQuery.where('instituteId', '==', req.query.instituteId);
    }
    const coursesSnapshot = await coursesQuery.get();
    
    // Fetch all active institutes to populate names
    const institutesSnapshot = await db.collection('institutes').get();
    const institutesMap = {};
    institutesSnapshot.forEach(doc => {
      institutesMap[doc.id] = doc.data().name;
    });

    let coursesData = [];
    coursesSnapshot.forEach(doc => {
      const data = doc.data();
      coursesData.push({ 
        id: doc.id, 
        ...data,
        instituteName: data.instituteId ? (institutesMap[data.instituteId] || 'Unknown Institute') : 'Global'
      });
    });

    if (coursesData.length === 0) {
      coursesData = [
        { id: 'webdev01', name: 'Web Development Bootcamp', duration: '6 months', fees: '12000', students: 450, status: 'active', instituteName: 'Global' },
        { id: 'appdev01', name: 'App Development Mastery', duration: '4 months', fees: '15000', students: 312, status: 'active', instituteName: 'Global' },
        { id: 'uiux01', name: 'UI/UX Design Pro', duration: '3 months', fees: '8000', students: 185, status: 'upcoming', instituteName: 'Global' }
      ];
    }

    res.status(200).json({ success: true, courses: coursesData });
  } catch (error) {
    console.error('Fetch Courses Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching courses' });
  }
});

// 3c. Delete a Course
router.delete('/courses/:id', verifyToken, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { pin } = req.body;

  if (!pin) {
    return res.status(400).json({ success: false, message: 'PIN is required to delete a course' });
  }

  try {
    const correctSuperAdminPin = process.env.SUPERADMIN_PIN;
    const correctAdminPin = process.env.ADMIN_PIN;
    
    let isValidPin = false;
    if (req.user.role === 'superadmin' && String(pin) === String(correctSuperAdminPin)) {
      isValidPin = true;
    } else if (String(pin) === String(correctAdminPin)) {
      isValidPin = true;
    }

    if (!isValidPin) {
      return res.status(403).json({ success: false, message: 'Invalid PIN provided' });
    }

    const courseRef = db.collection('courses').doc(id);
    const courseDoc = await courseRef.get();

    if (!courseDoc.exists) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    // Check ownership if user is admin
    if (req.user.role === 'admin' && courseDoc.data().instituteId !== req.user.instituteId) {
      return res.status(403).json({ success: false, message: 'Unauthorized to delete this course' });
    }

    // Delete related enrollments
    const enrollmentsSnapshot = await db.collection('enrollments').where('courseId', '==', id).get();
    const batch = db.batch();
    enrollmentsSnapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    
    // Delete the course
    batch.delete(courseRef);
    await batch.commit();

    res.status(200).json({ success: true, message: 'Course deleted successfully' });
  } catch (error) {
    console.error('Delete Course Error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting course' });
  }
});

// 3a. Get Pending Enrollments
router.get('/enrollments/pending', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    let enrollmentsQuery = db.collection('enrollments').where('status', '==', 'pending');
    if (req.user.role === 'admin' && req.user.instituteId) {
      enrollmentsQuery = enrollmentsQuery.where('instituteId', '==', req.user.instituteId);
    } else if (req.user.role === 'superadmin' && req.query.instituteId) {
      enrollmentsQuery = enrollmentsQuery.where('instituteId', '==', req.query.instituteId);
    }
    const enrollmentsSnapshot = await enrollmentsQuery.get();
      
    if (enrollmentsSnapshot.empty) {
      return res.status(200).json({ success: true, pendingRequests: [] });
    }

    const requestsPromises = enrollmentsSnapshot.docs.map(async doc => {
      const data = doc.data();
      
      // Fetch student details
      const studentDoc = await db.collection('users').doc(data.studentId).get();
      const studentData = studentDoc.exists ? studentDoc.data() : { name: 'Unknown', email: 'N/A' };
      
      // Fetch course details
      const courseDoc = await db.collection('courses').doc(data.courseId).get();
      const courseData = courseDoc.exists ? courseDoc.data() : { name: 'Unknown Course' };
      
      return {
        enrollmentId: doc.id,
        courseId: data.courseId,
        studentId: data.studentId,
        studentName: studentData.name || studentData.fullName || 'Unknown',
        studentEmail: studentData.email || 'N/A',
        courseName: courseData.name || 'Unknown Course',
        enrolledAt: data.enrolledAt ? new Date(data.enrolledAt.toDate()).toLocaleDateString() : 'N/A',
        status: data.status
      };
    });

    const pendingRequests = await Promise.all(requestsPromises);
    res.status(200).json({ success: true, pendingRequests });
  } catch (error) {
    console.error('Fetch Pending Enrollments Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching pending enrollments' });
  }
});

// 3b. Update Enrollment Status (Approve/Reject)
router.put('/enrollments/:id/status', verifyToken, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'active' or 'rejected'

  if (!['active', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }

  try {
    const enrollmentRef = db.collection('enrollments').doc(id);
    const enrollmentDoc = await enrollmentRef.get();

    if (!enrollmentDoc.exists) {
      return res.status(404).json({ success: false, message: 'Enrollment record not found' });
    }

    await enrollmentRef.update({
      status: status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // If approved, update student count in course
    if (status === 'active') {
      const courseId = enrollmentDoc.data().courseId;
      const courseRef = db.collection('courses').doc(courseId);
      const courseDoc = await courseRef.get();
      
      if (courseDoc.exists) {
        await courseRef.update({
          students: (courseDoc.data().students || 0) + 1
        });
      }
    }

    res.status(200).json({ success: true, message: `Enrollment ${status} successfully` });
  } catch (error) {
    console.error('Update Enrollment Status Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating enrollment status' });
  }
});

// 4. Create New Course
router.post('/courses', verifyToken, requireRole('admin'), upload.single('thumbnail'), async (req, res) => {
  try {
    const { name, duration, fees, status } = req.body;
    let thumbnailUrl = null;

    if (!name || !duration || !fees) {
      return res.status(400).json({ success: false, message: 'Missing required course fields' });
    }

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'nextgen_courses');
      thumbnailUrl = result.secure_url;
    }

    const courseData = {
      name,
      duration,
      fees: Number(fees),
      status: status || 'active',
      students: 0,
      thumbnailUrl,
      createdAt: new Date()
    };

    if (req.user.role === 'admin' && req.user.instituteId) {
      courseData.instituteId = req.user.instituteId;
    } else if (req.user.role === 'superadmin' && req.body.instituteId) {
      courseData.instituteId = req.body.instituteId;
    }

    const docRef = await db.collection('courses').add(courseData);

    // Create Notification for new course
    try {
      const notificationData = {
        recipientId: 'all',
        instituteId: req.user.role === 'admin' && req.user.instituteId ? req.user.instituteId : 'all',
        courseId: docRef.id,
        title: 'New Course Added!',
        message: `${name} has just been published. Check it out!`,
        type: 'course',
        link: `/dashboard/my-courses`,
        isRead: false,
        readBy: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('notifications').add(notificationData);
    } catch (notifErr) {
      console.error('Failed to create notification for new course:', notifErr);
    }

    res.status(201).json({ 
      success: true, 
      message: 'Course created successfully', 
      course: { id: docRef.id, ...courseData } 
    });

  } catch (error) {
    console.error('Create Course Error:', error);
    res.status(500).json({ success: false, message: 'Server error creating course' });
  }
});

// 4b. Update Course Curriculum (Saves modules array)
router.put('/courses/:id/curriculum', verifyToken, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { curriculum } = req.body; // Expects the modules array

  try {
    const courseRef = db.collection('courses').doc(id);
    const courseDoc = await courseRef.get();

    if (!courseDoc.exists) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    // Check if new modules or topics were added to trigger a notification
    const oldCurriculum = courseDoc.data().curriculum || [];
    let oldTopicsCount = 0;
    oldCurriculum.forEach(m => oldTopicsCount += (m.topics ? m.topics.length : 0));
    
    let newTopicsCount = 0;
    (curriculum || []).forEach(m => newTopicsCount += (m.topics ? m.topics.length : 0));

    let oldModulesCount = oldCurriculum.length;
    let newModulesCount = (curriculum || []).length;

    await courseRef.update({
      curriculum: curriculum,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Generate notifications for enrolled students if content increased
    if (newTopicsCount > oldTopicsCount || newModulesCount > oldModulesCount) {
      try {
        const enrollmentsSnapshot = await db.collection('enrollments')
          .where('courseId', '==', id)
          .where('status', '==', 'active')
          .get();
          
        if (!enrollmentsSnapshot.empty) {
          const batch = db.batch();
          const courseName = courseDoc.data().name || 'a course';
          
          enrollmentsSnapshot.docs.forEach(enrDoc => {
            const studentId = enrDoc.data().studentId;
            const notifRef = db.collection('notifications').doc();
            batch.set(notifRef, {
              recipientId: studentId,
              instituteId: req.user.role === 'admin' && req.user.instituteId ? req.user.instituteId : 'all',
              courseId: id,
              title: 'Course Updated!',
              message: `New content has been added to ${courseName}.`,
              type: 'lesson',
              link: `/dashboard/my-courses/${id}`,
              isRead: false,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
          });
          await batch.commit();
        }
      } catch (notifErr) {
        console.error('Failed to send curriculum update notifications:', notifErr);
      }
    }

    res.status(200).json({ success: true, message: 'Curriculum updated successfully' });
  } catch (error) {
    console.error('Update Curriculum Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating curriculum' });
  }
});

// 4c. Upload Content Image (for Jodit Editor / Cloudinary)
router.post('/upload-content-image', verifyToken, requireRole('admin'), upload.any(), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      console.error('[Upload] No files found in request');
      return res.status(400).json({ success: false, message: 'No image files provided' });
    }

    // Capture the first file regardless of field name (handles files[0], files[1], etc.)
    const file = req.files[0];
    console.log(`[Upload] Processing file: ${file.originalname} (Field: ${file.fieldname}, MimeType: ${file.mimetype})`);

    const result = await uploadToCloudinary(file.buffer, 'course_content_assets', file.mimetype);
    console.log('[Upload] Cloudinary Success:', result.secure_url);
    
    res.status(200).json({ 
      success: true, 
      url: result.secure_url 
    });
  } catch (error) {
    console.error('Content Image Upload Error Detail:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to upload image', 
      error: error.message 
    });
  }
});

// 5. Add New Student
router.post('/students', verifyToken, requireRole('admin'), upload.single('profilePic'), async (req, res) => {
  try {
    const { name, email, courseId, phone, address } = req.body;
    let photoURL = null;

    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Name and email are required' });
    }

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'nextgen_profiles');
      photoURL = result.secure_url;
    }

    // 1. Create or Get Firebase Auth User
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

    // 2. Save in Firestore
    // 3. Assign Roll Number
    let rollNumber = null;
    await db.runTransaction(async (transaction) => {
      const counterRef = db.collection('counters').doc('students');
      const counterDoc = await transaction.get(counterRef);
      
      let nextCount = 1;
      if (!counterDoc.exists) {
        transaction.set(counterRef, { count: 1 });
      } else {
        nextCount = counterDoc.data().count + 1;
        transaction.update(counterRef, { count: nextCount });
      }

      const year = new Date().getFullYear();
      rollNumber = `NG-${year}-${String(nextCount).padStart(3, '0')}`;
    });

    const userData = {
      uid,
      email,
      name,
      fullName: name,
      courseId: courseId || null,
      phone: phone || null,
      address: address || null,
      role: 'student',
      profileComplete: true, // Mark as complete since Admin created it
      photoURL,
      status: 'active',
      rollNumber,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (req.user.role === 'admin' && req.user.instituteId) {
      userData.instituteId = req.user.instituteId;
    } else if (req.user.role === 'superadmin' && req.body.instituteId) {
      userData.instituteId = req.body.instituteId;
    }

    await db.collection('users').doc(uid).set(userData, { merge: true });

    // 3. Create initial enrollment record if courseId is provided
    if (courseId) {
      const enrollmentData = {
        studentId: uid,
        courseId: courseId,
        enrolledAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active'
      };
      if (req.user.role === 'admin' && req.user.instituteId) {
        enrollmentData.instituteId = req.user.instituteId;
      } else if (req.user.role === 'superadmin' && req.body.instituteId) {
        enrollmentData.instituteId = req.body.instituteId;
      }
      await db.collection('enrollments').add(enrollmentData);
      
      // Update student count in course
      const courseRef = db.collection('courses').doc(courseId);
      const courseDoc = await courseRef.get();
      if (courseDoc.exists) {
        await courseRef.update({
          students: (courseDoc.data().students || 0) + 1
        });
      }
    }

    res.status(201).json({ 
      success: true, 
      message: 'Student added successfully',
      student: userData
    });

  } catch (error) {
    console.error('Add Student Error:', error);
    res.status(500).json({ success: false, message: 'Server error adding student' });
  }
});

// ─── TEST ROUTES ──────────────────────────────────────────────────────────────

// Multer config that accepts CSV files
const multer = require('multer');
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) cb(null, true);
    else cb(new Error('Only CSV files are allowed for questions'), false);
  }
});

// Helper: Parse CSV buffer → array of question objects (Handles UTF-8 & Quoted Fields)
const parseQuestionsCSV = (buffer) => {
  // Debug: Log first 20 bytes of the buffer
  console.log('DEBUG: CSV Buffer start (hex):', buffer.slice(0, 20).toString('hex'));

  // 1. Convert buffer to string, handle UTF-8 Byte Order Mark (BOM)
  let text = buffer.toString('utf-8');
  
  // Check if the conversion resulted in replacement characters (sign of wrong encoding)
  const replacementCharCount = (text.match(/\ufffd/g) || []).length;
  if (replacementCharCount > 5) {
    console.error(`DEBUG: Detected ${replacementCharCount} replacement characters. File might not be UTF-8.`);
    throw new Error('CSV file encoding error. Please ensure you save the file as "CSV UTF-8 (Comma delimited)" in Excel.');
  }

  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }

  // 2. Split lines, handle both \n and \r\n
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  if (lines.length < 2) throw new Error('CSV must have a header row and at least one question');

  const questions = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    
    // Robust character-by-character CSV row parser to support empty fields (like C and D for True/False questions)
    const cols = [];
    let currentVal = '';
    let inQuotes = false;
    for (let charIndex = 0; charIndex < row.length; charIndex++) {
      const char = row[charIndex];
      if (char === '"') {
        inQuotes = !inQuotes;
        // Handle escaped double quotes (e.g. "")
        if (charIndex + 1 < row.length && row[charIndex + 1] === '"' && inQuotes) {
          currentVal += '"';
          charIndex++;
        }
      } else if (char === ',' && !inQuotes) {
        cols.push(currentVal.trim());
        currentVal = '';
      } else {
        currentVal += char;
      }
    }
    cols.push(currentVal.trim());

    if (cols.length < 7) {
      console.warn(`DEBUG: Skipping row ${i} because it has only ${cols.length} columns instead of 7. Row: "${row}"`);
      continue;
    }

    const [question, option_a, option_b, option_c, option_d, correct_answer, marks] = cols;
    questions.push({
      question,
      options: { A: option_a || '', B: option_b || '', C: option_c || '', D: option_d || '' },
      correctAnswer: (correct_answer || 'A').toUpperCase().trim(),
      marks: Number(marks) || 1,
    });
  }
  return questions;
};

// 6. Create Test + Upload Questions CSV
router.post('/tests', verifyToken, requireRole('admin'), csvUpload.single('questionsCSV'), async (req, res) => {
  try {
    const { title, course, type, date, time, duration, totalMarks, questions, difficulty, description } = req.body;

    const testType = type || 'Live';

    if (!title || !course) {
      return res.status(400).json({ success: false, message: 'title and course are required' });
    }

    if (testType === 'Live' && (!date || !time)) {
      return res.status(400).json({ success: false, message: 'date and time are required for Live tests' });
    }

    const testData = {
      title,
      course,
      type: testType,
      date: date || '',
      time: time || '',
      duration: duration || '',
      totalMarks: Number(totalMarks) || 0,
      questions: Number(questions) || 0,
      difficulty: difficulty || 'Easy',
      description: description || '',
      isPublic: req.body.isPublic === 'true' || req.body.isPublic === true,
      status: 'upcoming',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Stamp instituteId for both admin and superadmin
    if (req.user.instituteId) {
      testData.instituteId = req.user.instituteId;
    }

    // Save the test document
    const testRef = await db.collection('tests').add(testData);
    const testId = testRef.id;

    // If CSV was uploaded, parse and batch-save questions
    let questionCount = 0;
    if (req.file) {
      const parsedQuestions = parseQuestionsCSV(req.file.buffer);
      if (parsedQuestions.length === 0) {
        return res.status(400).json({ success: false, message: 'CSV has no valid questions. Check the format.' });
      }

      // Batch write questions as sub-collection docs
      const batch = db.batch();
      parsedQuestions.forEach((q, idx) => {
        const qRef = db.collection('tests').doc(testId).collection('questions').doc(`q${idx + 1}`);
        batch.set(qRef, q);
      });
      await batch.commit();

      // Update the test's questionCount to reflect actual parsed count
      await testRef.update({ questions: parsedQuestions.length });
      questionCount = parsedQuestions.length;
    }

    // Generate notification for new test
    try {
      const notificationData = {
        recipientId: 'all',
        instituteId: req.user.role === 'admin' && req.user.instituteId ? req.user.instituteId : 'all',
        courseId: null,
        title: 'New Test Scheduled! 📝',
        message: `A new test "${testData.title}" has been scheduled for course "${testData.course}".`,
        type: 'test',
        link: '/dashboard/tests',
        isRead: false,
        readBy: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('notifications').add(notificationData);
    } catch (notifErr) {
      console.error('Failed to create notification for new test:', notifErr);
    }

    res.status(201).json({
      success: true,
      message: `Test created successfully with ${questionCount} questions uploaded.`,
      test: { id: testId, ...testData, questions: questionCount || testData.questions },
    });

  } catch (error) {
    console.error('Create Test Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error creating test' });
  }
});

// 7. Get All Tests
// 7. Get All Tests
router.get('/tests', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    console.log('DEBUG: /tests route hit, user role:', req.user?.role, 'instituteId:', req.user?.instituteId);

    let testsQuery = db.collection('tests');
    if (req.user.role === 'admin' && req.user.instituteId) {
      testsQuery = testsQuery.where('instituteId', '==', req.user.instituteId);
    }
    const snapshot = await testsQuery.get();
    console.log('DEBUG: Got snapshot, size:', snapshot.size);
    const tests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Sort in JS instead of Firestore to avoid needing a composite index
    tests.sort((a, b) => {
      const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : (a.createdAt || 0);
      const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : (b.createdAt || 0);
      return new Date(dateB) - new Date(dateA);
    });

    res.status(200).json({ success: true, tests });
  } catch (error) {
    console.error('Fetch Tests Error FULL:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    res.status(500).json({ success: false, message: 'Server error fetching tests: ' + (error.message || error.code || JSON.stringify(error)) });
  }
});

// 7a. Get Full Test Details (Including Questions and Answers)
router.get('/tests/:testId/full', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { testId } = req.params;
    
    const testDoc = await db.collection('tests').doc(testId).get();
    if (!testDoc.exists) return res.status(404).json({ success: false, message: 'Test not found' });
    
    // Fetch questions with correct answers for Admin
    const qSnapshot = await db.collection('tests').doc(testId).collection('questions').get();
    const questions = qSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Optional: map to an array and sort by ID if they were named q1, q2...
    questions.sort((a, b) => {
      const numA = parseInt(a.id.replace('q', '')) || 0;
      const numB = parseInt(b.id.replace('q', '')) || 0;
      return numA - numB;
    });

    res.status(200).json({ 
      success: true, 
      test: { id: testDoc.id, ...testDoc.data() },
      questions 
    });
  } catch (error) {
    console.error('Fetch Full Test Details Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching test' });
  }
});

// 8. Delete Test
router.post('/tests/delete', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: 'Test ID is required' });

    // Note: In Firestore, deleting a doc doesn't delete sub-collections automatically.
    // For a production app, you'd need to recursive-delete 'questions'.
    // For now, we delete the main test doc.
    await db.collection('tests').doc(id).delete();

    res.status(200).json({ success: true, message: 'Test deleted successfully' });
  } catch (error) {
    console.error('Delete Test Error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting test' });
  }
});

// 9. Update Test Status (e.g., Publish)
router.post('/tests/update-status', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { id, status } = req.body;
    if (!id || !status) return res.status(400).json({ success: false, message: 'ID and status are required' });

    await db.collection('tests').doc(id).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({ success: true, message: `Test status updated to ${status}` });
  } catch (error) {
    console.error('Update Test Status Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating test status' });
  }
});

// 10. Get Test Results (All student submissions for a test)
router.get('/tests/:testId/results', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { testId } = req.params;

    const testDoc = await db.collection('tests').doc(testId).get();
    if (!testDoc.exists) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }
    const testData = testDoc.data();

    const resultsSnapshot = await db.collection('test_results').where('testId', '==', testId).get();
    const studentIds = [...new Set(resultsSnapshot.docs.map(doc => doc.data().studentId))];
    
    const studentsMap = {};
    if (studentIds.length > 0) {
        const studentPromises = studentIds.map(uid => db.collection('users').doc(uid).get());
        const studentDocs = await Promise.all(studentPromises);
        studentDocs.forEach(doc => {
            if (doc.exists) {
                const data = doc.data();
                studentsMap[doc.id] = {
                    name: data.name || data.fullName || 'Unknown Student',
                    email: data.email || 'N/A',
                    photoURL: data.photoURL || null
                };
            }
        });
    }

    const results = resultsSnapshot.docs.map(doc => {
        const data = doc.data();
        const student = studentsMap[data.studentId] || { name: 'Unknown Student', email: 'N/A', photoURL: null };
        return {
            id: doc.id,
            studentName: student.name,
            studentEmail: student.email,
            studentPhoto: student.photoURL,
            score: data.score,
            percentage: data.percentage,
            grade: data.grade,
            attemptNumber: data.attemptNumber,
            detailedReport: data.detailedReport || [],
            submittedAt: data.submittedAt ? new Date(data.submittedAt.toDate()).toISOString() : null
        };
    });

    results.sort((a, b) => b.percentage - a.percentage);

    res.status(200).json({ success: true, testTitle: testData.title, results });

  } catch (error) {
    console.error('Fetch Test Results Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching test results' });
  }
});

// 10b. Get Public Test Results (Leads)
router.get('/tests/public-results', verifyToken, requireRole(['admin', 'superadmin']), async (req, res) => {
  try {
    const snapshot = await db.collection('public_test_results').orderBy('submittedAt', 'desc').get();
    const results = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      submittedAt: doc.data().submittedAt ? doc.data().submittedAt.toDate().toISOString() : null
    }));

    res.status(200).json({ success: true, results });
  } catch (error) {
    console.error('Fetch Public Results Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching public leads' });
  }
});

// 11. Update Test Metadata
router.put('/tests/:testId', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { testId } = req.params;
    const updates = req.body; // { title, course, type, duration, totalMarks, etc. }

    delete updates.id;
    delete updates.questions; // Cannot be updated directly here
    delete updates.createdAt;

    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await db.collection('tests').doc(testId).update(updates);

    res.status(200).json({ success: true, message: 'Test metadata updated successfully' });
  } catch (error) {
    console.error('Update Test Metadata Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating test metadata' });
  }
});

// 12. Add a Custom Question manually
router.post('/tests/:testId/questions', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { testId } = req.params;
    const { question, options, correctAnswer, marks } = req.body;

    if (!question || !options || !correctAnswer || !marks) {
      return res.status(400).json({ success: false, message: 'Missing required question fields' });
    }

    const testRef = db.collection('tests').doc(testId);
    const testDoc = await testRef.get();
    
    if (!testDoc.exists) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }

    // Generate numeric id like q41
    const currentQuestionsCount = testDoc.data().questions || 0;
    const newCount = currentQuestionsCount + 1;
    const newQId = `q${Date.now()}`; // Unique enough or use q<number> but careful of deletions

    const questionData = {
      question,
      options,
      correctAnswer: String(correctAnswer).toUpperCase(),
      marks: Number(marks)
    };

    await db.collection('tests').doc(testId).collection('questions').doc(newQId).set(questionData);
    
    // Increment count on test doc
    await testRef.update({ questions: newCount });

    res.status(201).json({ success: true, message: 'Question added successfully', question: { id: newQId, ...questionData } });

  } catch (error) {
    console.error('Add Question Error:', error);
    res.status(500).json({ success: false, message: 'Server error adding question' });
  }
});

// 13. Update a Custom Question
router.put('/tests/:testId/questions/:questionId', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { testId, questionId } = req.params;
    const { question, options, correctAnswer, marks } = req.body;

    if (!question || !options || !correctAnswer || !marks) {
      return res.status(400).json({ success: false, message: 'Missing required question fields' });
    }

    const qRef = db.collection('tests').doc(testId).collection('questions').doc(questionId);
    const qDoc = await qRef.get();
    
    if (!qDoc.exists) {
      return res.status(404).json({ success: false, message: 'Question not found' });
    }

    const questionData = {
      question,
      options,
      correctAnswer: String(correctAnswer).toUpperCase(),
      marks: Number(marks)
    };

    await qRef.update(questionData);

    res.status(200).json({ success: true, message: 'Question updated successfully', question: { id: questionId, ...questionData } });

  } catch (error) {
    console.error('Update Question Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating question' });
  }
});

// 14. Delete a Custom Question
router.delete('/tests/:testId/questions/:questionId', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { testId, questionId } = req.params;

    const testRef = db.collection('tests').doc(testId);
    const testDoc = await testRef.get();
    
    if (!testDoc.exists) return res.status(404).json({ success: false, message: 'Test not found' });

    const qRef = db.collection('tests').doc(testId).collection('questions').doc(questionId);
    const qDoc = await qRef.get();
    if (!qDoc.exists) return res.status(404).json({ success: false, message: 'Question not found' });

    await qRef.delete();
    
    // Decrement count
    const currentCount = testDoc.data().questions || 0;
    const newCount = Math.max(0, currentCount - 1);
    await testRef.update({ questions: newCount });

    res.status(200).json({ success: true, message: 'Question deleted successfully', newOptionsCount: newCount });

  } catch (error) {
    console.error('Delete Question Error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting question' });
  }
});

// 15. Verify Admin PIN
router.post('/verify-pin', verifyToken, requireRole(['admin', 'superadmin']), async (req, res) => {
  try {
    const { pin } = req.body;
    const ADMIN_SECRET_PIN = process.env.ADMIN_PIN || '1234';
    
    // Note: If a superadmin is accessing an admin route, they might use the Admin PIN or it could be bypassed 
    // but typically they wouldn't hit this endpoint since they login via SA PIN. Just in case, this is here.
    if (String(pin) === String(ADMIN_SECRET_PIN)) {
      return res.status(200).json({ success: true, message: 'PIN Verified' });
    }
    
    return res.status(401).json({ success: false, message: 'Invalid Admin PIN' });
  } catch (error) {
    console.error('Verify Admin PIN Error:', error);
    res.status(500).json({ success: false, message: 'Server error verifying PIN' });
  }
});

// 16. Profile & Institute Management
router.get('/profile', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });
    res.status(200).json({ success: true, profile: userDoc.data() });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error fetching profile' });
  }
});

router.put('/profile', verifyToken, requireRole('admin'), upload.single('photo'), async (req, res) => {
  try {
    const { name, phone } = req.body;
    let { photoURL } = req.body;
    const updates = {};
    
    if (name) updates.name = updates.fullName = name;
    if (phone) updates.phone = phone;
    
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'admin_profiles');
      photoURL = result.secure_url;
    }
    
    if (photoURL) updates.photoURL = photoURL;
    
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await db.collection('users').doc(req.user.uid).update(updates);
    
    // Fetch updated user to return
    const updatedUser = (await db.collection('users').doc(req.user.uid).get()).data();
    
    res.status(200).json({ success: true, message: 'Profile updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Update Profile Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating profile' });
  }
});

router.get('/institute', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    if (!req.user.instituteId) return res.status(400).json({ success: false, message: 'No institute associated with this account' });
    const instDoc = await db.collection('institutes').doc(req.user.instituteId).get();
    if (!instDoc.exists) return res.status(404).json({ success: false, message: 'Institute not found' });
    res.status(200).json({ success: true, institute: instDoc.data() });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error fetching institute details' });
  }
});

router.put('/institute', verifyToken, requireRole('admin'), upload.single('logo'), async (req, res) => {
  try {
    if (!req.user.instituteId) return res.status(400).json({ success: false, message: 'No institute associated with this account' });
    const { name, address, phone, email } = req.body;
    let { logoURL } = req.body;
    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    
    if (name) updates.name = name;
    if (address) updates.address = address;
    if (phone) updates.phone = phone;
    if (email) updates.email = email;

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'institute_logos');
      logoURL = result.secure_url;
    }
    
    if (logoURL) updates.logoURL = logoURL;
    
    await db.collection('institutes').doc(req.user.instituteId).update(updates);
    
    // Fetch updated institute
    const updatedInst = (await db.collection('institutes').doc(req.user.instituteId).get()).data();
    
    res.status(200).json({ success: true, message: 'Institute details updated successfully', institute: updatedInst });
  } catch (error) {
    console.error('Update Institute Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating institute' });
  }
});


module.exports = router;


