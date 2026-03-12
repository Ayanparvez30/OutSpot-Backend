// utils/challengeVerification.js
const crypto = require('crypto');
const OpenAI = require('openai');
const { DateTime } = require('luxon');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Per-challenge verification hints ----------
// Each entry: { hint, strict? }
// strict=true means the image must CLEARLY show the required content — no benefit of the doubt.
const VERIFICATION_HINTS = {
  'Morning Meals':    { hint: 'Must clearly show actual food or a meal — a plate, bowl, or identifiable breakfast items. Blurry, dark, or empty photos fail.', strict: true },
  'Green Spot':       { hint: 'Must clearly show a real plant, tree, leaf, flower, or outdoor greenery. A dark or unidentifiable photo fails.', strict: true },
  'Hydration Check':  { hint: 'Must clearly show a water bottle, glass of water, or drinking container with visible liquid. An empty counter or dark photo fails.', strict: true },
  'Study Time':       { hint: 'Must clearly show a desk, laptop, open book, or study/work setup. A blank or irrelevant background fails.', strict: true },
  'Steps Count':      { hint: 'Must clearly show an outdoor or indoor walking path, feet in motion, or a step-counter screen. A static dark photo fails.', strict: true },
  'Book Break':       { hint: 'Must clearly show an open book, readable page, e-reader, or book cover. A dark or unclear photo fails.', strict: true },
  'Clean Space':      { hint: 'Must clearly show a TIDIED room, desk, shelf, or living area. The space must be visibly organized and clean — not empty, not dark, not a blank screen. A black image, completely dark photo, screenshot, or photo that does not show a real physical space FAILS immediately.', strict: true },
  'Healthy Snack':    { hint: 'Must clearly show identifiable healthy food — fruit, vegetables, nuts, or yogurt. A dark, blurry, or empty photo fails.', strict: true },
  'Sky Watch':        { hint: 'Must clearly show an outdoor sky — clouds, blue sky, sunset, or sunrise. An indoor or dark photo fails.', strict: true },
  'Water Source':     { hint: 'Must clearly show a water tap, fountain, well, or water filter. A dark or irrelevant photo fails.', strict: true },
  'Handwash Time':    { hint: 'Must clearly show a sink with soap, running water, or hands being washed. A dry counter or dark photo fails.', strict: true },
  'Move 10':          { hint: 'Must clearly show physical activity — exercise equipment, a workout scene, outdoor activity, or someone stretching/moving. A static dark photo fails.', strict: true },
  'Refill & Reuse':   { hint: 'Must clearly show a reusable bottle, mug, or container — ideally being filled or in use. An empty dark photo fails.', strict: true },
  'Community Smile':  { hint: 'Must clearly show a person with a visible smile or happy expression. A dark, blurry, or faceless photo fails.', strict: true },
  'Grateful One':     { hint: 'Must show any real, clearly visible object, person, or scene. A black image, blank screen, or completely dark photo fails.', strict: false },
  // Weekly
  'Walk 5 Days':        { hint: 'Must clearly show an outdoor walking scene, path, trail, or feet walking. A static indoor or dark photo fails.', strict: true },
  'Home Garden':        { hint: 'Must clearly show a plant, garden bed, pot with soil/plant, or gardening activity. A dark or empty photo fails.', strict: true },
  'Reading Streak':     { hint: 'Must clearly show an open book, readable text, e-reader screen, or a reading session. A closed book cover alone is not enough.', strict: true },
  'Water Diary':        { hint: 'Must clearly show water, a water bottle, glass, or hydration tracking (app screen, journal). A dark photo fails.', strict: true },
  'Clean Drive':        { hint: 'Must clearly show active cleaning — trash pickup, wiping surfaces, organizing a space, or a before/after of a tidied area. An untouched or dark space fails.', strict: true },
  'Active Week':        { hint: 'Must clearly show exercise, sports, gym equipment, or physical activity. A static dark photo fails.', strict: true },
  'Healthy Kitchen':    { hint: 'Must clearly show healthy food being prepared, a meal, or a kitchen with visible healthy ingredients. A dark or empty kitchen fails.', strict: true },
  'Explore Nature':     { hint: 'Must clearly show outdoor scenery — a park, trail, forest, beach, or natural environment with visible natural elements. An indoor or dark photo fails.', strict: true },
  'Skill Practice':     { hint: 'Must clearly show someone actively practicing a skill, craft, instrument, or hobby. A photo of unrelated objects fails.', strict: true },
  'Mindful Week':       { hint: 'Must clearly show a calm scene — someone meditating, a journal with writing, a peaceful outdoor scene, or a mindfulness activity. A dark or blank photo fails.', strict: true },
  'Neighborhood Water': { hint: 'Must clearly show a real water source — a tap, well, fountain, or water point in a neighborhood or outdoor setting. A dark or unclear photo fails.', strict: true },
  'Waste Less':         { hint: 'Must clearly show a recycling bin, reusable container, composting activity, or visible waste-reduction effort. A dark or empty photo fails.', strict: true },
  'Community Care':     { hint: 'Must clearly show a person helping others, volunteering, or an identifiable act of kindness. A dark or unrelated photo fails.', strict: true },
  'Early Riser':        { hint: 'Must clearly show an early morning scene — sunrise, morning sky, or morning activity before 10 AM. A dark nighttime or indoor photo fails.', strict: true },
  'Local Food':         { hint: 'Must clearly show local cuisine, seasonal produce, or locally sourced food items. A dark or unidentifiable photo fails.', strict: true },
};

// ---------- Time-sensitive challenges ----------
const TIME_CONSTRAINTS = {
  'Morning Meals': { beforeHour: 14, label: 'before 2 PM' },   // lenient
  'Early Riser':   { beforeHour: 10, label: 'before 10 AM' },
};

// ---------- Pre-flight: reject obviously invalid images ----------
function isImageLikelyBlankOrDark(imageBuffer) {
  // Only reject completely empty or clearly corrupted uploads (< 1 KB).
  // Flutter often compresses images aggressively — real photos can be as small as
  // a few KB, so a 5 KB threshold was incorrectly rejecting legitimate submissions.
  // Actual blank/dark/solid-color images are caught by the AI vision check.
  const sizeKB = imageBuffer.length / 1024;
  return sizeKB < 1;
}

// ---------- AI Vision Verification ----------
async function verifySubmissionImage(imageBuffer, title, description) {
  // Step 1: Fast local check — reject tiny/blank images before hitting the AI
  if (isImageLikelyBlankOrDark(imageBuffer)) {
    return {
      status: 'FAILED',
      reason: 'Image appears to be blank, black, or too small to be a real photo. Please take a clear photo.',
    };
  }

  try {
    const base64 = imageBuffer.toString('base64');
    const mimeType = 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const hintData = VERIFICATION_HINTS[title];
    const hint = hintData ? hintData.hint : '';
    const isStrict = hintData ? hintData.strict : true;
    const hintLine = hint ? `\nRequired content: ${hint}` : '';
    const strictLine = isStrict
      ? '\n- Be STRICT. This challenge requires clear, unambiguous visual evidence.'
      : '\n- Apply reasonable judgment — the content must be real and recognizable.';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are a strict photo verification system for a wellness challenge app. Your job is to REJECT fraudulent, irrelevant, or low-effort submissions.

Challenge: "${title}"
Description: "${description}"${hintLine}

Evaluate the submitted photo against these rules:

AUTOMATIC FAIL — reject immediately if ANY of these are true:
- The image is black, blank, a solid color, or nearly entirely dark
- The image is a screenshot of a phone screen, another app, or gallery
- The image is a stock photo (has watermarks or is too perfect/professional)
- The image shows something completely unrelated to the challenge
- The image is too blurry or obscured to identify any relevant content
- The image is a photo of a photo or a screen displaying a photo${strictLine}

PASS only if:
- The image clearly and unambiguously shows the required content
- The content is real, photographed in the moment (not a screenshot or stock image)
- A reasonable person would agree this photo genuinely satisfies the challenge

Respond with JSON only: {"pass": true or false, "reason": "brief 1-sentence explanation of your decision"}`,
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'auto' },
            },
          ],
        },
      ],
    }, { timeout: 12000 });

    const text = response.choices?.[0]?.message?.content?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Cannot parse response — fail safe: reject rather than accept
      console.warn('[VERIFY] Could not parse AI response, defaulting to FAIL:', text);
      return { status: 'FAILED', reason: 'Could not verify your photo. Please submit a clear, relevant photo.' };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.pass === true || parsed.pass === 'true') {
      return { status: 'PASSED', reason: null };
    }
    return { status: 'FAILED', reason: parsed.reason || 'Photo does not match this challenge.' };
  } catch (err) {
    console.error('[VERIFY] AI verification error:', err.message);
    // Fail safe on error — do NOT silently pass unverified submissions
    return { status: 'FAILED', reason: 'Photo verification failed. Please try again with a clear, relevant photo.' };
  }
}

// ---------- Time Constraint Check ----------
function checkTimeConstraints(challengeTitle, zone) {
  const constraint = TIME_CONSTRAINTS[challengeTitle];
  if (!constraint) return { pass: true, reason: null };

  const now = DateTime.now().setZone(zone);
  const currentHour = now.hour;

  if (currentHour >= constraint.beforeHour) {
    return {
      pass: false,
      reason: `"${challengeTitle}" must be submitted ${constraint.label} in your local time. Current time: ${now.toFormat('h:mm a')}.`,
    };
  }
  return { pass: true, reason: null };
}

// ---------- Duplicate Image Check ----------
async function checkDuplicateImage(imageBuffer, userId) {
  const hash = crypto.createHash('sha256').update(imageBuffer).digest('hex');

  const existing = await prisma.submission.findFirst({
    where: { userId, imageHash: hash },
    select: { id: true, createdAt: true },
  });

  if (existing) {
    return {
      pass: false,
      reason: 'This exact image was already submitted before. Please take a new photo.',
      hash,
    };
  }
  return { pass: true, reason: null, hash };
}

module.exports = {
  verifySubmissionImage,
  checkTimeConstraints,
  checkDuplicateImage,
};
