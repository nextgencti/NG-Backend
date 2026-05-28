const dns = require('dns');
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');
require('dotenv').config();
const { db, admin } = require('./config/firebase');

async function fixOrphanedTests() {
  try {
    console.log('\n===== FIXING ORPHANED TESTS (no instituteId) =====\n');

    // Find all tests with no instituteId
    const testsSnap = await db.collection('tests').get();
    
    let fixedCount = 0;
    for (const doc of testsSnap.docs) {
      const test = doc.data();
      
      if (!test.instituteId && test.course) {
        // Find the course by name to determine the correct instituteId
        const courseSnap = await db.collection('courses')
          .where('name', '==', test.course)
          .limit(1)
          .get();
        
        if (!courseSnap.empty) {
          const courseData = courseSnap.docs[0].data();
          if (courseData.instituteId) {
            console.log(`  Fixing: "${test.title}" → instituteId="${courseData.instituteId}" (from course "${test.course}")`);
            await doc.ref.update({ instituteId: courseData.instituteId });
            fixedCount++;
          } else {
            console.log(`  ⚠️ Skipping: "${test.title}" — course "${test.course}" also has no instituteId`);
          }
        } else {
          console.log(`  ⚠️ Skipping: "${test.title}" — no matching course found for "${test.course}"`);
        }
      }
    }

    console.log(`\n✅ Fixed ${fixedCount} orphaned tests.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

fixOrphanedTests();
