const twilio = require('twilio');
require('dotenv').config();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Send OTP SMS
 * @param {string} toPhone - recipient phone number in +880 format
 * @param {string} message - OTP message
 */
const sendSms = async (toPhone, message) => {
  try {
    const result = await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: toPhone
    });

    console.log(`SMS sent to ${toPhone}: SID ${result.sid}`);
    return result;
  } catch (error) {
    console.error('Twilio SMS Error:', error);
    throw error;
  }
};

module.exports = sendSms;
