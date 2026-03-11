const axios = require('axios');

/**
 * Provider to send emails via Google Apps Script (GAS).
 */
const gasProvider = {
  /**
   * Send an email using GAS
   * @param {Object} options
   * @param {string} options.to - Recipient email
   * @param {string} options.subject - Email subject
   * @param {string} options.html - HTML content
   * @returns {Promise<boolean>}
   */
  send: async ({ to, subject, html }) => {
    const gasUrl = process.env.GAS_URL;
    if (!gasUrl || gasUrl === "your_google_apps_script_web_app_url_here") {
      console.warn('[GAS_PROVIDER] GAS_URL not configured. Mocking email send.');
      return true;
    }

    try {
      await axios.post(gasUrl, {
        action: 'SEND_EMAIL_HTML', // Updated action to handle HTML
        email: to,
        subject,
        html
      });
      return true;
    } catch (error) {
      console.error('[GAS_PROVIDER] Failed to send email:', error.message);
      throw error;
    }
  }
};

module.exports = gasProvider;
