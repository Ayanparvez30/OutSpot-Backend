// utils/emailTemplates.js

const BRAND_COLOR = '#7B51F3';   // appBackground (main purple)
const DARK_BG = '#1C011F';      // PrimaryColor (dark background)
const CARD_BG = '#2D0731';      // fillcolor (card/container background)
const TEXT_COLOR = '#F4F4F4';    // tex (primary text - light since dark theme)
const MUTED_COLOR = '#95A4A7';  // grey (muted/secondary text)


function baseLayout(content) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Outspot</title>
</head>
<body style="margin:0;padding:0;background-color:${DARK_BG};font-family:'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${DARK_BG};padding:40px 20px;">
    <tr>
      <td align="center">
        <!-- Logo / Brand -->
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;">
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <span style="font-size:28px;font-weight:700;color:${BRAND_COLOR};letter-spacing:1px;">OUTSPOT</span>
            </td>
          </tr>
          <!-- Card -->
          <tr>
            <td>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${CARD_BG};border-radius:12px;overflow:hidden;">
                <tr>
                  <td style="background:linear-gradient(135deg,${BRAND_COLOR},#FF8F5E);height:6px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
                <tr>
                  <td style="padding:36px 32px;">
                    ${content}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0;font-size:12px;color:${MUTED_COLOR};line-height:1.6;">
                &copy; ${new Date().getFullYear()} Outspot. All rights reserved.<br/>
                You received this email because you have an account with Outspot.<br/>
                Please do not reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function otpBlock(code) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td align="center">
          <div style="display:inline-block;background-color:#FFF5F0;border:2px dashed ${BRAND_COLOR};border-radius:10px;padding:16px 40px;">
            <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:${BRAND_COLOR};font-family:'Courier New',monospace;">${code}</span>
          </div>
        </td>
      </tr>
    </table>
    <p style="margin:0;text-align:center;font-size:13px;color:${MUTED_COLOR};">
      This code expires in <strong style="color:${TEXT_COLOR};">10 minutes</strong>. Do not share it with anyone.
    </p>`;
}

/**
 * Verification OTP — sent during signup or when re-verifying email
 */
function verificationOtp(otp) {
  return baseLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;color:${TEXT_COLOR};text-align:center;">Verify Your Email</h1>
    <p style="margin:0 0 4px;text-align:center;font-size:14px;color:${MUTED_COLOR};">
      Welcome to Outspot! Use the code below to complete your signup.
    </p>
    ${otpBlock(otp)}
  `);
}

/**
 * Resend OTP — when user requests a new code
 */
function resendOtp(otp) {
  return baseLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;color:${TEXT_COLOR};text-align:center;">New Verification Code</h1>
    <p style="margin:0 0 4px;text-align:center;font-size:14px;color:${MUTED_COLOR};">
      You requested a new verification code. Use the code below to verify your account.
    </p>
    ${otpBlock(otp)}
  `);
}

/**
 * Password reset OTP
 */
function passwordResetOtp(otp) {
  return baseLayout(`
    <h1 style="margin:0 0 8px;font-size:22px;color:${TEXT_COLOR};text-align:center;">Reset Your Password</h1>
    <p style="margin:0 0 4px;text-align:center;font-size:14px;color:${MUTED_COLOR};">
      We received a request to reset your password. Use the code below to proceed.
    </p>
    ${otpBlock(otp)}
    <p style="margin:16px 0 0;text-align:center;font-size:13px;color:${MUTED_COLOR};">
      If you didn't request this, you can safely ignore this email.
    </p>
  `);
}

module.exports = {
  verificationOtp,
  resendOtp,
  passwordResetOtp,
};
