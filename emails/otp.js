const emailLayout = require('./layout');

/**
 * OTP Email Template
 * Updated for NextGen Computer Training Institute Muskara
 * @param {string} otp - The 6-digit OTP
 * @returns {string} - Rendered HTML
 */
const otpTemplate = (otp) => {
  const content = `
    <h2 style="color: #1e293b; margin-bottom: 10px; font-size: 22px;">Verify Your Identity</h2>
    <p>Hello,</p>
    <p>To continue with your session at <strong>NextGen Computer Training Institute Muskara</strong>, please use the following verification code. This code is valid for <strong>5 minutes</strong>.</p>
    
    <div class="otp-box">
        <p class="otp-code">${otp}</p>
    </div>
    
    <p style="color: #64748b; font-size: 14px; margin-top: 20px;">
        If you didn't request this code, please ignore this email or contact our support team immediately.
    </p>
    
    <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0;">Warm regards,</p>
        <p style="margin: 5px 0 0 0; font-weight: 700; color: #4f46e5;">NextGen Support Team</p>
    </div>
  `;
  return emailLayout('Verify Your Identity', content);
};

module.exports = otpTemplate;
