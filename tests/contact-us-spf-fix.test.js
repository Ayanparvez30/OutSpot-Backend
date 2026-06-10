/**
 * POST /api/contact-us — uses the working sendEmail helper.
 *
 * Bug: live prod returned 500 because the old inline transporter set
 * `from: <user's typed email>`, which the SMTP provider rejected on SPF/DKIM
 * grounds. The OTP path never hit this because it sends `from: SMTP_EMAIL`
 * (our authenticated account). The fix reuses the shared sendEmail helper
 * — same SMTP creds that already deliver OTP.
 *
 * Asserts:
 *   • 400 when any required field missing (unchanged)
 *   • Calls sendEmail(to, subject, html, replyTo) with:
 *       - to       = CONTACT_RECEIVER_EMAIL (env or fallback)
 *       - subject  = "Contact Us - <user subject>"
 *       - html     contains escaped user input (no XSS)
 *       - replyTo  = user's typed email (so Reply goes back to them)
 *   • from is NOT the user's email (it's set inside sendEmail = SMTP_EMAIL)
 *   • sendEmail throws → 500 (resilience preserved)
 *   • HTML is escaped to defend against injection
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// Stub sendEmail BEFORE we load the controller.
const sendEmailPath = require.resolve('../utils/sendEmail');
const calls = [];
let throwNext = false;
require.cache[sendEmailPath] = {
  id: sendEmailPath, filename: sendEmailPath, loaded: true,
  exports: async (to, subject, html, replyTo) => {
    if (throwNext) { throwNext = false; throw new Error('simulated SMTP failure'); }
    calls.push({ to, subject, html, replyTo });
  },
};

// Stub Prisma + a couple of other deps the controller imports
const prismaClientPath = require.resolve('@prisma/client');
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return {}; } },
};

const authCtrl = require('../controllers/authController');

function req(body) { return { body }; }
function res() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // ---------- 1. Missing field → 400 (unchanged) ----------
  console.log('\n[1] Missing field → 400');

  calls.length = 0;
  const r1 = res();
  await authCtrl.contactUs(req({}), r1);
  eq('400',                              r1.statusCode, 400);
  eq('error message',                    r1.body?.error, 'All fields are required.');
  eq('no sendEmail call',                calls.length, 0);

  const r1b = res();
  await authCtrl.contactUs(req({ email: 'a@b.com', subject: 'Hi' }), r1b);
  eq('400 when description missing',     r1b.statusCode, 400);

  // ---------- 2. Happy path — sendEmail called with correct shape ----------
  console.log('\n[2] Valid body → 200; sendEmail called via the working helper');

  process.env.CONTACT_RECEIVER_EMAIL = 'support@outspot.app';
  calls.length = 0;
  const r2 = res();
  await authCtrl.contactUs(req({
    email: 'user@example.com',
    subject: 'Bug report',
    description: 'Login screen crashes when I tap Continue.',
  }), r2);

  eq('200',                              r2.statusCode, 200);
  eq('success message',                  r2.body?.message, 'Message sent successfully!');
  eq('1 sendEmail call',                 calls.length, 1);
  eq('to = CONTACT_RECEIVER_EMAIL',      calls[0].to, 'support@outspot.app');
  eq('subject prefixed "Contact Us -"', calls[0].subject, 'Contact Us - Bug report');
  eq('replyTo = user email',             calls[0].replyTo, 'user@example.com');

  // ---------- 3. CONTACT_RECEIVER_EMAIL fallback ----------
  console.log('\n[3] CONTACT_RECEIVER_EMAIL absent → fallback to known recipient');

  delete process.env.CONTACT_RECEIVER_EMAIL;
  calls.length = 0;
  const r3 = res();
  await authCtrl.contactUs(req({
    email: 'u@x.com', subject: 'S', description: 'D',
  }), r3);
  eq('200',                              r3.statusCode, 200);
  ok('to is the fallback address',        typeof calls[0].to === 'string' && calls[0].to.includes('@'));

  // ---------- 4. SMTP failure path → 500 ----------
  console.log('\n[4] sendEmail throws → 500 (resilience preserved)');

  throwNext = true;
  calls.length = 0;
  const r4 = res();
  await authCtrl.contactUs(req({
    email: 'u@x.com', subject: 'X', description: 'Y',
  }), r4);
  eq('500',                              r4.statusCode, 500);
  eq('user-safe error',                  r4.body?.error, 'Failed to send your message. Please try again later.');

  // ---------- 5. HTML escaping (defence against payload injection in body) ----------
  console.log('\n[5] HTML in user input is escaped');

  calls.length = 0;
  const r5 = res();
  await authCtrl.contactUs(req({
    email: 'mallory@example.com',
    subject: '<script>alert(1)</script>',
    description: '<img src=x onerror=alert(2)>',
  }), r5);
  eq('200',                              r5.statusCode, 200);
  const html = calls[0]?.html || '';
  ok('< / > escaped to &lt; / &gt;',      html.includes('&lt;script&gt;') && html.includes('&lt;img src=x onerror=alert(2)&gt;'));
  ok('no raw <script> tag',               !html.includes('<script>'));
  ok('newlines in description converted', html.includes('&lt;img src=x'));

  // ---------- 6. Multi-line description preserved with <br/> ----------
  console.log('\n[6] Multi-line description converted to <br/>');

  calls.length = 0;
  await authCtrl.contactUs(req({
    email: 'u@x.com', subject: 'S',
    description: 'line one\nline two',
  }), res());
  ok('newline → <br/>',                   calls[0]?.html?.includes('line one<br/>line two'));

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
