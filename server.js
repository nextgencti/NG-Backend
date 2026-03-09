require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Basic Route for Health Check
app.get('/', (req, res) => {
  res.json({ message: 'NextGen API Server is running successfully 🚀' });
});

// Import and Use Routes
const authRoutes = require('./routes/authRoutes');
const studentRoutes = require('./routes/studentRoutes');
const adminRoutes = require('./routes/adminRoutes');
const configRoutes = require('./routes/configRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/config', configRoutes);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// ─── AUTO-LAUNCH CRON ──────────────────────────────────────────────────────────
// Every 60 seconds, check if any 'upcoming' Live test should go live
const { db, admin } = require('./config/firebase');

const autoLaunchTests = async () => {
  try {
    const now = new Date();
    const snapshot = await db.collection('tests')
      .where('status', '==', 'upcoming')
      .where('type', '==', 'Live')
      .get();

    if (snapshot.empty) return;

    const batch = db.batch();
    let launchCount = 0;

    snapshot.forEach(doc => {
      const data = doc.data();
      if (!data.date || !data.time) return;

      // Build the scheduled Date from stored date (yyyy-mm-dd) and time
      // Time may be stored as HH:MM or HH:MM:SS — normalize to HH:MM
      const timeNormalized = data.time.substring(0, 5); // e.g. '22:20'
      const scheduledStr = `${data.date}T${timeNormalized}:00`;
      const scheduled = new Date(scheduledStr);

      if (isNaN(scheduled.getTime())) {
        console.warn(`[AutoLaunch] Invalid date for test "${data.title}": ${scheduledStr}`);
        return;
      }

      if (now >= scheduled) {
        batch.update(doc.ref, {
          status: 'published',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        launchCount++;
        console.log(`[AutoLaunch] Published test "${data.title}" (${doc.id})`);
      }
    });

    if (launchCount > 0) {
      await batch.commit();
      console.log(`[AutoLaunch] ✅ Launched ${launchCount} test(s).`);
    }
  } catch (err) {
    console.error('[AutoLaunch] Error:', err.message);
  }
};

// Run immediately on startup, then every 60 seconds
autoLaunchTests();
setInterval(autoLaunchTests, 60 * 1000);
