/**
 * Placeholder for Resend email provider.
 * This can be implemented when an API key is available.
 */
const resendProvider = {
  /**
   * Send an email using Resend
   * @param {Object} options
   * @returns {Promise<boolean>}
   */
  send: async ({ to, subject, html }) => {
    console.log('[RESEND_PROVIDER] Placeholder - Resend API key not configured.');
    console.log(`[RESEND_PROVIDER] To: ${to}, Subject: ${subject}`);
    // implementation would go here:
    // const resend = new Resend(process.env.RESEND_API_KEY);
    // await resend.emails.send({ from: process.env.EMAIL_FROM, to, subject, html });
    return true;
  }
};

module.exports = resendProvider;
