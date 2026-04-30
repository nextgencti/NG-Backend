const providerManager = require('./emailProviders');
const otpTemplate = require('../emails/otp');
const welcomeTemplate = require('../emails/welcome');
const resetPasswordTemplate = require('../emails/resetPassword');
const approvalTemplate = require('../emails/approval');
const rejectionTemplate = require('../emails/rejection');
const instituteApprovalTemplate = require('../emails/instituteApproval');


/**
 * Centralized Email Service.
 * Handles template rendering and delivery via the active provider.
 */
const emailService = {
  /**
   * Send OTP Email
   */
  sendOTPEmail: async (email, otp) => {
    const provider = providerManager.getProvider();
    const html = otpTemplate(otp);
    return provider.send({
      to: email,
      subject: 'Security Code - NextGen Computer Training Institute Muskara',
      html
    });
  },

  /**
   * Send Welcome Email
   */
  sendWelcomeEmail: async (email, name) => {
    const provider = providerManager.getProvider();
    const html = welcomeTemplate(name);
    return provider.send({
      to: email,
      subject: 'Welcome to NextGen Computer Training Institute Muskara',
      html
    });
  },

  /**
   * Send Reset Password Email
   */
  sendResetPasswordEmail: async (email, resetLink) => {
    const provider = providerManager.getProvider();
    const html = resetPasswordTemplate(resetLink);
    return provider.send({
      to: email,
      subject: 'Password Reset - NextGen Computer Training Institute Muskara',
      html
    });
  },

  /**
   * Send Approval Email
   */
  sendApprovalEmail: async (email, name) => {
    const provider = providerManager.getProvider();
    const html = approvalTemplate(name);
    return provider.send({
      to: email,
      subject: 'Account Approved - NextGen Computer Training Institute Muskara',
      html
    });
  },

  /**
   * Send Institute Approval Email
   */
  sendInstituteApprovalEmail: async (email, name, instituteName, tempPin) => {
    const provider = providerManager.getProvider();
    const html = instituteApprovalTemplate(name, instituteName, tempPin);
    return provider.send({
      to: email,
      subject: `Registration Approved - ${instituteName}`,
      html
    });
  },


  /**
   * Send Institute Rejection Email
   */
  sendInstituteRejectionEmail: async (email, name, instituteName, reason) => {
    const provider = providerManager.getProvider();
    const html = rejectionTemplate(name, instituteName, reason);
    return provider.send({
      to: email,
      subject: `Registration Update - ${instituteName}`,
      html
    });
  }
};


module.exports = emailService;
