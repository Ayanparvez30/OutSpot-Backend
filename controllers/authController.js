const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');
const { hashPassword, comparePassword, randomKey, generateOTP } = require('../utils/helper');
const { verifyFirebaseIdToken } = require('../utils/firebaseVerify');
const response = require('../functions/response');
require('dotenv').config();
const nodemailer = require('nodemailer');
exports.signup = async (req, res) => {
  try {
    const { email, phone, username, password, repeatPassword, countryCode, firebaseIdToken } = req.body;

    if (!username || !password || !repeatPassword) {
      return response.response_with_code(res, 400, 'Username, password and repeatPassword are required.');
    }
    if (password !== repeatPassword) {
      return response.response_with_code(res, 400, 'Passwords do not match.');
    }

    const hashedPassword = hashPassword(password);
    const authToken = randomKey(40);
    const fullPhone = phone ? `${countryCode || ''}${phone}` : null;

    // 1) Check username
    const usernameUser = await prisma.user.findUnique({ where: { username } });

    if (usernameUser) {
      if (usernameUser.isVerified) {
        return response.response_with_code(res, 409, 'Username already exists.');
      }

      // Username exists but not verified → reconcile identifiers
      if (email && usernameUser.email && usernameUser.email !== email) {
        return response.response_with_code(res, 409, 'Email belongs to a different user.');
      }
      if (fullPhone && usernameUser.phone && usernameUser.phone !== fullPhone) {
        return response.response_with_code(res, 409, 'Phone number belongs to a different user.');
      }

      // 👉 If client provided Firebase token, verify & mark verified (phone flow)
      if (firebaseIdToken) {
        try {
          const decoded = await verifyFirebaseIdToken(firebaseIdToken);
          const firebaseUid = decoded.uid;
          const phoneFromToken = decoded.phone_number; // E.164 format

          if (!phoneFromToken && !fullPhone) {
            return response.response_with_code(res, 400, 'No phone number found. Provide phone or use Firebase phone auth.');
          }

          const updated = await prisma.user.update({
            where: { username },
            data: {
              email: email || usernameUser.email || null,
              phone: phoneFromToken || fullPhone || usernameUser.phone || null,
              password: hashedPassword,
              isVerified: true,
              otp: null,
              otpExpiresAt: null,
              authorization: authToken,
              firebaseUid
            }
          });

          return response.true_status(res, {
            isNewUser: false,
            token: updated.authorization,
            user: {
              id: updated.id,
              username: updated.username,
              email: updated.email || null,
              phone: updated.phone || null,
              isVerified: true
            }
          }, 'Signup completed via Firebase phone auth.');
        } catch (err) {
          console.error('Firebase verify failed:', err);
          return response.response_with_code(res, 401, 'Invalid Firebase ID token');
        }
      }

      // 👉 No Firebase token: if email exists on record or provided, resend Email OTP (email flow)
      if (email || usernameUser.email) {
        const toEmail = email || usernameUser.email;
        const otp = generateOTP();
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await prisma.user.update({
          where: { username },
          data: { otp, otpExpiresAt, email: toEmail }
        });

        const html = `
          <h1>Verification OTP</h1>
          <p>Your OTP is: <strong>${otp}</strong></p>
          <p>This OTP expires in 10 minutes.</p>
        `;
        await sendEmail(toEmail, 'Your OTP for Verification', html);

        return response.true_status(res, {
          isNewUser: false,
          user: {
            id: usernameUser.id,
            username: usernameUser.username,
            email: toEmail,
            phone: usernameUser.phone || null,
            isVerified: false
          }
        }, 'Username exists but not verified. Email OTP resent.');
      }

      // 👉 No Firebase token and no email path → ask client to use Firebase phone auth
      return response.response_with_code(res, 400, 'Phone signup requires Firebase ID token. Please verify on client and resend firebaseIdToken.');
    }

    // 2) Check email if provided (email flow unchanged)
    if (email) {
      const emailUser = await prisma.user.findUnique({ where: { email } });
      if (emailUser) {
        if (emailUser.isVerified) {
          return response.response_with_code(res, 409, 'Email already registered and verified.');
        }
        if (username && emailUser.username !== username) {
          return response.response_with_code(res, 409, 'Email belongs to a different user.');
        }

        const otp = generateOTP();
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
        await prisma.user.update({
          where: { email },
          data: { otp, otpExpiresAt }
        });

        const html = `
          <h1>Email Verification</h1>
          <p>Your OTP is: <strong>${otp}</strong></p>
          <p>This OTP expires in 10 minutes.</p>
        `;
        await sendEmail(email, 'Your OTP for Email Verification', html);

        return response.true_status(res, {
          isNewUser: false,
          user: { id: emailUser.id, email, isVerified: false }
        }, 'Email exists but not verified. OTP resent.');
      }
    }

    // 3) Check phone if provided (PHONE = Firebase only)
    if (fullPhone) {
      const phoneUser = await prisma.user.findUnique({ where: { phone: fullPhone } });
      if (phoneUser) {
        if (phoneUser.isVerified) {
          return response.response_with_code(res, 409, 'Phone number already registered and verified.');
        }
        if (username && phoneUser.username !== username) {
          return response.response_with_code(res, 409, 'Phone number belongs to a different user.');
        }

        // Require firebaseIdToken for phone path
        if (!firebaseIdToken) {
          return response.response_with_code(res, 400, 'Phone signup requires Firebase ID token. Please verify on client and resend firebaseIdToken.');
        }

        try {
          const decoded = await verifyFirebaseIdToken(firebaseIdToken);
          const firebaseUid = decoded.uid;
          const phoneFromToken = decoded.phone_number;

          if (phoneFromToken && phoneFromToken !== fullPhone) {
            // Normalize to token’s phone to avoid mismatch
            // Optional: enforce exact match if you want strictness
          }

          const updated = await prisma.user.update({
            where: { phone: fullPhone },
            data: {
              email: email || phoneUser.email || null,
              password: hashedPassword,
              isVerified: true,
              otp: null,
              otpExpiresAt: null,
              authorization: authToken,
              firebaseUid
            }
          });

          return response.true_status(res, {
            isNewUser: false,
            token: updated.authorization,
            user: {
              id: updated.id,
              phone: updated.phone,
              username: updated.username,
              email: updated.email || null,
              isVerified: true
            }
          }, 'Phone user verified via Firebase phone auth.');
        } catch (err) {
          console.error('Firebase verify failed:', err);
          return response.response_with_code(res, 401, 'Invalid Firebase ID token');
        }
      }
    }

    // 4) Create new user
    // - If firebaseIdToken present → phone-based verified create
    // - Else if email provided → email OTP create
    // - Else error (phone without firebase token not allowed)

    if (firebaseIdToken) {
      // Prefer phone from token; fallback to provided phone
      try {
        const decoded = await verifyFirebaseIdToken(firebaseIdToken);
        const firebaseUid = decoded.uid;
        const phoneFromToken = decoded.phone_number;

        if (!phoneFromToken && !fullPhone) {
          return response.response_with_code(res, 400, 'No phone_number in Firebase token. Provide phone or use Firebase phone auth properly.');
        }

        const user = await prisma.user.create({
          data: {
            email: email || null,
            phone: phoneFromToken || fullPhone || null,
            username,
            password: hashedPassword,
            isVerified: true,
            otp: null,
            otpExpiresAt: null,
            authorization: authToken,
            firebaseUid
          }
        });

        return response.true_status(res, {
          isNewUser: true,
          token: user.authorization,
          user: {
            id: user.id,
            email: user.email || null,
            phone: user.phone || null,
            username: user.username,
            isVerified: true
          }
        }, 'Signup successful via Firebase phone auth.');
      } catch (err) {
        console.error('Firebase verify failed:', err);
        return response.response_with_code(res, 401, 'Invalid Firebase ID token');
      }
    }

    if (email) {
      // Email OTP path (unchanged)
      const otp = generateOTP();
      const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

      const user = await prisma.user.create({
        data: {
          email,
          username,
          password: hashedPassword,
          otp,
          otpExpiresAt,
          isVerified: false,
          authorization: authToken
        }
      });

      const html = `
        <h1>Email Verification</h1>
        <p>Your OTP is: <strong>${otp}</strong></p>
        <p>This OTP will expire in 10 minutes.</p>
      `;
      await sendEmail(email, 'Verify Your Email', html);

      return response.true_status(res, {
        isNewUser: true,
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone || null,
          username: user.username,
          isVerified: false
        }
      }, 'Signup successful! OTP sent to email.');
    }

    // Neither Firebase phone token nor email provided → can’t continue
    return response.response_with_code(res, 400, 'Provide firebaseIdToken for phone signup or email for email OTP signup.');

  } catch (error) {
    console.error('Signup error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};
exports.verifyOtp = async (req, res) => {
  try {
    let { email, phone, otp, firebaseIdToken } = req.body;

    // 👉 PHONE: Firebase path (no server OTP)
    if (firebaseIdToken) {
      try {
        const decoded = await verifyFirebaseIdToken(firebaseIdToken);
        const firebaseUid = decoded.uid;
        const phoneFromToken = decoded.phone_number;

        // Pick identifier priority: email > body phone > token phone
        const identifier = email
          ? { email }
          : (phone ? { phone } : (phoneFromToken ? { phone: phoneFromToken } : null));

        if (!identifier) {
          return response.response_with_code(res, 400, 'Email or phone required with Firebase token');
        }

        const user = await prisma.user.findFirst({ where: identifier });
        if (!user) return response.response_with_code(res, 404, 'User not found');

        const token = randomKey(40);
        const updatedUser = await prisma.user.update({
          where: { id: user.id },
          data: {
            isVerified: true,
            otp: null,
            otpExpiresAt: null,
            authorization: token,
            firebaseUid
          }
        });

        return response.true_status(res, {
          token,
          user: {
            id: updatedUser.id,
            email: updatedUser.email || null,
            phone: updatedUser.phone || null,
            isVerified: true
          }
        }, 'Verified via Firebase phone auth');
      } catch (err) {
        console.error('Firebase verify failed:', err);
        return response.response_with_code(res, 401, 'Invalid Firebase ID token');
      }
    }

    // 👉 EMAIL: OTP path (unchanged)
    if (!otp || (!email && !phone)) {
      return response.response_with_code(res, 400, 'OTP and either email or phone are required');
    }
    otp = otp.toString();

    const identifier = email ? { email } : { phone };
    const user = await prisma.user.findFirst({
      where: { ...identifier, otp }
    });

    if (!user) {
      return response.response_with_code(res, 400, 'Invalid OTP or identifier');
    }

    if (new Date() > user.otpExpiresAt) {
      return response.response_with_code(res, 400, 'OTP has expired');
    }

    const token = randomKey(40);
    const updatedUser = await prisma.user.update({
      where: identifier,
      data: {
        isVerified: true,
        otp: null,
        otpExpiresAt: null,
        authorization: token
      },
    });

    return response.true_status(res, {
      token,
      user: {
        id: updatedUser.id,
        email: updatedUser.email || null,
        phone: updatedUser.phone || null,
        isVerified: updatedUser.isVerified
      }
    }, 'OTP verified successfully!');
  } catch (error) {
    console.error('OTP verification error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};

exports.resendOtp = async (req, res) => {
  try {
    const { email, phone } = req.body;

    if (!email && !phone) {
      return response.response_with_code(res, 400, 'Email or phone is required');
    }

    const identifier = email ? { email } : { phone };

    const user = await prisma.user.findFirst({
      where: identifier
    });

    if (!user) {
      return response.response_with_code(res, 404, 'User not found');
    }

    if (user.isVerified) {
      return response.response_with_code(res, 400, 'User is already verified');
    }

    const newOtp = generateOTP(); // e.g., return Math.floor(100000 + Math.random() * 900000).toString();
    const newOtpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

    await prisma.user.update({
      where: { id: user.id },
      data: {
        otp: newOtp,
        otpExpiresAt: newOtpExpiry
      }
    });

    if (email) {
      // Send OTP to email
      const html = `
        <h1>Resend OTP</h1>
        <p>Your new OTP is: <strong>${newOtp}</strong></p>
        <p>This OTP will expire in 10 minutes.</p>
      `;
      await sendEmail(email, 'Your new OTP for verification', html);
    } else if (phone) {
      // Send OTP via SMS using Twilio
      await sendSms(phone, `Your OTP is: ${newOtp}. It will expire in 10 minutes.`);
    }

    return response.true_status(res, null, 'A new OTP has been sent');
  } catch (error) {
    console.error('Resend OTP error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};
exports.login = async (req, res) => {
  try {
    const { identifier, password, forceLogin } = req.body;

    if (!identifier || !password) {
      return response.response_with_code(res, 400, 'Identifier and password required');
    }

    // Find user by email, phone or username
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { phone: identifier },
          { username: identifier },
        ],
      },
    });

    if (!user) {
      return response.response_with_code(res, 401, 'User not found, please sign up first');
    }

    // Check password
    const passwordMatch = comparePassword(password, user.password);
    if (!passwordMatch) {
      return response.response_with_code(res, 401, 'Invalid credentials');
    }

    // Check if user is verified
    if (!user.isVerified) {
      return response.response_with_code(res, 403, 'User not verified');
    }

   // Check active session token
if (user.authorization && !forceLogin) {
  return response.response_with_code(res, 409, 'Another device is logged in. Force login?');
}

// Generate new auth token
const newToken = randomKey(40);

// Update user with new token (this will invalidate previous session)
await prisma.user.update({
  where: { id: user.id },
  data: { authorization: newToken },
});


    return response.true_status(res, {
      token: newToken,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        username: user.username,
      },
    }, 'Login successful');

  } catch (error) {
    console.error('Login error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};
exports.forgotPasswordRequest = async (req, res) => {
  try {
    const { email, phone, countryCode } = req.body;

    if (!email && !phone) {
      return response.response_with_code(res, 400, 'Email or phone is required');
    }

    let user;

    if (email) {
      user = await prisma.user.findUnique({ where: { email } });
    } else if (phone) {
      const fullPhone = `${countryCode}${phone}`;
      user = await prisma.user.findUnique({ where: { phone: fullPhone } });
    }

    if (!user) {
      return response.response_with_code(res, 404, 'User not found');
    }

    // Generate OTP and expiry time
    const otp = phone ? '123456' : generateOTP(); // fixed for phone
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    // Save OTP and expiry
    await prisma.user.update({
      where: { id: user.id },
      data: { otp, otpExpiresAt }
    });

    // Send OTP
    if (user.email) {
      const html = `
        <h1>Password Reset OTP</h1>
        <p>Your OTP is: <strong>${otp}</strong></p>
        <p>This OTP will expire in 10 minutes.</p>
      `;
      await sendEmail(user.email, 'Your OTP for Password Reset', html);
    } else if (user.phone) {
      console.log(`OTP for phone ${user.phone}: ${otp}`);
    }

    return response.true_status(res, null, 'OTP sent successfully');
  } catch (error) {
    console.error('Forgot password request error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};
exports.verifyForgotPasswordOtp = async (req, res) => {
  try {
    const { email, phone, otp } = req.body;

    if (!otp || (!email && !phone)) {
      return response.response_with_code(res, 400, 'OTP and email or phone are required');
    }

    const identifier = email ? { email } : { phone };

    const user = await prisma.user.findFirst({
      where: {
        ...identifier,
        otp
      }
    });

    if (!user) {
      return response.response_with_code(res, 400, 'Invalid OTP or identifier');
    }

    if (new Date() > user.otpExpiresAt) {
      return response.response_with_code(res, 400, 'OTP has expired');
    }

    // OTP verified successfully
    return response.true_status(res, null, 'OTP verified successfully');
  } catch (error) {
    console.error('Verify forgot password OTP error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};
exports.resetPassword = async (req, res) => {
  try {
    const { email, phone, password, repeatPassword } = req.body;

    if (!password || !repeatPassword || (!email && !phone)) {
      return response.response_with_code(res, 400, 'Password, repeatPassword and email or phone are required');
    }

    if (password !== repeatPassword) {
      return response.response_with_code(res, 400, 'Passwords do not match');
    }

    const identifier = email ? { email } : { phone };

    const user = await prisma.user.findUnique({
      where: identifier
    });

    if (!user) {
      return response.response_with_code(res, 404, 'User not found');
    }

    // Update password and clear otp
    const hashedPassword = hashPassword(password);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        otp: null,
        otpExpiresAt: null
      }
    });

    return response.true_status(res, null, 'Password reset successfully');
  } catch (error) {
    console.error('Reset password error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};
//Simplified version of verifyOtpAndResetPassword
exports.verifyOtpAndResetPassword = async (req, res) => {
  try {
    const { email, phone, otp, password, repeatPassword } = req.body;

    if (!otp || !password || !repeatPassword || (!email && !phone)) {
      return response.response_with_code(res, 400, 'OTP, new password, repeat password, and email/phone are required');
    }

    if (password !== repeatPassword) {
      return response.response_with_code(res, 400, 'Passwords do not match');
    }

    const identifier = email ? { email } : { phone };

    const user = await prisma.user.findFirst({
      where: {
        ...identifier,
        otp
      }
    });

    if (!user) {
      return response.response_with_code(res, 400, 'Invalid OTP or identifier');
    }

    if (new Date() > user.otpExpiresAt) {
      return response.response_with_code(res, 400, 'OTP has expired');
    }

    const hashedPassword = hashPassword(password);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        otp: null,
        otpExpiresAt: null
      }
    });

    return response.true_status(res, null, 'Password reset successfully');
  } catch (error) {
    console.error('verifyOtpAndResetPassword error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};

exports.logout = async (req, res) => {
  try {
    const userId = req.authData.id;

    await prisma.user.update({
      where: { id: userId },
      data: { authorization: "" }
    });

    return response.true_status(res, {}, 'Logged out successfully');
  } catch (error) {
    console.error('Logout error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};
exports.updateUsername = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { username } = req.body;

    if (!username) {
      return response.response_with_code(res, 400, 'Username is required');
    }

    // Check if the username is already taken by another user
    const existingUser = await prisma.user.findUnique({
      where: { username }
    });

    if (existingUser && existingUser.id !== userId) {
      return response.response_with_code(res, 409, 'Username is already taken');
    }

    await prisma.user.update({
      where: { id: userId },
      data: { username }
    });

    return response.true_status(res, null, 'Username updated successfully');
  } catch (error) {
    console.error('Update username error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};
exports.updatePassword = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { currentPassword, newPassword, repeatPassword } = req.body;

    if (!currentPassword || !newPassword || !repeatPassword) {
      return response.response_with_code(res, 400, 'All password fields are required');
    }

    if (newPassword !== repeatPassword) {
      return response.response_with_code(res, 400, 'New passwords do not match');
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user || !comparePassword(currentPassword, user.password)) {
      return response.response_with_code(res, 400, 'Current password is incorrect');
    }

    const hashedPassword = hashPassword(newPassword);

    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword }
    });

    return response.true_status(res, null, 'Password updated successfully');
  } catch (error) {
    console.error('Update password error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};

exports.contactUs = async (req, res) => {
  const { email, subject, description } = req.body;

  if (!email || !subject || !description) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    const mailOptions = {
      from: email,
      to: process.env.CONTACT_RECEIVER_EMAIL || 'ishra101789@gmail.com',
      subject: `Contact Us - ${subject}`,
      html: `
        <p><strong>From:</strong> ${email}</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <p><strong>Description:</strong><br/>${description}</p>
      `,
    };

    await transporter.sendMail(mailOptions);

    return res.status(200).json({ message: 'Message sent successfully!' });
  } catch (error) {
    console.error('Contact Us Email Error:', error);
    return res.status(500).json({ error: 'Failed to send your message. Please try again later.' });
  }
};

exports.updateFcmToken = async (req, res) => {
  const { fcmToken } = req.body;
  const userId = req.authData.id;

  if (!fcmToken) return res.status(400).json({ error: "FCM token required" });

  await prisma.user.update({
    where: { id: userId },
    data: { fcmToken }
  });

  res.json({ message: "Token updated" });
};
