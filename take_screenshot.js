const puppeteer = require('puppeteer');
const path = require('path');

const userObj = {
  uid: "eAweLENa7yYW7lzWXYx3ZKBI7Eo2",
  email: "sanjaypqrs360@gmail.com",
  name: "sanjay Rajpoot",
  provider: "google",
  role: "student",
  profileComplete: true,
  address: "Vill + post Makrao",
  phone: "07398500512",
  dob: "2000-01-01",
  instituteId: "I0RK5xGDtdIaKFmwcJzE",
  courseId: "DZ6Nm6dKnlJc182un905",
  status: "active",
  rollNumber: "NG-2026-011"
};

const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiJlQXdlTEVOYTd5WVc3bHpXWFl4M1pLQkk3RW8yIiwicm9sZSI6InN0dWRlbnQiLCJpbnN0aXR1dGVJZCI6IkkwUks1eEdEdGRJYUtGbXdjSnpFIiwiaWF0IjoxNzc5Nzk0NzM3LCJleHAiOjE3ODAzOTk1Mzd9.wC6oSl5D6WJUhKfKtQjJlTsLJGF4y7VnLAzhXDq1Jw4";

async function run() {
  console.log("Launching headless browser...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  
  // Set viewport to mobile screen (375px wide)
  await page.setViewport({ width: 375, height: 812, isMobile: true });

  console.log("Navigating to home page to set local storage...");
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2' });

  // Inject user credentials into LocalStorage
  await page.evaluate((u, t) => {
    localStorage.setItem('user', JSON.stringify(u));
    localStorage.setItem('token', t);
  }, userObj, token);

  console.log("Credentials injected. Navigating to Dashboard Overview...");
  await page.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle2' });

  // Wait a bit for layout rendering/animations
  await new Promise(resolve => setTimeout(resolve, 3000));

  const overviewPath = path.join('C:', 'Users', 'sanja', '.gemini', 'antigravity-ide', 'brain', '51cbefce-401b-42d0-b37a-f7ca82497c33', 'mobile_overview.png');
  console.log(`Taking screenshot: ${overviewPath}`);
  await page.screenshot({ path: overviewPath, fullPage: true });

  console.log("Navigating to Dashboard My Courses...");
  await page.goto('http://localhost:5173/dashboard/courses', { waitUntil: 'networkidle2' });
  await new Promise(resolve => setTimeout(resolve, 3000));

  const coursesPath = path.join('C:', 'Users', 'sanja', '.gemini', 'antigravity-ide', 'brain', '51cbefce-401b-42d0-b37a-f7ca82497c33', 'mobile_my_courses.png');
  console.log(`Taking screenshot: ${coursesPath}`);
  await page.screenshot({ path: coursesPath, fullPage: true });

  await browser.close();
  console.log("Browser closed successfully.");
}

run().catch(err => {
  console.error("Puppeteer script execution failed:", err);
});
