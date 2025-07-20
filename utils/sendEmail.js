require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

const sendEmail = async (to, subject, html) => {
  const mailOptions = {
    from: process.env.FROM_MAIL || process.env.SMTP_EMAIL,
    to,
    subject,
    html,
  };

  await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;



