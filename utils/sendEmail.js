require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT, 10),
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

// `replyTo` (optional) — set when forwarding a user-typed message (contact-us)
// so the recipient can hit "Reply" and land back at the user, while the `from`
// header stays on our authenticated SMTP account (avoids SPF/DKIM rejection).
const sendEmail = async (to, subject, html, replyTo) => {
  const mailOptions = {
    from: process.env.FROM_MAIL || process.env.SMTP_EMAIL,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  };

  await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;



