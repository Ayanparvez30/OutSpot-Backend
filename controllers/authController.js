const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');
const { hashPassword, comparePassword, randomKey, generateOTP } = require('../utils/helper');

const response = require('../functions/response');
require('dotenv').config();
const nodemailer = require('nodemailer');exports.signup = async (req, res) => {
  try {
    const { email, phone, username, password, repeatPassword, countryCode } = req.body;

    if (!username || !password || !repeatPassword) {
      return response.response_with_code(res, 400, 'Username, password and repeatPassword are required.');
    }

    if (password !== repeatPassword) {
      return response.response_with_code(res, 400, 'Passwords do not match.');
    }

    // 1. Check username
    const usernameUser = await prisma.user.findUnique({ where: { username } });

    if (usernameUser) {
      if (usernameUser.isVerified) {
        return response.response_with_code(res, 409, 'Username already exists.');
      }
      // Username exists but not verified
      // If email or phone provided, check if they match this user
      if (email && usernameUser.email && usernameUser.email !== email) {
        return response.response_with_code(res, 409, 'Email belongs to a different user.');
      }
      if (phone) {
        const fullPhone = `${countryCode}${phone}`;
        if (usernameUser.phone && usernameUser.phone !== fullPhone) {
          return response.response_with_code(res, 409, 'Phone number belongs to a different user.');
        }
      }

      // resend OTP to this user
      let otp;
      if (usernameUser.phone) {
        otp = "123456";  // fixed OTP for phone
      } else {
        otp = generateOTP(); // email OTP still random
      }
      const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await prisma.user.update({
        where: { username },
        data: { otp, otpExpiresAt }
      });

      if (usernameUser.email) {
        const html = `
          <h1>Verification OTP</h1>
          <p>Your OTP is: <strong>${otp}</strong></p>
          <p>This OTP expires in 10 minutes.</p>
        `;
        await sendEmail(usernameUser.email, 'Your OTP for Verification', html);
      } else if (usernameUser.phone) {
        // For now, no SMS sending or console log
      }

      return response.true_status(res, {
        isNewUser: false,
        user: {
          id: usernameUser.id,
          username: usernameUser.username,
          email: usernameUser.email || null,
          phone: usernameUser.phone || null,
          isVerified: false
        }
      }, 'Username exists but not verified. OTP resent.');
    }

    // 2. Check email if provided
    if (email) {
      const emailUser = await prisma.user.findUnique({ where: { email } });
      if (emailUser) {
        if (emailUser.isVerified) {
          return response.response_with_code(res, 409, 'Email already registered and verified.');
        }
        // If username provided, check if same user
        if (username && emailUser.username !== username) {
          return response.response_with_code(res, 409, 'Email belongs to a different user.');
        }

        // resend OTP
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
          user: {
            id: emailUser.id,
            email,
            isVerified: false
          }
        }, 'Email exists but not verified. OTP resent.');
      }
    }

    // 3. Check phone if provided
    if (phone) {
      const fullPhone = `${countryCode}${phone}`;
      const phoneUser = await prisma.user.findUnique({ where: { phone: fullPhone } });
      if (phoneUser) {
        if (phoneUser.isVerified) {
          return response.response_with_code(res, 409, 'Phone number already registered and verified.');
        }
        // If username provided, check if same user
        if (username && phoneUser.username !== username) {
          return response.response_with_code(res, 409, 'Phone number belongs to a different user.');
        }

        // resend OTP with fixed value
        const otp = "123456";
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
        await prisma.user.update({
          where: { phone: fullPhone },
          data: { otp, otpExpiresAt }
        });

        // no SMS or console log here

        return response.true_status(res, {
          isNewUser: false,
          user: {
            id: phoneUser.id,
            phone: fullPhone,
            isVerified: false
          }
        }, 'Phone number exists but not verified. OTP resent.');
      }
    }

    // 4. Create new user
    const hashedPassword = hashPassword(password);
    let otp;
    if (phone) {
      otp = "123456";  // fixed OTP for phone signup
    } else {
      otp = generateOTP(); // email OTP random
    }
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const authToken = randomKey(40);

    let user;

    if (email) {
      user = await prisma.user.create({
        data: {
          email,
          username,
          password: hashedPassword,
          otp,
          otpExpiresAt,
          isVerified: false,
          authorization: authToken,
        }
      });

      const html = `
        <h1>Email Verification</h1>
        <p>Your OTP is: <strong>${otp}</strong></p>
        <p>This OTP will expire in 10 minutes.</p>
      `;
      await sendEmail(email, 'Verify Your Email', html);

    } else if (phone) {
      const fullPhone = `${countryCode}${phone}`;
      user = await prisma.user.create({
        data: {
          phone: fullPhone,
          username,
          password: hashedPassword,
          otp,
          otpExpiresAt,
          isVerified: false,
          authorization: authToken,
        }
      });

      // No SMS or console.log here for now
    }

    return response.true_status(res, {
      isNewUser: true,
      user: {
        id: user.id,
        email: user.email || null,
        phone: user.phone || null,
        username: user.username,
        isVerified: false
      }
    }, 'Signup successful! OTP sent.');

  } catch (error) {
    console.error('Signup error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    let { email, phone, otp } = req.body;

    if (!otp || (!email && !phone)) {
      return response.response_with_code(res, 400, 'OTP and either email or phone are required');
    }

    otp = otp.toString();

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
    const { email, phone, password, countryCode } = req.body;

    if ((!email && !phone) || !password) {
      return response.response_with_code(res, 400, 'Email or phone and password are required.');
    }

    let user;

    if (email) {
      user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return response.response_with_code(res, 404, 'User with this email not found.');
      }
    } else if (phone) {
      const fullPhone = `${countryCode}${phone}`;
      user = await prisma.user.findUnique({ where: { phone: fullPhone } });
      if (!user) {
        return response.response_with_code(res, 404, 'User with this phone number not found.');
      }
    }

    if (!user.isVerified) {
      return response.response_with_code(res, 403, 'User is not verified. Please verify first.');
    }

    const isMatch = await comparePassword(password, user.password);
    if (!isMatch) {
      return response.response_with_code(res, 401, 'Incorrect password.');
    }

    // Generate new authorization token, similar to OTP verification
    const authToken = randomKey(40);
    await prisma.user.update({
      where: { id: user.id },
      data: { authorization: authToken }
    });

    return response.true_status(res, {
      token: authToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email || null,
        phone: user.phone || null,
        isVerified: user.isVerified
      }
    }, 'Login successful.');

  } catch (error) {
    console.error('Login error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};
