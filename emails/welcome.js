const emailLayout = require('./layout');

/**
 * Welcome Email Template
 * Updated for NextGen Computer Training Institute Muskara
 * @param {string} name - The user's name
 * @returns {string} - Rendered HTML
 */
const welcomeTemplate = (name) => {
  const content = `
    <h2 style="color: #1e293b; margin-bottom: 20px; font-size: 24px;">Welcome to NextGen!</h2>
    <p>Hi ${name || 'there'},</p>
    <p>We're thrilled to have you join <strong>NextGen Computer Training Institute Muskara</strong>. We are committed to providing you with the best technical education and support.</p>
    
    <div style="background-color: #f8fafc; padding: 25px; border-radius: 12px; margin: 30px 0; border: 1px solid #e2e8f0;">
        <h3 style="margin-top: 0; color: #4f46e5; font-size: 18px;">What's Next?</h3>
        <ul style="padding-left: 20px; margin-bottom: 0;">
            <li style="margin-bottom: 10px;">Login to your student portal to access course materials.</li>
            <li style="margin-bottom: 10px;">Complete your profile details.</li>
            <li>Explore our latest certification programs.</li>
        </ul>
    </div>

    <div style="text-align: center;">
        <a href="https://ngcti.in" class="button">Visit Your Dashboard</a>
    </div>

    <p style="margin-top: 40px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
        Happy Learning!<br>
        <strong style="color: #4f46e5;">The NextGen Team</strong>
    </p>
  `;
  return emailLayout('Welcome to NextGen', content);
};

module.exports = welcomeTemplate;
