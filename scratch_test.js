const { db } = require('./config/firebase');

async function restoreCourses() {
  const coursesToRestore = [
    { id: 'OpkuOM4Yrv1ok8FSCTnY', name: 'CCC (Course of computer concepts)', instituteId: 'I0RK5xGDtdIaKFmwcJzE', status: 'active', duration: '3 months', fees: '3000' },
    { id: 'Z6Y453FdcneP2WRc4kqe', name: 'CCC (Course of computer concepts)', instituteId: 'Z76V9T5GBO3OIog3ak3A', status: 'active', duration: '3 months', fees: '3000' },
    { id: 'NybP5qxXEuGI5yar2HKZ', name: 'CCC (Course of computer concepts)', instituteId: 'I0RK5xGDtdIaKFmwcJzE', status: 'active', duration: '3 months', fees: '3000' },
    { id: 'eqs5V9lVJyUSE68UAUc7', name: 'CCC (Course of computer concepts)', instituteId: 'ZvwLH8NqVntdCzIBtQmh', status: 'active', duration: '3 months', fees: '3000' },
    { id: '96YlDdgTtcyKA5Erz39d', name: 'CCC (Course of computer concepts)', instituteId: 'I0RK5xGDtdIaKFmwcJzE', status: 'active', duration: '3 months', fees: '3000' }
  ];

  try {
    console.log("=== RESTORING COURSES ===");
    for (const c of coursesToRestore) {
      const docRef = db.collection('courses').doc(c.id);
      const doc = await docRef.get();
      if (!doc.exists) {
        console.log(`Creating missing course: ID=${c.id}, Name="${c.name}", InstituteId="${c.instituteId}"`);
        await docRef.set({
          name: c.name,
          instituteId: c.instituteId,
          status: c.status,
          duration: c.duration,
          fees: c.fees,
          students: 0,
          createdAt: new Date()
        });
      } else {
        console.log(`Course already exists: ID=${c.id}`);
      }
    }
    console.log("=== RESTORE COMPLETE ===");
  } catch (err) {
    console.error("Error restoring courses:", err);
  }
}

restoreCourses();
