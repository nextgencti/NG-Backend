const { db } = require('./config/firebase');

async function run() {
  try {
    const collections = ['users', 'courses', 'enrollments', 'tests', 'test_results', 'public_test_results'];
    for (const col of collections) {
      const snap = await db.collection(col).get();
      console.log(`Collection: ${col} | Size: ${snap.size}`);
    }
    
    const studentsSnap = await db.collection('users').where('role', '==', 'student').get();
    console.log(`Collection: users (role=student) | Size: ${studentsSnap.size}`);
  } catch (err) {
    console.error(err);
  }
}
run();
