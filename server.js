require('dotenv').config();
const express = require('express');
const cors = require('cors');
const dns = require('dns');

// Force IPv4 first to avoid Firestore connection issues (ENETUNREACH)
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// Request Logger for Debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

// Basic Route for Health Check
app.get('/', (req, res) => {
  res.json({ message: 'NextGen API Server is running successfully 🚀' });
});

app.get('/api/test-direct', (req, res) => {
  res.json({ success: true, message: 'Direct route is working!' });
});

// Import and Use Routes
console.log('📦 Loading Routes...');
const authRoutes = require('./routes/authRoutes');
const studentRoutes = require('./routes/studentRoutes');
const adminRoutes = require('./routes/adminRoutes');
const superAdminRoutes = require('./routes/superAdminRoutes');
const configRoutes = require('./routes/configRoutes');
const publicRoutes = require('./routes/publicRoutes');

console.log('🛠️ Registering Routes...');
app.use('/api/auth', authRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/superadmin', superAdminRoutes);
app.use('/api/config', configRoutes);
app.use('/api/public', publicRoutes);

app.get('/debug-route', (req, res) => {
  res.json({ success: true, message: 'Debug route without /api works!' });
});

console.log('✅ Routes Registered');

// Global error handler - catches errors from any route
app.use((err, req, res, next) => {
  console.error('GLOBAL ERROR HANDLER caught:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
  res.status(500).json({ success: false, message: 'Global error: ' + (err.message || JSON.stringify(err)) });
});

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
// Trigger nodemon reload to refresh routes
