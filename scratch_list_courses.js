const { db } = require('./config/firebase');

async function run() {
  try {
    const coursesSnapshot = await db.collection('courses').get();
    console.log("Total courses found:", coursesSnapshot.size);
    coursesSnapshot.forEach(doc => {
      const data = doc.data();
      console.log(`Course ID: ${doc.id} | Name: ${data.name} | Fees: ${data.fees} | Duration: ${data.duration} | Learners: ${data.students} | InstituteId: ${data.instituteId}`);
    });
  } catch (err) {
    console.error("Error reading courses:", err);
  }
}
run();
