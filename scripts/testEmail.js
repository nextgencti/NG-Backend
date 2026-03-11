require('dotenv').config();
const emailService = require('../utils/emailService');

const testEmail = async () => {
  const testRecipient = process.argv[2] || 'test@example.com';
  console.log(`--- Testing Email Service ---`);
  console.log(`Provider: ${process.env.EMAIL_PROVIDER || 'GAS (default)'}`);
  console.log(`Recipient: ${testRecipient}`);

  try {
    console.log('\n1. Testing OTP Email...');
    await emailService.sendOTPEmail(testRecipient, '123456');
    console.log('✔ OTP email triggered successfully.');

    console.log('\n2. Testing Welcome Email...');
    await emailService.sendWelcomeEmail(testRecipient, 'Test User');
    console.log('✔ Welcome email triggered successfully.');

    console.log('\n3. Testing Approval Email...');
    await emailService.sendApprovalEmail(testRecipient, 'Test Student');
    console.log('✔ Approval email triggered successfully!');

    console.log('\nAll tests completed.');
  } catch (error) {
    console.error('\n✖ Test failed:', error.message);
  }
};

testEmail();
