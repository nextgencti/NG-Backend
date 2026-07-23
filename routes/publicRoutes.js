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
          courses: data.courses || [],
          courseIds: data.courseIds || [],
          duration: data.duration,
          totalMarks: data.totalMarks,
          questions: data.questions,
          difficulty: data.difficulty || 'Easy',
          description: data.description || '',
          status: data.status,
          date: data.date || '',
          createdAt: data.createdAt || null
        };
      })
      .sort((a, b) => {
        const getTestTime = (t) => {
          if (t.createdAt) {
            if (t.createdAt._seconds) return t.createdAt._seconds * 1000;
            if (t.createdAt.seconds) return t.createdAt.seconds * 1000;
            return new Date(t.createdAt).getTime();
          }
          return t.date ? new Date(t.date).getTime() : 0;
        };
        return getTestTime(b) - getTestTime(a); // newest first
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

    // Validate test exists
    const testDoc = await db.collection('tests').doc(testId).get();
    if (!testDoc.exists) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }
    const testData = testDoc.data();

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

// 6. Get public statistics/metrics for landing page
router.get('/stats', async (req, res) => {
  try {
    const settingsDoc = await db.collection('settings').doc('web_controls').get();
    
    let showStats = true;
    let dataSource = 'real';
    let dummyData = {
      studentsCount: 14,
      coursesCount: 1,
      successRate: 95,
      certificatesCount: 24
    };

    if (settingsDoc.exists) {
      const data = settingsDoc.data();
      if (data.homepageStats) {
        showStats = data.homepageStats.showStats !== false;
        dataSource = data.homepageStats.dataSource || 'real';
        if (data.homepageStats.dummyData) {
          dummyData = { ...dummyData, ...data.homepageStats.dummyData };
        }
      }
    }

    let stats = {};

    if (dataSource === 'real') {
      const studentsSnapshot = await db.collection('users').where('role', '==', 'student').get();
      const coursesSnapshot = await db.collection('courses').get();
      const resultsSnapshot = await db.collection('test_results').get();
      
      const dbStudents = studentsSnapshot.size;
      const dbCourses = coursesSnapshot.size;
      const dbTestResults = resultsSnapshot.size;

      stats = {
        studentsCount: dbStudents, 
        coursesCount: dbCourses,
        successRate: 95,
        certificatesCount: dbTestResults,
      };
    } else {
      stats = {
        studentsCount: Number(dummyData.studentsCount) || 0,
        coursesCount: Number(dummyData.coursesCount) || 0,
        successRate: Number(dummyData.successRate) || 0,
        certificatesCount: Number(dummyData.certificatesCount) || 0,
      };
    }

    res.status(200).json({ success: true, showStats, stats });
  } catch (error) {
    console.error('Public Stats Fetch Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching stats' });
  }
});

// 7. Get public active courses for landing page
router.get('/courses', async (req, res) => {
  try {
    const snapshot = await db.collection('courses')
      .where('status', '==', 'active')
      .get();

    const courses = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name,
        duration: data.duration,
        fees: data.fees,
        thumbnailUrl: data.thumbnailUrl || null,
        students: data.students || 0,
        status: data.status,
        instituteId: data.instituteId || null
      };
    });

    res.status(200).json({ success: true, courses });
  } catch (error) {
    console.error('Public Courses Fetch Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching courses' });
  }
});

// 8. Get all public government services
router.get('/gov-services', async (req, res) => {
  try {
    const snapshot = await db.collection('gov_services').orderBy('createdAt', 'desc').get();
    const services = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ success: true, services });
  } catch (error) {
    console.error('Public Fetch Gov Services Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching government services' });
  }
});

// 8.5 Get a single public government service detail
router.get('/gov-services/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection('gov_services').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Government service not found' });
    }
    res.status(200).json({ success: true, service: { id: doc.id, ...doc.data() } });
  } catch (error) {
    console.error('Public Fetch Gov Service Detail Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching government service details' });
  }
});

// 9. Get all typing paragraphs
router.get('/typing-paragraphs', async (req, res) => {
  try {
    const snapshot = await db.collection('typing_paragraphs').get();
    const paragraphs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).json({ success: true, paragraphs });
  } catch (error) {
    console.error('Public Fetch Typing Paragraphs Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching typing paragraphs' });
  }
});

// 11. Instant AI Translation Endpoint for Test Questions & Options
router.post('/translate', async (req, res) => {
  try {
    const { question, options, targetLang } = req.body;
    if (!question || !targetLang) {
      return res.status(400).json({ success: false, message: 'Question and targetLang are required' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ success: false, message: 'AI translation key not configured' });
    }

    const axios = require('axios');
    const prompt = `Translate the following multiple-choice question and options into ${targetLang}.
Keep technical computer terminology accurate, simple, and standard for Indian students.
Question text: "${question}"
Options: ${JSON.stringify(options || {})}

You MUST output ONLY a valid JSON object without any backticks, markdown formatting, or preamble:
{
  "question": "translated question text here",
  "options": {
    "A": "translated option A",
    "B": "translated option B",
    "C": "translated option C",
    "D": "translated option D"
  }
}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    let generatedText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let translation = null;
    try {
      translation = JSON.parse(generatedText);
    } catch (parseErr) {
      const match = generatedText.match(/\{[\s\S]*\}/);
      if (match) translation = JSON.parse(match[0]);
    }

    if (translation && translation.question) {
      return res.status(200).json({ success: true, translation });
    }
    return res.status(500).json({ success: false, message: 'Failed to parse translation' });
  } catch (error) {
    console.error('Translation Route Error:', error);
    res.status(500).json({ success: false, message: 'Error translating question' });
  }
});

// 12. Batch AI Translation Endpoint for Background Pre-Caching
router.post('/translate-batch', async (req, res) => {
  try {
    const { questions, targetLang } = req.body;
    if (!Array.isArray(questions) || questions.length === 0 || !targetLang) {
      return res.status(400).json({ success: false, message: 'Questions array and targetLang are required' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ success: false, message: 'AI translation key not configured' });
    }

    const axios = require('axios');

    // Limit batch size to max 10 per request to avoid Gemini output token truncation
    const batchList = questions.slice(0, 10).map((q, idx) => ({
      index: idx,
      id: q.id,
      question: q.question,
      options: q.options
    }));

    const prompt = `Translate the following list of ${batchList.length} multiple-choice questions and options into ${targetLang}.
Keep technical computer terminology accurate, simple, and standard for Indian students.

Questions List:
${JSON.stringify(batchList)}

You MUST output ONLY a valid JSON array of objects without any backticks, markdown formatting, or preamble.
Example JSON output:
[
  {
    "id": "question_id_or_index",
    "question": "translated question text here",
    "options": {
      "A": "translated option A",
      "B": "translated option B",
      "C": "translated option C",
      "D": "translated option D"
    }
  }
]`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    let generatedText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let translations = [];
    try {
      translations = JSON.parse(generatedText);
    } catch (parseErr) {
      const match = generatedText.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (match) translations = JSON.parse(match[0]);
    }

    if (Array.isArray(translations)) {
      return res.status(200).json({ success: true, translations });
    }
    return res.status(500).json({ success: false, message: 'Failed to parse batch translation' });
  } catch (error) {
    console.error('Batch Translation Route Error:', error);
    res.status(500).json({ success: false, message: 'Error in batch translation' });
  }
});

module.exports = router;
