// controllers/userController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { addPointsWithMultiplier } = require('../utils/points');
const { OpenAI } = require('openai');
const path = require('path');
const multer = require('multer');
const response = require('../functions/response');
const uploadToS3 = require('../utils/s3Upload');

require('dotenv').config();

// ====== Lazy import fetch for CommonJS ======
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// ====== Allowed body types ======
const validBodyTypes = ['masculine', 'feminine'];

/* -------------------------------------------------------------------------- */
/*                               IMAGE UPLOADERS                               */
/* -------------------------------------------------------------------------- */

async function uploadOpenAIImageResult(imageResponse, keyPrefix) {
  const item = imageResponse?.data?.[0];
  if (!item) throw new Error('OpenAI image response empty');

  if (item.url) return await uploadToS3FromUrl(item.url, keyPrefix);

  if (item.b64_json) {
    const buffer = Buffer.from(item.b64_json, 'base64');
    const file = {
      originalname: `${keyPrefix}.png`,
      buffer,
      mimetype: 'image/png',
    };
    return await uploadToS3(file, 'minimes');
  }
  throw new Error('No url or b64_json in OpenAI image response');
}

async function uploadToS3FromUrl(url, keyPrefix) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image from ${url}`);
  const buffer = await res.arrayBuffer();
  const file = {
    originalname: `${keyPrefix}.png`,
    buffer: Buffer.from(buffer),
    mimetype: 'image/png',
  };
  return await uploadToS3(file, 'minimes');
}

// ---- Glasses map (keys → descriptions)
const GLASSES_MAP = {
  none: null,
  'wayfarer-black': 'matte black wayfarer eyeglasses, medium-thick frame',
  'round-gold': 'thin round gold metal eyeglasses',
  'aviator-silver': 'thin silver aviator eyeglasses',
  'rectangle-black': 'rectangular full-rim black eyeglasses, slim frame',
};

// Return:
// - null for none
// - the URL untouched (STRICT reference in the prompt)
// - a known key → description
// - otherwise return the raw text so prompt can still use it
function mapGlasses(glassesKey) {
  if (!glassesKey || glassesKey === 'none') return null;
  if (typeof glassesKey !== 'string') return null;

  // ✅ keep URL as-is
  if (glassesKey.startsWith('http')) return glassesKey;

  // ✅ map known keys, else pass through the raw text
  return GLASSES_MAP[glassesKey] ?? glassesKey;
}

// Outfit normalization (do NOT down-convert URLs to descriptions)
function normalizeOutfit({ shirt, pant, shoes, glasses, lipstick, jewelry, bag }) {
  return {
    shirt: shirt || 'basic solid color t-shirt',
    pant: pant || 'straight jeans',
    shoes: shoes || 'casual sneakers',
    glasses: mapGlasses(glasses),   // 👈 now preserves URLs
    lipstick: lipstick || null,
    jewelry: jewelry || null,
    bag: bag || null,
  };
}

function buildMinimePrompt({ bodyShapeUrl, faceUrl, isFeminine, outfit }) {
  const o = outfit || {};
  const noGlasses = !o.glasses;

  return `
Generate a full-body, front-facing 3D cartoon avatar (clean Pixar-like).

# HARD CONSTRAINTS
- STRICT body shape reference: ${bodyShapeUrl}
- STRICT facial likeness from: ${faceUrl}
- Camera: straight-on, full-body, subject fully contained in frame.
- Keep ~10–12% empty space above the head and below the soles.
- Both feet visible, standing on a flat plane. No cropping anywhere.
- Background: plain white (or transparent if API parameter is given).
- Lighting: soft, even, no harsh shadows.

# OUTFIT (match exactly)
- Shirt/top: ${o.shirt}
- Pants/bottom: ${o.pant}
- Shoes: ${o.shoes}
${noGlasses
    ? `- Glasses: none (REMOVE any eyewear from face reference)`
    : `- Glasses: ${o.glasses} (must be clearly visible and aligned with the eyes)`
}

# ACCESSORIES
- Lipstick: ${o.lipstick}
- Jewelry: ${o.jewelry}
- Bag: ${o.bag}

# URL REFERENCE RULE
- If any outfit/accessory above is an http/https URL, TREAT IT AS A STRICT VISUAL REFERENCE for color, material, pattern/texture, and silhouette. Recreate it closely without logos unless present in the image.

# COMPOSITION & STYLE
- Neutral pose, arms relaxed by sides, single character only.
- Clean edges, smooth materials, vivid but realistic colors.
- Maintain the proportions of the provided body shape; do not exaggerate head size.
- No extra props, text, or background objects.

# NEGATIVE INSTRUCTIONS
${noGlasses ? `- Do NOT include any eyewear or eyewear artifacts.` : ''}
- Do NOT ignore lipstick/jewelry/bag instructions (if "none", show nothing).
- Do NOT crop hair or shoes.
- Do NOT turn the body away; keep front-facing.

Return a single, centered full-body render.
`.trim();
}

/* -------------------------------------------------------------------------- */
/*                                MULTER (local)                               */
/* -------------------------------------------------------------------------- */

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
      return cb(new Error('Only images are allowed'), false);
    }
    cb(null, true);
  }
});

/* -------------------------------------------------------------------------- */
/*                                   OPENAI                                    */
/* -------------------------------------------------------------------------- */

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* -------------------------------------------------------------------------- */
/*                                   HANDLERS                                  */
/* -------------------------------------------------------------------------- */

// PROFILE
async function saveProfile(req, res) {
  try {
    const { firstName, lastName, bio, bodyType, bodyShapeUrl } = req.body;
    const userId = req.authData.id;

    if (!firstName || !lastName || !bodyType || !bodyShapeUrl) {
      return response.response_with_code(res, 400, 'Missing required fields');
    }
    if (!validBodyTypes.includes(bodyType)) {
      return response.response_with_code(res, 400, 'Invalid body type');
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { firstName, lastName, bio, bodyType, bodyShapeUrl }
    });

    return response.true_status(res, updatedUser, 'Profile saved');
  } catch (error) {
    console.error('Profile error:', error);
    return response.response_with_code(res, 500, 'Server error');
  }
}

// AVATAR UPLOAD
async function uploadAvatarWithMulter(req, res) {
  try {
    const userId = req.authData.id;

    if (req.body.premadeUrl) {
      const premadeUrl = req.body.premadeUrl;
      if (!premadeUrl.startsWith('http')) {
        return response.response_with_code(res, 400, 'Invalid premade URL');
      }
      await prisma.minime.deleteMany({ where: { userId } });
      const minime = await prisma.minime.create({
        data: { userId, avatarUrl: premadeUrl, isSaved: false, isDraft: true }
      });
      return response.true_status(res, minime, 'MiniMe uploaded from premade URL');
    }

    const file = req.files?.[0];
    if (!file) return response.response_with_code(res, 400, 'No image uploaded');

    const s3Url = await uploadToS3(file, 'avatars');

    const avatarData = { userId, isSaved: false, isDraft: true };
    if (file.fieldname && file.fieldname.toLowerCase() === 'selfie') {
      avatarData.selfieUrl = s3Url;
    } else {
      avatarData.avatarUrl = s3Url;
    }

    // clean previous unsaved drafts
    await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

    const minime = await prisma.minime.create({ data: avatarData });
    return response.true_status(res, minime, 'MiniMe uploaded to S3');
  } catch (err) {
    console.error('Upload error:', err);
    return response.response_with_code(res, 500, 'Upload failed');
  }
}

// GENERATE MINI-ME
async function generateMinime(req, res) {
  try {
    const userId = req.authData.id;
    const { shirt, pant, shoes, glasses: glassesKey, lipstick, jewelry, bag } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.bodyShapeUrl) {
      return response.response_with_code(res, 400, 'Missing body shape');
    }

    const isFeminine = user.bodyType === 'feminine';
    const lastMini = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    const faceReference = lastMini?.selfieUrl || lastMini?.avatarUrl || user.bodyShapeUrl;
    if (!faceReference) {
      return response.response_with_code(res, 400, 'No face reference available');
    }

    await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

    const outfitForModel = normalizeOutfit({ shirt, pant, shoes, glasses: glassesKey, lipstick, jewelry, bag });

    const prompt = buildMinimePrompt({
      bodyShapeUrl: user.bodyShapeUrl,
      faceUrl: faceReference,
      isFeminine,
      outfit: outfitForModel
    });

    const imageResponse = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      size: '1024x1536', // portrait – avoid head/shoe crop
      background: 'transparent'
    });

    const uploadedImageUrl = await uploadOpenAIImageResult(imageResponse, `minime-${userId}-${Date.now()}`);

    const newMini = await prisma.minime.create({
      data: {
        userId,
        avatarUrl: uploadedImageUrl,
        selfieUrl: lastMini?.selfieUrl || null,
        shirt, pant, shoes, glasses: glassesKey, lipstick, jewelry, bag,
        isSaved: false,
        isDraft: true
      }
    });

    return response.true_status(res, newMini, 'MiniMe draft generated');
  } catch (error) {
    console.error('generateMinime error:', error);
    return response.response_with_code(res, 500, 'Failed to generate MiniMe');
  }
}

// REGENERATE MINI-ME
async function regenerateMinime(req, res) {
  try {
    const userId = req.authData.id;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const lastMini = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    if (!user || !lastMini) {
      return response.response_with_code(res, 404, 'No MiniMe available');
    }

    const isFeminine = user.bodyType === 'feminine';
    const faceReference = lastMini.selfieUrl || lastMini.avatarUrl || user.bodyShapeUrl;

    const outfitForModel = normalizeOutfit({
      shirt: lastMini.shirt,
      pant: lastMini.pant,
      shoes: lastMini.shoes,
      glasses: lastMini.glasses,
      lipstick: lastMini.lipstick,
      jewelry: lastMini.jewelry,
      bag: lastMini.bag
    });

    const expressions = ['natural face', 'slight smile', 'happy look'];
    const base = buildMinimePrompt({
      bodyShapeUrl: user.bodyShapeUrl,
      faceUrl: faceReference,
      isFeminine,
      outfit: outfitForModel
    });
    const prompt = `${base}\n\n# Expression\n- ${expressions[Math.floor(Math.random() * expressions.length)]}`;

    await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

    const imageResponse = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      size: '1024x1536',
      background: 'transparent'
    });

    const uploadedImageUrl = await uploadOpenAIImageResult(imageResponse, `minime-${userId}-${Date.now()}`);

    const newMini = await prisma.minime.create({
      data: {
        userId,
        avatarUrl: uploadedImageUrl,
        selfieUrl: lastMini.selfieUrl || null,
        shirt: lastMini.shirt,
        pant: lastMini.pant,
        shoes: lastMini.shoes,
        glasses: lastMini.glasses,
        lipstick: lastMini.lipstick,
        jewelry: lastMini.jewelry,
        bag: lastMini.bag,
        isSaved: false,
        isDraft: true
      }
    });

    return response.true_status(res, newMini, 'MiniMe regenerated');
  } catch (err) {
    console.error('regenerateMinime error:', err);
    return response.response_with_code(res, 500, 'Regeneration failed');
  }
}

// SAVE/GET MINI-ME
async function saveLatestMinime(req, res) {
  const userId = req.authData.id;
  const draft = await prisma.minime.findFirst({
    where: { userId, isSaved: false, isDraft: true },
    orderBy: { createdAt: 'desc' }
  });

  if (!draft) return response.response_with_code(res, 404, 'No draft to save');

  await prisma.minime.update({
    where: { id: draft.id },
    data: { isSaved: true, isDraft: false }
  });

  return response.true_status(res, null, 'MiniMe saved');
}

async function getCurrentMinime(req, res) {
  const userId = req.authData.id;
  const minime = await prisma.minime.findFirst({
    where: { userId, isSaved: true },
    orderBy: { createdAt: 'desc' }
  });

  if (!minime) return response.response_with_code(res, 404, 'No MiniMe found');
  return response.true_status(res, minime, 'Latest MiniMe');
}

async function getMiniMeLocker(req, res) {
  const userId = req.authData.id;
  const minis = await prisma.minime.findMany({
    where: { userId, isSaved: true },
    orderBy: { createdAt: 'desc' }
  });
  return res.json({ locker: minis });
}

// PROFILE/PRIVACY/POINTS – MISC
async function getUserProfile(req, res) {
  const viewerId = req.authData.id;
  const profileUserId = parseInt(req.params.userId);

  const user = await prisma.user.findUnique({
    where: { id: profileUserId },
    select: {
      id: true,
      username: true,
      firstName: true,
      lastName: true,
      bio: true,
      isProfilePrivate: true,
      minime: { select: { avatarUrl: true }, where: { isSaved: true } }
    }
  });

  if (!user) return res.status(404).json({ error: 'User not found' });

  const isFriend = await prisma.friendship.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: viewerId, receiverId: profileUserId },
        { requesterId: profileUserId, receiverId: viewerId }
      ]
    }
  });

  const allowView = !user.isProfilePrivate || viewerId === profileUserId || isFriend;

  if (!allowView) {
    return res.json({
      user,
      isPrivate: true,
      message: 'This profile is private. Send a friend request to view more.'
    });
  }

  const stories = await prisma.story.findMany({
    where: { userId: profileUserId, visibility: 'profile', NOT: { status: 'VAULT' } },
    orderBy: { createdAt: 'desc' }
  });

  return res.json({ user, isPrivate: false, stories, message: 'Profile loaded successfully.' });
}

async function getProfile(req, res) {
  const userId = req.authData.id;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        bio: true,
        bodyType: true,
        bodyShapeUrl: true,
        minime: { select: { avatarUrl: true }, where: { isSaved: true } }
      }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });
    return response.true_status(res, user, 'Profile loaded successfully');
  } catch (error) {
    console.error('Get profile error:', error);
    return response.response_with_code(res, 500, 'Failed to load profile');
  }
}

async function updatePrivacy(req, res) {
  const userId = req.authData.id;
  const { isPrivate } = req.body;

  await prisma.user.update({
    where: { id: userId },
    data: { isProfilePrivate: !!isPrivate }
  });

  res.json({ message: `Profile privacy set to ${!!isPrivate}` });
}

async function updateBio(req, res) {
  const userId = req.authData.id;
  const { bio } = req.body;

  if (!bio) return res.status(400).json({ error: 'Bio cannot be empty' });

  try {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { bio }
    });

    return response.true_status(res, updatedUser, 'Bio updated successfully');
  } catch (error) {
    console.error('Update bio error:', error);
    return response.response_with_code(res, 500, 'Failed to update bio');
  }
}

async function updateName(req, res) {
  const userId = req.authData.id;
  const { firstName, lastName } = req.body;

  if (!firstName && !lastName) {
    return response.response_with_code(res, 400, 'At least one of first name or last name is required');
  }

  const updateData = {};
  if (firstName) updateData.firstName = firstName;
  if (lastName) updateData.lastName = lastName;

  try {
    const updatedUser = await prisma.user.update({ where: { id: userId }, data: updateData });
    return response.true_status(res, updatedUser, 'Name updated successfully');
  } catch (error) {
    console.error('Update name error:', error);
    return response.response_with_code(res, 500, 'Failed to update name');
  }
}
// POINTS
async function getUserPoints(req, res) {
  const targetUserId = parseInt(req.params.userId, 10);

  try {
    const user = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, username: true, totalPoints: true }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // সপ্তাহের শুরু (সোমবার-ভিত্তিক)
    const now = new Date();
    const day = now.getDay(); // Sun=0
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);

    // ✅ Ledger থেকে যোগফল নাও — awarded finalPoints
    const ledgerRows = await prisma.pointsLedger.findMany({
      where: { userId: targetUserId, createdAt: { gte: weekStart } },
      select: { finalPoints: true }
      // চাইলে reasons ফিল্টার করতে পারো:
      // where: { userId: targetUserId, createdAt: { gte: weekStart }, reason: { in: ['CHALLENGE_COMPLETION','MAP_VISIT','REFERRAL_BONUS'] } }
    });

    const thisWeekPoints = ledgerRows.reduce((sum, r) => sum + (r.finalPoints || 0), 0);

    return res.json({
      userId: user.id,
      username: user.username,
      totalPoints: user.totalPoints,
      thisWeekPoints
    });
  } catch (error) {
    console.error('Get points error:', error);
    res.status(500).json({ error: 'Failed to fetch points' });
  }
}
// controllers/userController.js
async function submitForPoints(req, res) {
  const userId = req.authData.id;
  const { placeName, latitude, longitude } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No media uploaded' });

  try {
    const mediaUrl = await uploadToS3(req.file, 'points');
    const basePoints = 5;

    // 1) আগে locationPoint সেভ করি
    const lp = await prisma.locationPoint.create({
      data: {
        userId,
        mediaUrl,
        placeName,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        points: basePoints
      }
    });

    // 2) Ledger + totalPoints — multiplier সাপোর্টেড
    const award = await addPointsWithMultiplier(
      userId,
      basePoints,
      'LOCATION_UPLOAD', // reason
      lp.id               // refId → এই locationPoint রেকর্ডের id
    );

    return res.json({
      message: `You received ${award.finalPoints} points!`,
      points: award.finalPoints,
      mediaUrl
    });
  } catch (err) {
    console.error('Submit for points error:', err);
    return res.status(500).json({ error: 'Submission failed', details: err.message });
  }
}


const getLevelFromPoints = (points) => {
  if (points >= 400) return { level: 20, title: 'Legendary Explorer' };
  if (points >= 300) return { level: 19, title: 'City Sniper' };
  if (points >= 250) return { level: 18, title: 'City Sniper' };
  if (points >= 200) return { level: 15, title: 'City Sniper' };
  if (points >= 150) return { level: 12, title: 'City Sniper' };
  if (points >= 100) return { level: 10, title: 'City Sniper' };
  if (points >= 75)  return { level: 8,  title: 'Urban Explorer' };
  if (points >= 50)  return { level: 6,  title: 'Urban Explorer' };
  if (points >= 25)  return { level: 4,  title: 'New Explorer' };
  if (points >= 10)  return { level: 2,  title: 'New Explorer' };
  return { level: 1, title: 'New Explorer' };
};

const getPointsForNextLevel = (currentPoints) => {
  const thresholds = [0, 10, 25, 50, 75, 100, 150, 200, 250, 300, 400];
  for (let i = 0; i < thresholds.length; i++) {
    if (currentPoints < thresholds[i]) return thresholds[i] - currentPoints;
  }
  return 0;
};

async function getAchievementStatus(req, res) {
  const userId = req.authData.id;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { totalPoints: true }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    const { level, title } = getLevelFromPoints(user.totalPoints);
    const remaining = getPointsForNextLevel(user.totalPoints);

    res.json({
      totalPoints: user.totalPoints,
      level,
      title,
      pointsToNextLevel: remaining
    });
  } catch (error) {
    console.error('Get achievement error:', error);
    res.status(500).json({ error: 'Could not get level info' });
  }
}

// DELETE ACCOUNT
async function deleteAccount(req, res) {
  const userId = req.authData.id;

  try {
    await prisma.user.delete({ where: { id: userId } });
    return res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
}

/* -------------------------------------------------------------------------- */
/*                                   EXPORTS                                   */
/* -------------------------------------------------------------------------- */

module.exports = {
  // MiniMe + profile
  saveProfile,
  uploadAvatarWithMulter,
  generateMinime,
  regenerateMinime,
  saveLatestMinime,
  getCurrentMinime,
  getMiniMeLocker,
  getUserProfile,
  getProfile,
  updatePrivacy,
  updateBio,
  updateName,

  // Points
  getUserPoints,
  submitForPoints,
  getAchievementStatus,

  // Account
  deleteAccount,
};
