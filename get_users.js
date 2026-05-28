const { db } = require('./config/firebase');
const jwt = require('jsonwebtoken');

async function run() {
  try {
    const usersSnapshot = await db.collection('users').get();
    console.log("Total users found:", usersSnapshot.size);
    usersSnapshot.forEach(doc => {
      const data = doc.data();
      console.log(`UID: ${doc.id} | Name: ${data.name} | Role: ${data.role} | Status: ${data.status} | InstituteId: ${data.instituteId}`);
      if (data.role === 'student' || data.name?.includes('Sanjay')) {
        const token = jwt.sign({ uid: doc.id, role: data.role, instituteId: data.instituteId }, 'secret', { expiresIn: '7d' });
        console.log("Token:", token);
        console.log("User object for localStorage:", JSON.stringify(data));
      }
    });
  } catch (err) {
    console.error("Error reading users:", err);
  }
}
run();
