const gasProvider = require('./gasProvider');
const resendProvider = require('./resendProvider');

const providers = {
  GAS: gasProvider,
  RESEND: resendProvider,
  // SMTP: smtpProvider (to be added)
};

/**
 * Provider Manager to dynamically select email sender.
 */
const providerManager = {
  getProvider: () => {
    const selected = (process.env.EMAIL_PROVIDER || 'GAS').toUpperCase();
    return providers[selected] || gasProvider;
  }
};

module.exports = providerManager;
