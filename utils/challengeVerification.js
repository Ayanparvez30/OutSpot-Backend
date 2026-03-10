// utils/challengeVerification.js
const crypto = require('crypto');
const OpenAI = require('openai');
const { DateTime } = require('luxon');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Per-challenge verification hints ----------
const VERIFICATION_HINTS = {
  'Morning Meals':    'Should show food, breakfast items, a plate of food, or a meal setup',
  'Green Spot':       'Should show a plant, tree, leaf, flower, or greenery',
  'Hydration Check':  'Should show a water bottle, glass of water, or drinking container',
  'Study Time':       'Should show a desk, laptop, books, notebooks, or study/work materials',
  'Steps Count':      'Should show an outdoor path, sidewalk, trail, walking scene, or step counter',
  'Book Break':       'Should show a book cover, open book page, e-reader, or reading material',
  'Clean Space':      'Should show a room, desk, shelf, or living area (before/after tidying)',
  'Healthy Snack':    'Should show fruit, vegetables, nuts, yogurt, or healthy food items',
  'Sky Watch':        'Should show the sky, clouds, sunset, sunrise, or outdoor atmosphere',
  'Water Source':     'Should show a water tap, fountain, well, water filter, or water point',
  'Handwash Time':    'Should show a sink, soap, hand sanitizer, or handwashing setup',
  'Move 10':          'Should show physical activity, exercise, stretching, or movement',
  'Refill & Reuse':   'Should show a reusable bottle, mug, or container being used or refilled',
  'Community Smile':  'Should show a person smiling or a happy candid moment',
  'Grateful One':     'Should show any real object, person, scene, or meaningful item (gratitude is subjective)',
  // Weekly
  'Walk 5 Days':        'Should show an outdoor walking scene, path, trail, or walking activity',
  'Home Garden':        'Should show a plant, garden, pot, or gardening activity',
  'Reading Streak':     'Should show a book, reading material, or reading session',
  'Water Diary':        'Should show water, a water bottle, glass, or hydration activity',
  'Clean Drive':        'Should show cleaning activity, trash pickup, or tidying a space',
  'Active Week':        'Should show exercise, sports, gym, or physical activity',
  'Healthy Kitchen':    'Should show healthy food, cooking, a meal, or kitchen activity',
  'Explore Nature':     'Should show outdoor scenery, nature, park, trail, or natural environment',
  'Skill Practice':     'Should show someone practicing a skill, craft, instrument, or hobby',
  'Mindful Week':       'Should show a calm scene, meditation, journaling, or peaceful moment',
  'Neighborhood Water': 'Should show a water source, tap, well, or water point in the neighborhood',
  'Waste Less':         'Should show recycling, reuse, composting, or waste reduction activity',
  'Community Care':     'Should show helping others, volunteering, or an act of kindness',
  'Early Riser':        'Should show an early morning scene, sunrise, or morning activity',
  'Local Food':         'Should show local cuisine, seasonal produce, or locally sourced food',
};

// ---------- Time-sensitive challenges ----------
const TIME_CONSTRAINTS = {
  'Morning Meals': { beforeHour: 14, label: 'before 2 PM' },   // lenient
  'Early Riser':   { beforeHour: 10, label: 'before 10 AM' },
};

// ---------- AI Vision Verification ----------
async function verifySubmissionImage(imageBuffer, title, description) {
  try {
    const base64 = imageBuffer.toString('base64');
    const mimeType = 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const hint = VERIFICATION_HINTS[title] || '';
    const hintLine = hint ? `\nExpected content: ${hint}` : '';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are a photo verification assistant for a wellness challenge app.

Challenge: "${title}"
Description: "${description}"${hintLine}

The user submitted this photo. Determine if it is a genuine, relevant submission.

Rules:
- Be LENIENT. The photo does not need to be high quality or perfectly framed.
- PASS if the photo reasonably relates to the challenge topic.
- FAIL only if the photo is clearly irrelevant (completely wrong subject, a screenshot of a phone gallery or other app, a solid color/blank image, or a stock photo with watermark).
- When in doubt, PASS. Give the user the benefit of the doubt.

Respond with JSON only: {"pass": true or false, "reason": "brief 1-sentence explanation"}`,
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'low' },
            },
          ],
        },
      ],
    }, { timeout: 8000 });

    const text = response.choices?.[0]?.message?.content?.trim() || '';
    // Extract JSON from response (may be wrapped in ```json ... ```)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[VERIFY] Could not parse AI response, defaulting to PASS:', text);
      return { status: 'PASSED', reason: null };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.pass === true || parsed.pass === 'true') {
      return { status: 'PASSED', reason: null };
    }
    return { status: 'FAILED', reason: parsed.reason || 'Photo does not match this challenge.' };
  } catch (err) {
    console.error('[VERIFY] AI verification error (accepting submission):', err.message);
    return { status: 'SKIPPED', reason: 'Verification temporarily unavailable' };
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
