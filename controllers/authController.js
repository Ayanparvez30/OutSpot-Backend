// controllers/authController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const sendEmail = require('../utils/sendEmail');
const emailTemplates = require('../utils/emailTemplates');
const { hashPassword, comparePassword, randomKey, generateOTP } = require('../utils/helper');
const { verifyFirebaseIdToken } = require('../utils/firebaseVerify');
const response = require('../functions/response');
require('dotenv').config();
const nodemailer = require('nodemailer');
const { addPointsWithMultiplier, addPointsDirect } = require('../utils/points');
const REFERRAL_REWARD_POINTS = Number(process.env.REFERRAL_REWARD_POINTS || 50);
function normUsername(u) {
  return u ? String(u).trim().toLowerCase() : null;
}
const jwt = require('jsonwebtoken');
function signPendingSignup(payload) {
  const secret = process.env.PENDING_SIGNUP_JWT_SECRET;
  const ttlMin = Number(process.env.PENDING_SIGNUP_TTL_MIN || 10);
  if (!secret) throw new Error('Missing PENDING_SIGNUP_JWT_SECRET');
  return jwt.sign(payload, secret, { expiresIn: `${ttlMin}m` });
}

function verifyPendingSignup(token) {
  const secret = process.env.PENDING_SIGNUP_JWT_SECRET;
  if (!secret) throw new Error('Missing PENDING_SIGNUP_JWT_SECRET');
  return jwt.verify(token, secret);
}

// ---------- helpers ----------
function normEmail(email) {
  return email ? String(email).trim().toLowerCase() : null;
}
function normPhone(phone, countryCode) {
  if (!phone) return null;
  const cc = countryCode ? String(countryCode).trim() : '';
  const p = String(phone).trim();
  return `${cc}${p}`;
}
function isOnboardingIncomplete(user) {
  const missingProfile =
    !user.firstName || !user.lastName || !user.bodyType || !user.bodyShapeUrl;
  return missingProfile;
}

// award referral when user verified
async function applyReferralOnVerified({ inviterId, inviteeId }, db = prisma) {
  if (!inviterId || !inviteeId) return;
  const ref = await db.referral.findFirst({
    where: { inviterId, inviteeId, status: 'PENDING' }
  });
  if (!ref) return;
await addPointsDirect(inviterId, REFERRAL_REWARD_POINTS, 'REFERRAL_REWARD', inviteeId, db);
  await db.referral.update({
    where: { id: ref.id },
    data: { status: 'REWARDED', rewardedAt: new Date() },
  });
}

// ---------- AUTH: SIGNUP ----------
exports.signup = async (req, res) => {
  try {
    let {
      email,
      phone,
      username,
      password,
      repeatPassword,
      countryCode,
      firebaseIdToken,      // optional for phone fast-path
      referralCode,
    } = req.body;

    if (!username || !password || !repeatPassword) {
      return response.response_with_code(res, 400, 'Username, password and repeatPassword are required.');
    }
    if (password !== repeatPassword) {
      return response.response_with_code(res, 400, 'Passwords do not match.');
    }

    email = normEmail(email);
    const fullPhone = normPhone(phone, countryCode);
    const hashedPassword = hashPassword(password);
    const authToken = randomKey(40);
username = normUsername(username);
const refRaw = normUsername(referralCode ?? req.query?.ref ?? '');

let inviter = null;
if (refRaw) {
inviter = await prisma.user.findFirst({
  where: {
    username: refRaw,     // ✅ no mode
    isVerified: true,
  },
  select: { id: true, username: true, isVerified: true },
});


  // 2) (optional backward compatibility) old referralCode links still work
  if (!inviter) {
    const legacy = await prisma.user
      .findUnique({ where: { referralCode: refRaw }, select: { id: true, username: true, isVerified: true } })
      .catch(() => null);

    if (legacy?.isVerified) inviter = legacy;
  }

  // 3) invalid referral username => block signup (as you requested)
  if (!inviter) {
    return response.response_with_code(res, 400, 'Invalid referral username.');
  }
}

    // ---------- 1) CLEANUP UNVERIFIED ROWS ----------
    // Block on any VERIFIED match. For UNVERIFIED matches, only delete if
    // all identifiers resolve to the SAME row (the user's prior attempt).
    // Different unverified rows from different users -> reject, don't touch.
    const matchedUnverified = new Map(); // id -> matchedBy field

    if (username) {
      const u = await prisma.user.findUnique({ where: { username } });
      if (u) {
        if (u.isVerified) return response.response_with_code(res, 409, 'Username is already in use by another user');
        matchedUnverified.set(u.id, 'username');
      }
    }
    if (email) {
      const u = await prisma.user.findUnique({ where: { email } });
      if (u) {
        if (u.isVerified) return response.response_with_code(res, 409, 'Email is already in use by another user');
        matchedUnverified.set(u.id, (matchedUnverified.get(u.id) || '') + ',email');
      }
    }
    if (fullPhone) {
      const u = await prisma.user.findUnique({ where: { phone: fullPhone } });
      if (u) {
        if (u.isVerified) return response.response_with_code(res, 409, 'Phone number is already in use by another user');
        matchedUnverified.set(u.id, (matchedUnverified.get(u.id) || '') + ',phone');
      }
    }

    if (matchedUnverified.size > 1) {
      // Identifiers point to different unverified users — refuse to delete strangers
      return response.response_with_code(
        res, 409,
        'Some of these identifiers are linked to other pending signups. Please use different ones.'
      );
    }
    if (matchedUnverified.size === 1) {
      const [staleId] = matchedUnverified.keys();
      await prisma.user.delete({ where: { id: staleId } });
    }

    // ---------- 4) FRESH CREATE ----------
    // 4.a) Firebase fast path → verified now
    if (firebaseIdToken && fullPhone) {
      try {
        const decoded = await verifyFirebaseIdToken(firebaseIdToken);
        const firebaseUid = decoded.uid;
        const phoneFromToken = decoded.phone_number || fullPhone;

        const created = await prisma.$transaction(async (tx) => {
          const existing = await tx.user.findUnique({ where: { phone: phoneFromToken } });
          let u;
          if (existing) {
            if (existing.isVerified) {
              throw Object.assign(new Error('Phone number is already in use by another user'), { status: 409 });
            }
            u = await tx.user.update({
              where: { id: existing.id },
              data: {
                email: email || existing.email || null,
                username,
                password: hashedPassword,
                isVerified: true,
                otp: null,
                otpExpiresAt: null,
                authorization: authToken,
                firebaseUid,
                ...(inviter && inviter.id !== existing.id && !existing.referredById
                  ? { referredById: inviter.id }
                  : {}),
              }
            });
          } else {
            u = await tx.user.create({
              data: {
                email: email || null,
                phone: phoneFromToken,
                username,
                password: hashedPassword,
                isVerified: true,
                otp: null,
                otpExpiresAt: null,
                authorization: authToken,
                firebaseUid,
                referredById: inviter ? inviter.id : null,
              }
            });
          }

 

if (inviter && inviter.id !== u.id) {
  const already = await tx.referral.findFirst({ where: { inviteeId: u.id } });
  if (!already) {

    await tx.referral.create({
      data: {
        inviterId: inviter.id,
        inviteeId: u.id,
        status: 'REWARDED',
        rewardedAt: new Date(),
      },
    });

    await addPointsDirect(
      inviter.id,
      REFERRAL_REWARD_POINTS,
      'REFERRAL_REWARD',
      u.id,
      tx
    );
  }
}

          return u;
        });

        return response.true_status(res, {
          isNewUser: true,
          token: created.authorization,
          user: {
            id: created.id,
            email: created.email || null,
            phone: created.phone || null,
            username: created.username,
            isVerified: true
          }
        }, 'Signup successful via Firebase phone auth.');
      } catch (err) {
        const code = err?.status || 500;
        if (code === 409) return response.response_with_code(res, 409, err.message || 'Conflict');
        console.error('Firebase verify failed (optional fast path):', err);
        // fall through to pending
      }
    }
// 4.b) Phone signup pending (NO DB SAVE until verified)
if (fullPhone && !email) {
  // Cleanup already removed unverified rows. Only verified rows remain.
  const pendingSignupToken = signPendingSignup({
    phone: fullPhone,
    username,
    password: hashedPassword,
    referredById: inviter ? inviter.id : null
  });

  return response.true_status(res, {
    isNewUser: true,
    pendingSignupToken,
    user: {
      phone: fullPhone,
      username,
      isVerified: false
    }
  }, 'Phone signup pending. Verify with Firebase in /verify-otp.');
}

    // 4.c) Fresh email signup — NO DB WRITE until OTP verified.
    // Generate OTP, sign into pendingSignupToken, send via email.
    // verifyOtp will validate OTP from token and create the user.
    if (email) {
      const otp = generateOTP();
      const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

      const pendingSignupToken = signPendingSignup({
        email,
        username,
        password: hashedPassword,
        otp,
        otpExpiresAt: otpExpiresAt.toISOString(),
        referredById: inviter ? inviter.id : null,
      });

      try {
        await sendEmail(email, 'Verify Your Email', emailTemplates.verificationOtp(otp));
      } catch (mailErr) {
        console.error('sendEmail failed (fresh signup OTP):', mailErr);
        return response.response_with_code(
          res,
          500,
          'OTP email could not be sent. Please check SMTP config and try again.'
        );
      }

      return response.true_status(res, {
        isNewUser: true,
        pendingSignupToken,
        user: {
          email,
          username,
          phone: null,
          isVerified: false,
        }
      }, 'OTP sent to email. Verify to complete signup.');
    }

    return response.response_with_code(res, 400, 'Provide phone (for pending signup) or email (for email OTP).');
  } catch (error) {
    console.error('Signup error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};

// ---------- AUTH: VERIFY OTP ----------
exports.verifyOtp = async (req, res) => {
  try {
    let { email, phone, otp, firebaseIdToken, countryCode,pendingSignupToken } = req.body;
    email = normEmail(email);
    const fullPhone = normPhone(phone, countryCode);
// A) Firebase verify path
if (firebaseIdToken) {
  try {
    const decoded = await verifyFirebaseIdToken(firebaseIdToken);
    const firebaseUid = decoded.uid;
    const phoneFromToken = decoded.phone_number;

    // determine phone
    const finalPhone = fullPhone || phoneFromToken;

    // try find existing user by email/phone
    const identifier =
      email ? { email } :
      (finalPhone ? { phone: finalPhone } : null);

    if (!identifier) {
      return response.response_with_code(res, 400, 'Email or phone required with Firebase token');
    }

    let user = await prisma.user.findFirst({ where: identifier });

    // ✅ If no user exists, create from pendingSignupToken
    if (!user) {
      if (!pendingSignupToken) {
        return response.response_with_code(res, 400, 'pendingSignupToken required for new phone signup');
      }
let pending;
try {
  pending = verifyPendingSignup(pendingSignupToken);
} catch (e) {
  return response.response_with_code(res, 400, 'Invalid or expired pendingSignupToken');
}

     

      // phone mismatch guard
      if (pending.phone && finalPhone && pending.phone !== finalPhone) {
        return response.response_with_code(res, 400, 'Phone mismatch for pending signup');
      }

      // username unique check again (race-safe)
      const existingUsername = await prisma.user.findUnique({ where: { username: pending.username } });
      if (existingUsername) {
        return response.response_with_code(res, 409, 'Username is already in use by another user');
      }

      // phone unique check again
      const existingPhone = await prisma.user.findUnique({ where: { phone: finalPhone } });
      if (existingPhone?.isVerified) {
        return response.response_with_code(res, 409, 'Phone number is already in use by another user');
      }

      const token = randomKey(40);

      const created = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: {
            email: email || null,
            phone: finalPhone,
            username: pending.username,
            password: pending.password,      // hashed
            isVerified: true,
            otp: null,
            otpExpiresAt: null,
            authorization: token,
            firebaseUid,
            referredById: pending.referredById || null,
          }
        });

        // referral reward (only after verified)
        if (u.referredById) {
          const already = await tx.referral.findFirst({ where: { inviteeId: u.id } });
          if (!already) {
            await tx.referral.create({
              data: { inviterId: u.referredById, inviteeId: u.id, status: 'REWARDED', rewardedAt: new Date() }
            });
            await addPointsDirect(u.referredById, REFERRAL_REWARD_POINTS, 'REFERRAL_REWARD', u.id, tx);
          }
        }

        return u;
      });

      return response.true_status(res, {
        token: created.authorization,
        user: {
          id: created.id,
          email: created.email || null,
          phone: created.phone || null,
          username: created.username,
          isVerified: true
        }
      }, 'Verified via Firebase phone auth');
    }

    // ✅ existing user path (your current logic)
    const token = randomKey(40);

    const updatedUser = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: user.id },
        data: {
          isVerified: true,
          otp: null,
          otpExpiresAt: null,
          authorization: token,
          firebaseUid
        }
      });

      if (u.referredById) {
        await applyReferralOnVerified({ inviterId: u.referredById, inviteeId: u.id }, tx);
      }
      return u;
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

    // B) Email OTP path
    if (!otp || (!email && !fullPhone)) {
      return response.response_with_code(res, 400, 'OTP and either email or phone are required');
    }
    otp = otp.toString();

    // B.1) New email signup via pendingSignupToken — no DB row exists yet
    if (email && pendingSignupToken && !fullPhone) {
      let pending;
      try { pending = verifyPendingSignup(pendingSignupToken); }
      catch (e) {
        return response.response_with_code(res, 400, 'Invalid or expired pendingSignupToken');
      }

      if (!pending.email || pending.email !== email) {
        return response.response_with_code(res, 400, 'Email mismatch for pending signup');
      }
      if (String(pending.otp) !== otp) {
        return response.response_with_code(res, 400, 'Invalid OTP');
      }
      if (pending.otpExpiresAt && new Date() > new Date(pending.otpExpiresAt)) {
        return response.response_with_code(res, 400, 'OTP has expired');
      }

      // race-safe uniqueness check
      const existsEmail = await prisma.user.findUnique({ where: { email } });
      if (existsEmail) {
        return response.response_with_code(res, 409, 'Email is already in use by another user');
      }
      const existsUsername = await prisma.user.findUnique({ where: { username: pending.username } });
      if (existsUsername) {
        return response.response_with_code(res, 409, 'Username is already in use by another user');
      }

      const token = randomKey(40);
      const created = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: {
            email,
            username: pending.username,
            password: pending.password,
            isVerified: true,
            otp: null,
            otpExpiresAt: null,
            authorization: token,
            referredById: pending.referredById || null,
          }
        });

        if (u.referredById) {
          const already = await tx.referral.findFirst({ where: { inviteeId: u.id } });
          if (!already) {
            await tx.referral.create({
              data: { inviterId: u.referredById, inviteeId: u.id, status: 'REWARDED', rewardedAt: new Date() }
            });
            await addPointsDirect(u.referredById, REFERRAL_REWARD_POINTS, 'REFERRAL_REWARD', u.id, tx);
          }
        }
        return u;
      });

      return response.true_status(res, {
        token,
        user: {
          id: created.id,
          email: created.email,
          phone: null,
          username: created.username,
          isVerified: true,
        }
      }, 'Email verified — account created');
    }

    const identifier = email ? { email } : { phone: fullPhone };
    const user = await prisma.user.findFirst({ where: { ...identifier, otp } });

    if (!user) {
      return response.response_with_code(res, 400, 'Invalid OTP or identifier');
    }

    if (user.otpExpiresAt && new Date() > user.otpExpiresAt) {
      return response.response_with_code(res, 400, 'OTP has expired');
    }

    const token = randomKey(40);

    const updatedUser = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: user.id },
        data: {
          isVerified: true,
          otp: null,
          otpExpiresAt: null,
          authorization: token
        },
      });

      if (u.referredById) {
        await applyReferralOnVerified({ inviterId: u.referredById, inviteeId: u.id }, tx);
      }
      return u;
    });

    return response.true_status(res, {
      token,
      user: {
        id: updatedUser.id,
        email: updatedUser.email || null,
        phone: updatedUser.phone || null,
        isVerified: true
      }
    }, 'OTP verified successfully!');
  } catch (error) {
    console.error('OTP verification error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};

// ---------- AUTH: RESEND OTP ----------
exports.resendOtp = async (req, res) => {
  try {
    let { email, phone, countryCode } = req.body;
    email = normEmail(email);
    const fullPhone = normPhone(phone, countryCode);

    if (!email && !fullPhone) {
      return response.response_with_code(res, 400, 'Email or phone is required');
    }

    const identifier = email ? { email } : { phone: fullPhone };
    const user = await prisma.user.findFirst({ where: identifier });

    if (!user) {
      return response.response_with_code(res, 404, 'User not found');
    }
    if (user.isVerified) {
      return response.response_with_code(res, 400, 'User is already verified');
    }

    const newOtp = generateOTP();
    const newOtpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        otp: newOtp,
        otpExpiresAt: newOtpExpiry,
        authorization: null
      }
    });

    if (email) {
      try {
        await sendEmail(email, 'Your New Verification Code', emailTemplates.resendOtp(newOtp));
      } catch (mailErr) {
        console.error('sendEmail failed (resendOtp):', mailErr);
        return response.response_with_code(
          res,
          500,
          'OTP email could not be sent. Please try again later.'
        );
      }
    } else {
      // integrate SMS provider here
      console.log(`OTP for phone ${fullPhone}: ${newOtp}`);
    }

    return response.true_status(res, null, 'A new OTP has been sent');
  } catch (error) {
    console.error('Resend OTP error:', error);
    return response.response_with_code(res, 500, 'Internal server error');
  }
};

// ---------- AUTH: LOGIN (unchanged logic, minor polish) ----------
exports.login = async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return response.response_with_code(res, 400, 'Identifier and password required');
    }

    const idNorm = String(identifier).trim();
    const emailId = idNorm.includes('@') ? normEmail(idNorm) : null;

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: emailId || '__no_email__' },
          { phone: idNorm },
          { username: idNorm },
        ],
      },
    });

    if (!user) {
      return response.response_with_code(res, 401, 'User not found, please sign up first');
    }
    if (!comparePassword(password, user.password)) {
      return response.response_with_code(res, 401, 'Invalid credentials');
    }
    if (!user.isVerified) {
      return response.response_with_code(res, 403, 'User not verified');
    }

    const newToken = randomKey(40);

    await prisma.user.update({
      where: { id: user.id },
      data: { authorization: newToken }
    });

    // onboarding hint preserved
    if (isOnboardingIncomplete(user)) {
      return response.true_status(res, {
        token: newToken,
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          username: user.username,
        },
      }, 'Resumed unfinished onboarding (token rotated).');
    }

    return response.true_status(res, {
      token: newToken,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        username: user.username,
      },
    }, user.authorization ? 'Existing session replaced by new login.' : 'Login successful');
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
      try {
        await sendEmail(user.email, 'Your OTP for Password Reset', emailTemplates.passwordResetOtp(otp));
      } catch (mailErr) {
        console.error('sendEmail failed (forgotPassword):', mailErr);
        return response.response_with_code(
          res,
          500,
          'OTP email could not be sent. Please try again later.'
        );
      }
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
      data: {
        authorization: "",
        fcmToken: null
      }
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
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10),
      secure: false,
      requireTLS: true,
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

  // Check if user previously had no token (logged out / fresh install)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fcmToken: true },
  });
  const wasMissing = !user?.fcmToken;

  await prisma.user.update({
    where: { id: userId },
    data: { fcmToken }
  });

  // If user was logged out (no token), clear old challenge notifications
  // so they don't see a flood of stale push notifications from previous days
  if (wasMissing) {
    await prisma.notification.deleteMany({
      where: {
        userId,
        type: { in: ['DAILY_CHALLENGE', 'WEEKLY_CHALLENGE'] },
        isRead: false,
      },
    });
  }

  res.json({ message: "Token updated" });
};
exports.getMyReferral = async (req, res) => {
  const userId = req.authData.id;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true }
  });

  if (!user) return res.status(404).json({ error: 'User not found' });
const code = (user.username || '').trim();
const ref = encodeURIComponent(code);

const deep = process.env.APP_DEEP_LINK ? `${process.env.APP_DEEP_LINK}?ref=${ref}` : null;
const web  = process.env.APP_SHARE_BASE ? `${process.env.APP_SHARE_BASE}?ref=${ref}` : null;

  res.json({
    referralCode: code,
    shareLinks: { deepLink: deep, webFallback: web },
    message: 'Share this code/link with friends to earn points!'
  });
};
