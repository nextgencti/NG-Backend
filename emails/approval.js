const emailLayout = require('./layout');

/**
 * Student Approval Email Template
 * @param {string} name - The user's name
 * @returns {string} - Rendered HTML
 */
const approvalTemplate = (name) => {
  const content = `
    <h2 style="color: #1e293b; margin-bottom: 20px; font-size: 24px;">Congratulations! Your Account is Approved</h2>
    <p>Hi ${name || 'there'},</p>
    <p>Good news! Your account at <strong>NextGen Computer Training Institute Muskara</strong> has been reviewed and successfully <strong>approved</strong> by our administration team.</p>
    
    <p>You can now log in to the portal to access your courses, attend live classes, and manage your student profile.</p>
    
    <div style="background-color: #f0fdf4; padding: 25px; border-radius: 12px; margin: 30px 0; border: 1px solid #bbf7d0;">
        <h3 style="margin-top: 0; color: #16a34a; font-size: 18px;">Account Details</h3>
        <p style="margin-bottom: 0;"><strong>Status:</strong> Active</p>
        <p style="margin-top: 5px; margin-bottom: 0;"><strong>Access:</strong> Full Dashboard Access</p>
    </div>

    <div style="text-align: center;">
        <a href="https://ngcti.in" class="button">Go to Dashboard</a>
    </div>

    <p style="margin-top: 40px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
        We look forward to seeing your progress!<br>
        <strong style="color: #4f46e5;">The NextGen Team</strong>
    </p>
  `;
  return emailLayout('Account Approved - NextGen', content);
};

module.exports = approvalTemplate;
