const { db } = require('./config/firebase');

async function run() {
  try {
    const resultsSnapshot = await db.collection('test_results').get();
    console.log("Total test results:", resultsSnapshot.size);
    resultsSnapshot.forEach(doc => {
      const data = doc.data();
      console.log(`Result ID: ${doc.id} | StudentId: ${data.studentId} | TestId: ${data.testId} | Score: ${data.score} | TotalMarks: ${data.totalMarks}`);
    });

    const testsSnapshot = await db.collection('tests').get();
    console.log("\nTotal tests in DB:", testsSnapshot.size);
    testsSnapshot.forEach(doc => {
      const data = doc.data();
      console.log(`Test ID: ${doc.id} | Title: ${data.title} | TotalMarks: ${data.totalMarks}`);
    });
  } catch (err) {
    console.error("Error reading test results:", err);
  }
}
run();
