const emailLayout = require('./layout');

/**
 * Institute Rejection Email Template
 * @param {string} name - The admin's name
 * @param {string} instituteName - The institute's name
 * @param {string} reason - The reason for rejection
 * @returns {string} - Rendered HTML
 */
const rejectionTemplate = (name, instituteName, reason) => {
  const content = `
    <h2 style="color: #1e293b; margin-bottom: 20px; font-size: 24px;">Update Regarding Your Registration Request</h2>
    <p>Hi ${name || 'there'},</p>
    <p>Thank you for your interest in joining <strong>NextGen Computer Training Institute Network</strong>.</p>
    
    <p>After carefully reviewing the registration request for <strong>${instituteName}</strong>, we regret to inform you that we are unable to approve your application at this time.</p>
    
    ${reason ? `
    <div style="background-color: #fff1f2; padding: 25px; border-radius: 12px; margin: 30px 0; border: 1px solid #fecdd3;">
        <h3 style="margin-top: 0; color: #e11d48; font-size: 18px;">Reason for Rejection</h3>
        <p style="margin-bottom: 0; color: #4b5563;">${reason}</p>
    </div>
    ` : ''}

    <p style="margin-top: 20px;">If you believe this was an error or would like to provide more information, please feel free to reach out to our support team.</p>

    <p style="margin-top: 40px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
        Best Regards,<br>
        <strong style="color: #4f46e5;">The NextGen Team</strong>
    </p>
  `;
  return emailLayout('Registration Update - NextGen', content);
};

module.exports = rejectionTemplate;
