const emailLayout = require('./layout');

/**
 * Reset Password Email Template (Placeholder)
 * Updated for NextGen Computer Training Institute Muskara
 * @param {string} resetLink - The password reset link
 * @returns {string} - Rendered HTML
 */
const resetPasswordTemplate = (resetLink) => {
  const content = `
    <h2 style="color: #1e293b; margin-bottom: 20px; font-size: 22px;">Password Reset Request</h2>
    <p>Hello,</p>
    <p>We received a request to reset your password for the <strong>NextGen Computer Training Institute Muskara</strong> portal. Click the button below to proceed:</p>
    
    <div style="text-align: center; margin: 35px 0;">
        <a href="${resetLink}" class="button">Reset Password</a>
    </div>
    
    <p style="color: #64748b; font-size: 14px;">
        If you didn't request this, you can safely ignore this email. This link will expire in 60 minutes.
    </p>
    
    <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0;">Best regards,</p>
        <p style="margin: 5px 0 0 0; font-weight: 700; color: #4f46e5;">NextGen Security Team</p>
    </div>
  `;
  return emailLayout('Password Reset Request', content);
};

module.exports = resetPasswordTemplate;
