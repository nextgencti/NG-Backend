const express = require('express');
const { admin, db } = require('../config/firebase');
const router = express.Router();

console.log('🚀 [PublicRoutes] Module loaded and initialized');

// ─── PUBLIC TEST ROUTES ────────────────────────────────────────────────────────
// These routes are accessible WITHOUT authentication.
// Data is stored separately from internal student records.

// 1. Get all published tests that are marked as "public"
router.get('/tests', async (req, res) => {
  try {
    // Fetch all public tests and then filter by status in JS to handle case-sensitivity issues
    const snapshot = await db.collection('tests')
      .where('isPublic', '==', true)
      .get();

    console.log(`🔍 [PublicTests] Total public tests in DB: ${snapshot.size}`);

    console.log(`🔍 [PublicTests] Total public tests in DB: ${snapshot.size}`);

    const tests = snapshot.docs
      .map(doc => {
        const data = doc.data();
        console.log(`   - Test found: "${data.title}", Status: "${data.status}", isPublic: ${data.isPublic}`);
        return {
          id: doc.id,
          title: data.title,
          course: data.course,
          duration: data.duration,
          totalMarks: data.totalMarks,
          questions: data.questions,
          difficulty: data.difficulty || 'Easy',
          description: data.description || '',
          status: data.status // Adding status for debug
        };
      });

    console.log(`✅ [PublicTests] Returning ${tests.length} public tests to frontend`);
    res.status(200).json({ success: true, tests });
  } catch (error) {
    console.error('Public Tests Fetch Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching public tests' });
  }
});

// 2. Get questions for a specific public test (WITHOUT correct answers)
router.get('/tests/:testId', async (req, res) => {
  try {
    const { testId } = req.params;

    const testDoc = await db.collection('tests').doc(testId).get();
    if (!testDoc.exists) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }

    const testData = testDoc.data();
    if (!testData.isPublic || testData.status !== 'published') {
      return res.status(403).json({ success: false, message: 'This test is not publicly available' });
    }

    // Get questions WITHOUT correctAnswer field
    const qSnapshot = await db.collection('tests').doc(testId).collection('questions').get();
    const questions = qSnapshot.docs.map(doc => {
      const qData = doc.data();
      return {
        id: doc.id,
        question: qData.question,
        options: qData.options,
        marks: qData.marks,
        // NOTE: correctAnswer is intentionally excluded for security
      };
    });

    // Shuffle questions
    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questions[i], questions[j]] = [questions[j], questions[i]];
    }

    res.status(200).json({
      success: true,
      test: {
        id: testDoc.id,
        title: testData.title,
        course: testData.course,
        duration: testData.duration,
        totalMarks: testData.totalMarks,
      },
      questions
    });
  } catch (error) {
    console.error('Public Test Detail Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching test details' });
  }
});

// 3. Submit a public test
router.post('/tests/:testId/submit', async (req, res) => {
  try {
    const { testId } = req.params;
    const { answers, participant } = req.body;

    // Validate participant info
    if (!participant || !participant.name || !participant.contact) {
      return res.status(400).json({ success: false, message: 'Participant name and contact are required' });
    }

    // Validate test exists and is public
    const testDoc = await db.collection('tests').doc(testId).get();
    if (!testDoc.exists) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }
    const testData = testDoc.data();
    if (!testData.isPublic) {
      return res.status(403).json({ success: false, message: 'This test is not publicly available' });
    }

    // Fetch questions with correct answers for grading
    const qSnapshot = await db.collection('tests').doc(testId).collection('questions').get();
    const questionsMap = {};
    qSnapshot.docs.forEach(doc => {
      questionsMap[doc.id] = doc.data();
    });

    // Grade the test
    let score = 0;
    let totalMarks = 0;
    const detailedReport = [];

    Object.entries(questionsMap).forEach(([qId, qData]) => {
      const studentAnswer = answers?.[qId] || null;
      const isCorrect = studentAnswer === qData.correctAnswer;
      if (isCorrect) score += (qData.marks || 1);
      totalMarks += (qData.marks || 1);

      detailedReport.push({
        questionId: qId,
        question: qData.question,
        options: qData.options,
        correctAnswer: qData.correctAnswer,
        studentAnswer: studentAnswer,
        isCorrect,
        marks: qData.marks || 1,
      });
    });

    const percentage = totalMarks > 0 ? (score / totalMarks) * 100 : 0;
    let grade = 'F';
    if (percentage >= 90) grade = 'A+';
    else if (percentage >= 80) grade = 'A';
    else if (percentage >= 70) grade = 'B';
    else if (percentage >= 60) grade = 'C';
    else if (percentage >= 50) grade = 'D';

    // Save to a SEPARATE collection: public_test_results
    const resultData = {
      testId,
      testTitle: testData.title,
      participantName: participant.name,
      participantContact: participant.contact,
      score,
      totalMarks,
      percentage: Math.round(percentage * 100) / 100,
      grade,
      detailedReport,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const resultRef = await db.collection('public_test_results').add(resultData);

    res.status(200).json({
      success: true,
      result: {
        id: resultRef.id,
        score,
        totalMarks,
        percentage: Math.round(percentage * 100) / 100,
        grade,
        detailedReport,
      }
    });
  } catch (error) {
    console.error('Public Test Submit Error:', error);
    res.status(500).json({ success: false, message: 'Server error submitting test' });
  }
});

// Helper for Auto-Reset Leaderboard
async function checkAutoReset(testId, testData) {
  const duration = testData.leaderboardResetDuration;
  if (!duration || duration === 'never') return;

  const lastReset = testData.lastLeaderboardReset ? testData.lastLeaderboardReset.toDate() : new Date(0);
  const now = new Date();
  let shouldReset = false;

  const diffMs = now - lastReset;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (duration === 'daily' && diffDays >= 1) shouldReset = true;
  if (duration === 'weekly' && diffDays >= 7) shouldReset = true;
  if (duration === 'monthly' && diffDays >= 30) shouldReset = true;

  if (shouldReset) {
    console.log(`♻️ [AutoReset] Resetting leaderboard for test ${testId} (Mode: ${duration})`);
    const snapshot = await db.collection('public_test_results').where('testId', '==', testId).get();
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    await db.collection('tests').doc(testId).update({
      lastLeaderboardReset: admin.firestore.FieldValue.serverTimestamp()
    });
    return true; // Was reset
  }
  return false;
}

// 4. Get leaderboard for a specific public test
router.get('/tests/:testId/leaderboard', async (req, res) => {
  try {
    const { testId } = req.params;

    // Check for auto-reset first
    const testDoc = await db.collection('tests').doc(testId).get();
    if (testDoc.exists) {
      await checkAutoReset(testId, testDoc.data());
    }

    const snapshot = await db.collection('public_test_results')
      .where('testId', '==', testId)
      .get();

    const results = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.participantName,
        score: data.score,
        totalMarks: data.totalMarks,
        percentage: data.percentage,
        grade: data.grade,
        submittedAt: data.submittedAt ? data.submittedAt.toDate().toISOString() : null,
      };
    });

    // Sort by percentage descending, then by submission time ascending (earliest first for ties)
    results.sort((a, b) => {
      if (b.percentage !== a.percentage) return b.percentage - a.percentage;
      return new Date(a.submittedAt) - new Date(b.submittedAt);
    });

    // Add rank
    results.forEach((r, idx) => { r.rank = idx + 1; });

    res.status(200).json({ success: true, leaderboard: results });
  } catch (error) {
    console.error('Public Leaderboard Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching leaderboard' });
  }
});

// 5. Get global leaderboard across all public tests (top performers)
router.get('/leaderboard', async (req, res) => {
  try {
    const snapshot = await db.collection('public_test_results').get();

    // Aggregate scores per participant name+contact
    const participantMap = {};
    snapshot.docs.forEach(doc => {
      const data = doc.data();
      const key = `${data.participantName}_${data.participantContact}`;
      if (!participantMap[key]) {
        participantMap[key] = {
          name: data.participantName,
          testsAttempted: 0,
          totalScore: 0,
          totalMarks: 0,
        };
      }
      participantMap[key].testsAttempted += 1;
      participantMap[key].totalScore += data.score;
      participantMap[key].totalMarks += data.totalMarks;
    });

    const leaderboard = Object.values(participantMap).map(p => ({
      ...p,
      avgPercentage: p.totalMarks > 0 ? Math.round((p.totalScore / p.totalMarks) * 10000) / 100 : 0,
    }));

    leaderboard.sort((a, b) => b.avgPercentage - a.avgPercentage);
    leaderboard.forEach((r, idx) => { r.rank = idx + 1; });

    res.status(200).json({ success: true, leaderboard: leaderboard.slice(0, 50) });
  } catch (error) {
    console.error('Global Leaderboard Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching leaderboard' });
  }
});

module.exports = router;
