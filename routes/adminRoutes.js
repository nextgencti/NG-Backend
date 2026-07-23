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

  if (!['active', 'rejected', 'pending', 'inactive', 'trial'].includes(status)) {
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
    const { name, duration, fees, status, courseFeeType, monthlyFee, fixedFee } = req.body;
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
      courseFeeType: courseFeeType || 'fixed',
      monthlyFee: monthlyFee ? Number(monthlyFee) : 0,
      fixedFee: fixedFee ? Number(fixedFee) : Number(fees),
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
        link: `/dashboard/courses`,
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
              link: `/dashboard/courses/${id}/classroom`,
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
    const { 
      name, email, courseId, phone, address,
      fatherName, motherName, dob, gender, aadhaar,
      batchTiming, admissionDate, totalFee, feePaid, paymentMode,
      admissionTakenBy, password
    } = req.body;
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
          password: password || 'NextGen@123',
          displayName: name,
          emailVerified: true
        });
      } else {
        throw authError;
      }
    }

    const { uid } = userRecord;

    // 2. Save in Firestore
    // 3. Assign Roll Number and Receipt Number
    let rollNumber = null;
    let receiptNumber = null;
    await db.runTransaction(async (transaction) => {
      // Roll Number
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

      // Receipt Number
      const receiptCounterRef = db.collection('counters').doc('receipts');
      const receiptCounterDoc = await transaction.get(receiptCounterRef);
      let nextReceiptCount = 1;
      if (!receiptCounterDoc.exists) {
        transaction.set(receiptCounterRef, { count: 1 });
      } else {
        nextReceiptCount = receiptCounterDoc.data().count + 1;
        transaction.update(receiptCounterRef, { count: nextReceiptCount });
      }
      receiptNumber = `REC-${year}-${String(nextReceiptCount).padStart(4, '0')}`;
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      fatherName: fatherName || null,
      motherName: motherName || null,
      dob: dob || null,
      gender: gender || null,
      aadhaar: aadhaar || null,
      batchTiming: batchTiming || null,
      admissionDate: admissionDate || null,
      totalFee: totalFee || null,
      feePaid: feePaid || null,
      paidAmount: Number(feePaid) || 0,
      paymentMode: paymentMode || null,
      admissionTakenBy: admissionTakenBy || null,
      receiptNumber: receiptNumber,
      password: password || null
    };

    if (req.user.role === 'admin' && req.user.instituteId) {
      userData.instituteId = req.user.instituteId;
    } else if (req.user.role === 'superadmin' && req.body.instituteId) {
      userData.instituteId = req.body.instituteId;
    }

    await db.collection('users').doc(uid).set(userData, { merge: true });

    // Create initial fee payment receipt if feePaid > 0
    if (Number(feePaid) > 0) {
      try {
        const recNo = receiptNumber || (`REC-ADM-` + uid.substring(0, 5).toUpperCase());
        const paymentData = {
          studentId: uid,
          studentName: name || 'Student',
          studentRollNumber: rollNumber || 'N/A',
          courseId: courseId || '',
          courseName: 'Admission Fee',
          amount: Number(feePaid),
          discountApplied: 0,
          paymentMethod: paymentMode || 'Cash',
          paymentType: 'admission',
          monthsPaid: [],
          receiptNo: recNo,
          notes: 'Initial admission fee payment',
          paidAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (userData.instituteId) {
          paymentData.instituteId = userData.instituteId;
        }
        await db.collection('fee_payments').add(paymentData);
      } catch (payErr) {
        console.error('Failed to create initial fee_payments receipt:', payErr);
      }
    }

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

// 5b. Edit Student Details
router.put('/students/:id', verifyToken, requireRole(['superadmin', 'admin']), upload.single('profilePic'), async (req, res) => {
  const { id } = req.params;
  try {
    const { 
      name, courseId, phone, address,
      fatherName, motherName, dob, gender, aadhaar,
      batchTiming, admissionDate, totalFee, feePaid, paymentMode,
      payment
    } = req.body;

    const studentRef = db.collection('users').doc(id);
    const studentDoc = await studentRef.get();
    if (!studentDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    let photoURL = studentDoc.data().photoURL || null;

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'nextgen_profiles');
      photoURL = result.secure_url;
    }

    const previousCourseId = studentDoc.data().courseId || studentDoc.data().course || null;

    const updateData = {
      photoURL,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (name) {
      updateData.name = name;
      updateData.fullName = name;
      await auth.updateUser(id, { displayName: name });
    }
    if (courseId !== undefined) {
      updateData.courseId = courseId || null;
      updateData.course = courseId || null;
    }
    if (phone !== undefined) updateData.phone = phone || null;
    if (address !== undefined) updateData.address = address || null;
    if (fatherName !== undefined) updateData.fatherName = fatherName || null;
    if (motherName !== undefined) updateData.motherName = motherName || null;
    if (dob !== undefined) updateData.dob = dob || null;
    if (gender !== undefined) updateData.gender = gender || null;
    if (aadhaar !== undefined) updateData.aadhaar = aadhaar || null;
    if (batchTiming !== undefined) updateData.batchTiming = batchTiming || null;
    if (admissionDate !== undefined) updateData.admissionDate = admissionDate || null;
    if (totalFee !== undefined) updateData.totalFee = totalFee || null;
    if (feePaid !== undefined) {
      updateData.feePaid = feePaid || null;
      if (studentDoc.data().paidAmount === undefined || studentDoc.data().paidAmount === null || Number(studentDoc.data().paidAmount) === 0) {
        updateData.paidAmount = Number(feePaid) || 0;
      }
    }
    if (paymentMode !== undefined) updateData.paymentMode = paymentMode || null;
    if (payment !== undefined) updateData.payment = payment || null;

    await studentRef.update(updateData);

    // Update course enrollments counts if course changed
    if (courseId !== undefined && courseId !== previousCourseId) {
      if (previousCourseId) {
        const prevCourseRef = db.collection('courses').doc(previousCourseId);
        const prevCourseDoc = await prevCourseRef.get();
        if (prevCourseDoc.exists) {
          const currentCount = prevCourseDoc.data().students || 0;
          await prevCourseRef.update({
            students: Math.max(0, currentCount - 1)
          });
        }
      }

      if (courseId) {
        const newCourseRef = db.collection('courses').doc(courseId);
        const newCourseDoc = await newCourseRef.get();
        if (newCourseDoc.exists) {
          const currentCount = newCourseDoc.data().students || 0;
          await newCourseRef.update({
            students: currentCount + 1
          });
        }

        const enrollSnapshot = await db.collection('enrollments')
          .where('studentId', '==', id)
          .where('courseId', '==', previousCourseId)
          .limit(1)
          .get();

        if (!enrollSnapshot.empty) {
          await enrollSnapshot.docs[0].ref.update({
            courseId: courseId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          const enrollmentData = {
            studentId: id,
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
        }
      }
    }

    const updatedStudentDoc = await studentRef.get();
    const updatedStudentData = { id, ...updatedStudentDoc.data() };

    res.status(200).json({ 
      success: true, 
      message: 'Student updated successfully',
      student: updatedStudentData
    });

  } catch (error) {
    console.error('Edit Student Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating student' });
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
router.get('/tests', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    console.log('DEBUG: /tests route hit, user role:', req.user?.role, 'instituteId:', req.user?.instituteId);

    let testsQuery = db.collection('tests');
    if (req.user.role === 'admin' && req.user.instituteId) {
      testsQuery = testsQuery.where('instituteId', '==', req.user.instituteId);
    }
    const snapshot = await testsQuery.get();
    console.log('DEBUG: Got snapshot, size:', snapshot.size);

    const tests = await Promise.all(snapshot.docs.map(async doc => {
      const data = doc.data();
      const qSnapshot = await db.collection('tests').doc(doc.id).collection('questions').get();
      const actualQuestionsCount = qSnapshot.size;

      // Auto-sync stored questions count if it mismatches actual questions subcollection size
      if (data.questions !== actualQuestionsCount) {
        doc.ref.update({ questions: actualQuestionsCount }).catch(err => console.error('Error auto-syncing questions count:', err));
      }

      return { id: doc.id, ...data, questions: actualQuestionsCount };
    }));

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
router.get('/tests/:testId/full', verifyToken, requireRole(['admin', 'superadmin', 'student']), async (req, res) => {
  try {
    const { testId } = req.params;
    
    // Enforce once-per-day viewing limit for students
    if (req.user.role === 'student') {
      const studentId = req.user.uid;
      const todayStr = new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
      
      const viewRef = db.collection('presentation_views')
        .where('studentId', '==', studentId)
        .where('testId', '==', testId)
        .where('date', '==', todayStr);
      
      const viewSnap = await viewRef.get();
      if (!viewSnap.empty) {
        // Check if the most recent view was within the last 2 minutes
        // to handle React strict mode double-firing or quick page refreshes gracefully
        const docs = viewSnap.docs.map(doc => doc.data());
        const recentView = docs.find(d => {
          const viewedAt = d.viewedAt ? (typeof d.viewedAt.toDate === 'function' ? d.viewedAt.toDate() : new Date(d.viewedAt)) : null;
          if (!viewedAt) return false;
          const diffMs = new Date() - viewedAt;
          return diffMs < 120000; // 2 minutes grace period
        });

        if (!recentView) {
          return res.status(403).json({ 
            success: false, 
            message: 'आप इस टेस्ट की प्रेजेंटेशन आज देख चुके हैं। छात्रों के लिए प्रतिदिन केवल एक बार देखने की सीमा है।' 
          });
        }
      } else {
        // Record this view
        await db.collection('presentation_views').add({
          studentId,
          testId,
          date: todayStr,
          viewedAt: new Date()
        });
      }
    }

    const testDoc = await db.collection('tests').doc(testId).get();
    if (!testDoc.exists) return res.status(404).json({ success: false, message: 'Test not found' });
    
    // Fetch questions with correct answers
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
    const newQId = `q${Date.now()}`; // Unique enough or use q<number> but careful of deletions

    const questionData = {
      question,
      options,
      correctAnswer: String(correctAnswer).toUpperCase(),
      marks: Number(marks)
    };

    await db.collection('tests').doc(testId).collection('questions').doc(newQId).set(questionData);
    
    // Sync exact subcollection count on test doc
    const qSnap = await db.collection('tests').doc(testId).collection('questions').get();
    const newCount = qSnap.size;
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
    
    // Sync exact subcollection count on test doc
    const qSnap = await testRef.collection('questions').get();
    const newCount = qSnap.size;
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


// ─── FINANCE & FEES MANAGEMENT ENDPOINTS ──────────────────────────────────────

// Helper to generate enrolled months list
const getEnrolledMonthsList = (createdAt, duration, feeType = 'fixed') => {
  const months = [];
  let start = new Date();
  if (createdAt) {
    if (typeof createdAt.toDate === 'function') {
      start = createdAt.toDate();
    } else {
      start = new Date(createdAt);
    }
  }
  
  const startYear = start.getFullYear();
  const startMonth = start.getMonth(); // 0-indexed
  
  let totalMonths = 1;
  if (feeType === 'monthly') {
    // Unlimited study duration: generate from start month up to the current calendar month
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const diffMonths = (currentYear - startYear) * 12 + (currentMonth - startMonth);
    totalMonths = Math.max(1, diffMonths + 1); // At least the enrollment month
  } else {
    // Fixed amount duration limit
    const durationMatch = duration ? String(duration).match(/\d+/) : null;
    totalMonths = durationMatch ? parseInt(durationMatch[0]) : 1;
  }
  
  for (let i = 0; i < totalMonths; i++) {
    const d = new Date(startYear, startMonth + i, 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}`);
  }
  return months;
};

// Helper to calculate monthly fee details (including pro-rata for first month)
const calculateMonthlyFeeDetails = (createdAt, netFee, monthsList) => {
  const details = {};
  let totalCost = 0;
  let start = new Date();
  if (createdAt) {
    if (typeof createdAt.toDate === 'function') {
      start = createdAt.toDate();
    } else {
      start = new Date(createdAt);
    }
  }
  
  monthsList.forEach((m, idx) => {
    if (idx === 0) {
      // Pro-rata for the first month
      const daysInFirstMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
      const studyDays = daysInFirstMonth - start.getDate() + 1;
      const firstMonthFee = Math.round((studyDays / daysInFirstMonth) * netFee);
      details[m] = firstMonthFee;
      totalCost += firstMonthFee;
    } else {
      details[m] = netFee;
      totalCost += netFee;
    }
  });
  
  return { details, totalCost };
};

// GET /admin/finance/summary
router.get('/finance/summary', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const instituteId = req.user.role === 'admin' && req.user.instituteId ? req.user.instituteId : null;
    
    // Fetch all courses
    let coursesQuery = db.collection('courses');
    if (instituteId) {
      coursesQuery = coursesQuery.where('instituteId', '==', instituteId);
    }
    const coursesSnapshot = await coursesQuery.get();
    const coursesMap = {};
    coursesSnapshot.forEach(doc => {
      coursesMap[doc.id] = doc.data();
    });
    
    // Fetch all students
    let studentsQuery = db.collection('users').where('role', '==', 'student');
    if (instituteId) {
      studentsQuery = studentsQuery.where('instituteId', '==', instituteId);
    }
    const studentsSnapshot = await studentsQuery.get();
    
    let totalDues = 0;
    let studentsCount = studentsSnapshot.size;
    let delinquentCount = 0;
    
    studentsSnapshot.forEach(doc => {
      const student = doc.data();
      const course = coursesMap[student.courseId];
      if (!course) return; // Skip if no course linked
      
      const config = student.feeConfig || {};
      const feeType = config.feeType || course.courseFeeType || 'fixed';
      
      let baseFee = 0;
      if (feeType === 'monthly') {
        baseFee = config.amount !== undefined && config.amount !== null ? Number(config.amount) : (course.monthlyFee || 0);
      } else {
        baseFee = config.amount !== undefined && config.amount !== null ? Number(config.amount) : (course.fixedFee || Number(course.fees) || 0);
      }
      
      // Calculate discount
      let discountAmount = 0;
      const discountType = config.discountType || 'none';
      const discountVal = Number(config.discountValue) || 0;
      
      if (discountType === 'flat') {
        discountAmount = discountVal;
      } else if (discountType === 'percentage') {
        discountAmount = (baseFee * discountVal) / 100;
      }
      
      const netFee = Math.max(0, baseFee - discountAmount);
      
      let totalStudentFee = 0;
      let studentPaidAmount = Number(student.paidAmount !== undefined && student.paidAmount !== null ? student.paidAmount : (student.feePaid || 0)) || 0;
      
      if (feeType === 'monthly') {
        const monthsList = getEnrolledMonthsList(student.createdAt, course.duration, 'monthly');
        const feeCalc = calculateMonthlyFeeDetails(student.createdAt, netFee, monthsList);
        totalStudentFee = feeCalc.totalCost;
      } else {
        totalStudentFee = netFee;
      }
      
      const studentDue = Math.max(0, totalStudentFee - studentPaidAmount);
      totalDues += studentDue;
      
      if (studentDue > 0) {
        delinquentCount++;
      }
    });
    
    // Fetch payments/transactions
    let paymentsQuery = db.collection('fee_payments');
    if (instituteId) {
      paymentsQuery = paymentsQuery.where('instituteId', '==', instituteId);
    }
    const paymentsSnapshot = await paymentsQuery.get();
    
    let totalRevenue = 0;
    const transactions = [];
    
    paymentsSnapshot.forEach(doc => {
      const p = doc.data();
      totalRevenue += Number(p.amount) || 0;
      
      transactions.push({
        id: doc.id,
        ...p,
        date: p.paidAt ? new Date(p.paidAt.toDate()).toLocaleDateString() : 'N/A'
      });
    });
    
    // Sort transactions in JS (to avoid composite index index creation issues)
    transactions.sort((a, b) => {
      const dateA = a.paidAt ? (typeof a.paidAt.toDate === 'function' ? a.paidAt.toDate() : new Date(a.paidAt)) : 0;
      const dateB = b.paidAt ? (typeof b.paidAt.toDate === 'function' ? b.paidAt.toDate() : new Date(b.paidAt)) : 0;
      return dateB - dateA;
    });
    
    res.status(200).json({
      success: true,
      stats: {
        totalRevenue,
        totalDues,
        delinquentCount,
        studentsCount
      },
      transactions: transactions.slice(0, 15) // send top 15
    });
  } catch (error) {
    console.error('Fetch Finance Summary Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching financial overview' });
  }
});

// GET /admin/finance/students
router.get('/finance/students', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const instituteId = req.user.role === 'admin' && req.user.instituteId ? req.user.instituteId : null;
    
    // Fetch courses map
    let coursesQuery = db.collection('courses');
    if (instituteId) {
      coursesQuery = coursesQuery.where('instituteId', '==', instituteId);
    }
    const coursesSnapshot = await coursesQuery.get();
    const coursesMap = {};
    coursesSnapshot.forEach(doc => {
      coursesMap[doc.id] = { id: doc.id, ...doc.data() };
    });
    
    // Fetch students
    let studentsQuery = db.collection('users').where('role', '==', 'student');
    if (instituteId) {
      studentsQuery = studentsQuery.where('instituteId', '==', instituteId);
    }
    const studentsSnapshot = await studentsQuery.get();
    
    const studentsData = [];
    
    studentsSnapshot.forEach(doc => {
      const s = doc.data();
      const course = coursesMap[s.courseId];
      
      if (!course) {
        // Enrolled in nothing or deleted course
        studentsData.push({
          id: doc.id,
          name: s.name || s.fullName || 'Unknown Student',
          rollNumber: s.rollNumber || 'N/A',
          courseName: 'No Enrolled Course',
          feeType: 'fixed',
          baseFee: 0,
          discountText: '—',
          paidAmount: 0,
          totalDue: 0,
          dueMonths: [],
          paidMonths: [],
          allMonths: []
        });
        return;
      }
      
      const config = s.feeConfig || {};
      const feeType = config.feeType || course.courseFeeType || 'fixed';
      
      let baseFee = 0;
      if (feeType === 'monthly') {
        baseFee = config.amount !== undefined && config.amount !== null ? Number(config.amount) : (course.monthlyFee || 0);
      } else {
        baseFee = config.amount !== undefined && config.amount !== null ? Number(config.amount) : (course.fixedFee || Number(course.fees) || 0);
      }
      
      // Discount
      let discountAmount = 0;
      let discountText = 'None';
      const discountType = config.discountType || 'none';
      const discountVal = Number(config.discountValue) || 0;
      
      if (discountType === 'flat') {
        discountAmount = discountVal;
        discountText = `₹${discountVal} Off`;
      } else if (discountType === 'percentage') {
        discountAmount = (baseFee * discountVal) / 100;
        discountText = `${discountVal}% Off`;
      }
      
      const netFee = Math.max(0, baseFee - discountAmount);
      
      let totalCost = 0;
      const allMonths = getEnrolledMonthsList(s.createdAt, course.duration, feeType);
      const paidMonths = s.paidMonths || [];
      let monthlyFeeDetails = {};
      
      if (feeType === 'monthly') {
        const feeCalc = calculateMonthlyFeeDetails(s.createdAt, netFee, allMonths);
        monthlyFeeDetails = feeCalc.details;
        totalCost = feeCalc.totalCost;
      } else {
        totalCost = netFee;
      }
      
      const paidAmount = Number(s.paidAmount !== undefined && s.paidAmount !== null ? s.paidAmount : (s.feePaid || 0)) || 0;
      const totalDue = Math.max(0, totalCost - paidAmount);
      
      // Determine due months for monthly students
      let dueMonths = [];
      if (feeType === 'monthly') {
        dueMonths = allMonths.filter(m => !paidMonths.includes(m));
      }
      
      studentsData.push({
        id: doc.id,
        name: s.name || s.fullName || 'Unknown Student',
        rollNumber: s.rollNumber || 'N/A',
        courseId: course.id,
        courseName: course.name,
        createdAt: s.createdAt ? (typeof s.createdAt.toDate === 'function' ? s.createdAt.toDate().toISOString() : s.createdAt) : new Date().toISOString(),
        feeType,
        baseFee,
        discountType,
        discountValue: discountVal,
        discountText,
        paidAmount,
        totalDue,
        dueMonths,
        paidMonths,
        allMonths,
        monthlyFeeDetails
      });
    });
    
    res.status(200).json({ success: true, students: studentsData });
  } catch (error) {
    console.error('Fetch Finance Students Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching student fees' });
  }
});

// POST /admin/finance/students/:studentId/config
router.post('/finance/students/:studentId/config', verifyToken, requireRole('admin'), async (req, res) => {
  const { studentId } = req.params;
  const { feeType, amount, discountType, discountValue } = req.body;
  
  if (!feeType || !['monthly', 'fixed'].includes(feeType)) {
    return res.status(400).json({ success: false, message: 'Invalid fee type' });
  }
  
  try {
    const studentRef = db.collection('users').doc(studentId);
    const studentDoc = await studentRef.get();
    
    if (!studentDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    const feeConfig = {
      feeType,
      amount: amount !== '' && amount !== undefined && amount !== null ? Number(amount) : null,
      discountType: discountType || 'none',
      discountValue: discountValue ? Number(discountValue) : 0
    };
    
    await studentRef.update({
      feeConfig,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.status(200).json({ success: true, message: 'Fee configuration updated successfully' });
  } catch (error) {
    console.error('Update Fee Config Error:', error);
    res.status(500).json({ success: false, message: 'Server error saving fee config' });
  }
});

// POST /admin/finance/pay-fee
router.post('/finance/pay-fee', verifyToken, requireRole('admin'), async (req, res) => {
  const { studentId, amount, paymentMethod, paymentType, months, notes, discountApplied } = req.body;
  
  if (!studentId || amount === undefined || !paymentMethod || !paymentType) {
    return res.status(400).json({ success: false, message: 'Missing required payment fields' });
  }
  
  try {
    const studentRef = db.collection('users').doc(studentId);
    const studentDoc = await studentRef.get();
    
    if (!studentDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    const s = studentDoc.data();
    
    // Fetch course details
    if (!s.courseId) {
      return res.status(400).json({ success: false, message: 'Student is not enrolled in a course' });
    }
    const courseDoc = await db.collection('courses').doc(s.courseId).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ success: false, message: 'Enrolled course details not found' });
    }
    const course = courseDoc.data();
    
    // Calculate receipt number inside a transaction
    let receiptNo = 'REC-1001';
    await db.runTransaction(async (transaction) => {
      const counterRef = db.collection('counters').doc('receipts');
      const counterDoc = await transaction.get(counterRef);
      
      let nextCount = 1001;
      if (!counterDoc.exists) {
        transaction.set(counterRef, { count: 1001 });
      } else {
        nextCount = (counterDoc.data().count || 1000) + 1;
        transaction.update(counterRef, { count: nextCount });
      }
      receiptNo = `REC-${nextCount}`;
    });
    
    const discountVal = Number(discountApplied) || 0;
    
    // Create payments transaction document
    const paymentData = {
      studentId,
      studentName: s.name || s.fullName || 'Unknown Student',
      studentRollNumber: s.rollNumber || 'N/A',
      courseId: s.courseId,
      courseName: course.name,
      amount: Number(amount),
      discountApplied: discountVal,
      paymentMethod,
      paymentType,
      monthsPaid: months || [],
      receiptNo,
      notes: notes || '',
      paidAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    if (s.instituteId) {
      paymentData.instituteId = s.instituteId;
    }
    
    const paymentRef = await db.collection('fee_payments').add(paymentData);
    
    // Update student paid states
    const studentUpdates = {
      paidAmount: (Number(s.paidAmount) || 0) + Number(amount) + discountVal,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    if (paymentType === 'monthly' && months && months.length > 0) {
      const currentPaid = s.paidMonths || [];
      const newPaid = [...currentPaid];
      months.forEach(m => {
        if (!newPaid.includes(m)) {
          newPaid.push(m);
        }
      });
      studentUpdates.paidMonths = newPaid;
    }
    
    await studentRef.update(studentUpdates);
    
    res.status(201).json({
      success: true,
      message: 'Payment registered successfully',
      transaction: {
        id: paymentRef.id,
        ...paymentData,
        date: new Date().toLocaleDateString()
      }
    });
  } catch (error) {
    console.error('Pay Fee Error:', error);
    res.status(500).json({ success: false, message: 'Server error processing payment' });
  }
});

// GET /admin/finance/transactions
router.get('/finance/transactions', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const instituteId = req.user.role === 'admin' && req.user.instituteId ? req.user.instituteId : null;
    
    let query = db.collection('fee_payments');
    if (instituteId) {
      query = query.where('instituteId', '==', instituteId);
    }
    
    const snapshot = await query.get();
    const transactions = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      transactions.push({
        id: doc.id,
        ...data,
        date: data.paidAt ? new Date(data.paidAt.toDate()).toLocaleDateString() : 'N/A'
      });
    });
    
    // Sort transactions in JS (to avoid index requirement issues)
    transactions.sort((a, b) => {
      const dateA = a.paidAt ? (typeof a.paidAt.toDate === 'function' ? a.paidAt.toDate() : new Date(a.paidAt)) : 0;
      const dateB = b.paidAt ? (typeof b.paidAt.toDate === 'function' ? b.paidAt.toDate() : new Date(b.paidAt)) : 0;
      return dateB - dateA;
    });
    
    res.status(200).json({ success: true, transactions });
  } catch (error) {
    console.error('Fetch Transactions Error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving transaction logs' });
  }
});

// POST /api/admin/explain-question
router.post('/explain-question', verifyToken, requireRole(['admin', 'superadmin', 'student']), async (req, res) => {
  try {
    const { question, options, correctAnswer } = req.body;
    if (!question || !correctAnswer) {
      return res.status(400).json({ success: false, message: 'Question and correctAnswer are required' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ success: false, message: 'AI Explanation service is not configured' });
    }

    const axios = require('axios');
    
    // Construct message prompt
    let message = `Question: ${question}\n`;
    if (options) {
      message += `Options:\n`;
      if (options.A) message += `A. ${options.A}\n`;
      if (options.B) message += `B. ${options.B}\n`;
      if (options.C) message += `C. ${options.C}\n`;
      if (options.D) message += `D. ${options.D}\n`;
    }
    message += `Correct Answer: ${correctAnswer}\n\nExplain in easy Hindi/Hinglish (3-4 sentences max) why this option is correct. Be very concise and do not include introductions.`;

    const contents = [{
      role: 'user',
      parts: [{ text: message }]
    }];

    const systemInstruction = {
      parts: [{ 
        text: "आप NextGen Computer Training Institute (Muskara) के AI Tutor 'Sanju' हैं। आपका काम शिक्षकों/छात्रों को एक बहुविकल्पीय प्रश्न (MCQ) का सही उत्तर और उसका स्पष्टीकरण बहुत ही आसान हिंदी/Hinglish भाषा में समझाना है। जवाब को संक्षिप्त (Short), पॉइंट-टू-पॉइंट और 3-4 वाक्यों में रखें। तकनीकी शब्दों को स्पष्ट करें।" 
      }]
    };

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents,
        systemInstruction
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    let explanation = "माफ़ी चाहता हूँ, मैं इस समय स्पष्टीकरण देने में असमर्थ हूँ।";
    if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      explanation = response.data.candidates[0].content.parts[0].text;
    }

    res.status(200).json({ success: true, explanation });
  } catch (error) {
    console.error('Explain Question Error:', error);
    res.status(500).json({ success: false, message: 'Server error explaining question' });
  }
});

// POST /api/admin/chat-ai
router.post('/chat-ai', verifyToken, requireRole(['admin', 'superadmin']), async (req, res) => {
  try {
    const { prompt, history } = req.body;
    if (!prompt) {
      return res.status(400).json({ success: false, message: 'Prompt is required' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ success: false, message: 'AI Chat service is not configured' });
    }

    const axios = require('axios');
    
    // Construct message history and format for Gemini API format
    let contents = [];
    if (history && Array.isArray(history)) {
      contents = history.map(item => ({
        role: item.role === 'user' ? 'user' : 'model',
        parts: [{ text: item.parts?.[0]?.text || item.content || '' }]
      }));
    }
    
    // Append current user prompt
    contents.push({
      role: 'user',
      parts: [{ text: prompt }]
    });

    const systemInstruction = {
      parts: [{ 
        text: "आप NextGen Computer Training Institute (Muskara) के AI Tutor 'Sanju' हैं। आपका काम शिक्षकों को कंप्यूटर टॉपिक्स (जैसे Web Development, Office, Tally आदि) पर बहुत ही सुंदर, व्यवस्थित, और स्पष्ट नोट्स बनाने में मदद करना है। नियम: 1. जवाब में कोई भी ग्रीटिंग (जैसे: 'नमस्ते', 'हेलो', 'प्रिय शिक्षक') या बातचीत शुरू/खत्म करने वाले वाक्य (जैसे: 'क्या आप चाहते हैं कि...', 'मुझे बताएं!') बिल्कुल न लिखें। 2. सीधे नोट्स का शीर्षक (Title), मुख्य बिंदु (Bullet Points) और उदाहरण देना शुरू करें। 3. नोट्स को बहुत ही सुंदर, स्पष्ट और पेशेवर बनाने के लिए हेडिंग्स, टेबल्स, बुलेट पॉइंट्स और कोड ब्लॉक्स का उपयुक्त उपयोग करें।" 
      }]
    };

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents,
        systemInstruction
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    let reply = "माफ़ी चाहता हूँ, मैं इस समय उत्तर देने में असमर्थ हूँ।";
    if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      reply = response.data.candidates[0].content.parts[0].text;
    }

    res.status(200).json({ success: true, reply });
  } catch (error) {
    console.error('AI Chat Error:', error);
    res.status(500).json({ success: false, message: 'Server error processing AI chat request' });
  }
});

// POST /api/admin/generate-questions
router.post('/generate-questions', verifyToken, requireRole(['admin', 'superadmin']), async (req, res) => {
  try {
    const { topic, count, lessons, courseName } = req.body;
    if (!topic && (!Array.isArray(lessons) || lessons.length === 0)) {
      return res.status(400).json({ success: false, message: 'Topic or lessons are required' });
    }
    const targetCount = parseInt(count) || 5;
    const finalCount = Math.min(100, Math.max(1, targetCount));

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ success: false, message: 'AI test generation service is not configured' });
    }

    const axios = require('axios');

    // Split targetCount into chunks of maximum 10 questions to avoid Gemini output token truncation limits
    const chunks = [];
    let remaining = finalCount;
    while (remaining > 0) {
      const chunkSize = Math.min(10, remaining);
      chunks.push(chunkSize);
      remaining -= chunkSize;
    }

    let allQuestions = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunkSize = chunks[chunkIdx];
      const existingTitles = allQuestions.map(q => q.question).slice(-30);
      const duplicatesPrompt = existingTitles.length > 0
        ? `\nCRITICAL: Do NOT generate any questions similar or identical to the following already generated questions:\n${JSON.stringify(existingTitles)}`
        : "";

      const prompt = `Generate exactly ${chunkSize} multiple-choice questions (MCQs) on the topic: "${topic}".
Each question must have exactly 4 options (A, B, C, D), a single correctAnswer (must be exactly 'A', 'B', 'C', or 'D'), and a default "marks" of 1.
The language of the questions and options should be simple English or Hinglish suitable for computer course students.${duplicatesPrompt}
You MUST output ONLY a valid JSON array of objects without any backticks, markdown formatting, or preamble. 

JSON structure example:
[
  {
    "question": "Question text here?",
    "options": {
      "A": "Option A text",
      "B": "Option B text",
      "C": "Option C text",
      "D": "Option D text"
    },
    "correctAnswer": "A",
    "marks": 1
  }
]`;

      const contents = [{
        role: 'user',
        parts: [{ text: prompt }]
      }];

      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`,
        {
          contents,
          generationConfig: {
            responseMimeType: "application/json"
          }
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      let generatedText = "";
      if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        generatedText = response.data.candidates[0].content.parts[0].text;
      }

      let chunkQuestions = [];
      try {
        chunkQuestions = JSON.parse(generatedText);
      } catch (parseErr) {
        console.error("Gemini JSON Chunk Parsing Error:", parseErr, generatedText);
        const match = generatedText.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (match) {
          chunkQuestions = JSON.parse(match[0]);
        }
      }

      if (Array.isArray(chunkQuestions)) {
        allQuestions = allQuestions.concat(chunkQuestions);
      }
    }

    res.status(200).json({ success: true, questions: allQuestions });
  } catch (error) {
    console.error('Generate Questions Error:', error);
    res.status(500).json({ success: false, message: 'Server error generating questions' });
  }
});

module.exports = router;


