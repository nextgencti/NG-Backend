const emailLayout = require('./layout');

/**
 * Institute Approval Email Template
 * @param {string} name - The admin's name
 * @param {string} instituteName - The institute's name
 * @returns {string} - Rendered HTML
 */
const instituteApprovalTemplate = (name, instituteName, tempPin) => {
  const content = `
    <h2 style="color: #1e293b; margin-bottom: 20px; font-size: 24px;">Welcome to NextGen Network!</h2>
    <p>Hi ${name || 'there'},</p>
    <p>Congratulations! Your registration request for <strong>${instituteName}</strong> has been <strong>approved</strong> by our Super Admin.</p>
    
    <p>An administrative account has been created for you. Use the following credentials to access your dashboard:</p>

    <div style="background-color: #f8fafc; padding: 25px; border-radius: 12px; margin: 30px 0; border: 1px solid #e2e8f0; text-align: center;">
        <p style="margin-top: 0; color: #64748b; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Your Temporary 4-Digit PIN</p>
        <h3 style="margin: 10px 0; color: #4f46e5; font-size: 36px; letter-spacing: 0.2em;">${tempPin}</h3>
        <p style="margin-bottom: 0; color: #94a3b8; font-size: 12px;">(You will be asked to change this PIN after your first login)</p>
    </div>
    
    <p>You can now log in using your registered email and this temporary PIN.</p>
    
    <div style="background-color: #f0fdf4; padding: 25px; border-radius: 12px; margin: 30px 0; border: 1px solid #bbf7d0;">
        <h3 style="margin-top: 0; color: #16a34a; font-size: 18px;">Getting Started</h3>
        <ul style="margin-bottom: 0; padding-left: 20px; color: #4b5563;">
            <li>Login with your email and PIN</li>
            <li>Setup your institute profile</li>
            <li>Add courses and departments</li>
            <li>Onboard your staff and students</li>
        </ul>
    </div>


    <div style="text-align: center;">
        <a href="https://ngcti.in/login" class="button">Log in to Admin Panel</a>
    </div>

    <p style="margin-top: 40px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
        We are excited to have you on board!<br>
        <strong style="color: #4f46e5;">The NextGen Team</strong>
    </p>
  `;
  return emailLayout('Institute Approved - NextGen', content);
};

module.exports = instituteApprovalTemplate;
