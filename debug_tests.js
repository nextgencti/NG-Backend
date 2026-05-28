const dns = require('dns');
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');
require('dotenv').config();
const { db } = require('./config/firebase');

async function debugTests() {
  try {
    // 1. Get ALL tests in the system
    console.log('\n===== ALL TESTS IN FIRESTORE =====');
    const testsSnap = await db.collection('tests').get();
    console.log(`Total tests: ${testsSnap.size}`);
    testsSnap.docs.forEach(doc => {
      const d = doc.data();
      console.log(`  [${doc.id}] title="${d.title}" | course="${d.course}" | status="${d.status}" | instituteId="${d.instituteId || 'NONE'}"`);
    });

    // 2. Get ALL courses in the system
    console.log('\n===== ALL COURSES IN FIRESTORE =====');
    const coursesSnap = await db.collection('courses').get();
    console.log(`Total courses: ${coursesSnap.size}`);
    coursesSnap.docs.forEach(doc => {
      const d = doc.data();
      console.log(`  [${doc.id}] name="${d.name}" | instituteId="${d.instituteId || 'NONE'}"`);
    });

    // 3. Get ALL enrollments
    console.log('\n===== ALL ENROLLMENTS IN FIRESTORE =====');
    const enrollSnap = await db.collection('enrollments').get();
    console.log(`Total enrollments: ${enrollSnap.size}`);
    enrollSnap.docs.forEach(doc => {
      const d = doc.data();
      console.log(`  [${doc.id}] studentId="${d.studentId}" | courseId="${d.courseId}" | status="${d.status}" | instituteId="${d.instituteId || 'NONE'}"`);
    });

    // 4. Get all student users to find our student
    console.log('\n===== STUDENT USERS =====');
    const usersSnap = await db.collection('users').where('role', '==', 'student').get();
    console.log(`Total students: ${usersSnap.size}`);
    usersSnap.docs.forEach(doc => {
      const d = doc.data();
      console.log(`  [${doc.id}] name="${d.name}" | courseId="${d.courseId || 'NONE'}" | instituteId="${d.instituteId || 'NONE'}"`);
    });

    // 5. Now simulate the student test query for each student
    console.log('\n===== SIMULATING STUDENT TEST QUERY =====');
    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const userData = userDoc.data();
      console.log(`\n--- Student: ${userData.name} (${uid}) ---`);

      // Step A: Get enrollments
      const enrollmentsSnapshot = await db.collection('enrollments')
        .where('studentId', '==', uid)
        .get();
      let courseIds = enrollmentsSnapshot.docs.map(doc => doc.data().courseId);
      console.log(`  Enrolled courseIds: [${courseIds.join(', ')}]`);

      // Legacy fallback
      if (courseIds.length === 0) {
        const legacyCourseId = userData.courseId;
        if (legacyCourseId) {
          courseIds.push(legacyCourseId);
          console.log(`  Legacy fallback courseId: ${legacyCourseId}`);
        }
      }

      if (courseIds.length === 0) {
        console.log(`  ❌ No courseIds found - student would see 0 tests!`);
        continue;
      }

      // Step B: Fetch course names
      const coursePromises = courseIds.map(id => db.collection('courses').doc(id).get());
      const courseDocs = await Promise.all(coursePromises);
      const courseNames = courseDocs.map((doc, idx) => {
        if (doc.exists && doc.data().name) return doc.data().name;
        return null;
      }).filter(Boolean);
      console.log(`  Course names resolved: [${courseNames.join(', ')}]`);

      if (courseNames.length === 0) {
        console.log(`  ❌ No course names resolved - student would see 0 tests!`);
        continue;
      }

      // Step C: Query tests with course IN courseNames
      const studentInstId = userData.instituteId;
      console.log(`  Student instituteId: "${studentInstId || 'NONE'}"`);

      let testQuery = db.collection('tests').where('course', 'in', courseNames);
      if (studentInstId) {
        testQuery = testQuery.where('instituteId', '==', studentInstId);
      }

      const testSnap = await testQuery.get();
      console.log(`  Tests matching query: ${testSnap.size}`);
      testSnap.docs.forEach(doc => {
        const d = doc.data();
        console.log(`    ✅ [${doc.id}] "${d.title}" | course="${d.course}" | instId="${d.instituteId || 'NONE'}"`);
      });

      // Step D: Check for mismatches
      if (testSnap.size === 0) {
        console.log(`  ⚠️ INVESTIGATING MISMATCH:`);
        // Check tests without instituteId filter
        const testNoFilter = await db.collection('tests').where('course', 'in', courseNames).get();
        console.log(`    Tests matching course names (NO institute filter): ${testNoFilter.size}`);
        testNoFilter.docs.forEach(doc => {
          const d = doc.data();
          console.log(`      [${doc.id}] "${d.title}" | course="${d.course}" | instId="${d.instituteId || 'NONE'}"`);
        });

        // Check if course field in tests matches exactly
        const allTestsCourseValues = testsSnap.docs.map(d => d.data().course);
        console.log(`    All test course values in DB: [${[...new Set(allTestsCourseValues)].join(' | ')}]`);
        console.log(`    Student's course names: [${courseNames.join(' | ')}]`);
      }
    }

    console.log('\n✅ Debug complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Debug Error:', err);
    process.exit(1);
  }
}

debugTests();
