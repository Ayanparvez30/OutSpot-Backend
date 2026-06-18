

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { addPointsWithMultiplier } = require('../utils/points');
const { validatePlaceDistance, metersToMiles } = require('../utils/placeDistance');
const { OpenAI } = require('openai');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const response = require('../functions/response');
const uploadToS3 = require('../utils/s3Upload');
const { renderCurrentMinime } = require('../utils/minimeGen');
require('dotenv').config();
const admin = require('../firebaseAdmin');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const validBodyTypes = ['masculine', 'feminine'];


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



const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


async function saveProfile(req, res) {
  try {
    const { firstName, lastName, bio, bodyType, bodyShapeUrl } = req.body;
    const userId = req.authData.id;

    // Build update data from provided fields only (partial updates OK)
    const data = {};
    if (firstName !== undefined) data.firstName = firstName;
    if (lastName !== undefined) data.lastName = lastName;
    if (bio !== undefined) data.bio = bio;
    if (bodyType !== undefined) {
      if (!validBodyTypes.includes(bodyType)) {
        return response.response_with_code(res, 400, 'Invalid body type');
      }
      data.bodyType = bodyType;
    }
    if (bodyShapeUrl !== undefined) data.bodyShapeUrl = bodyShapeUrl;

    if (Object.keys(data).length === 0) {
      return response.response_with_code(res, 400, 'No fields to update');
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data,
    });

    return response.true_status(res, updatedUser, 'Profile saved');
  } catch (error) {
    console.error('Profile error:', error);
    return response.response_with_code(res, 500, 'Server error');
  }
}
// LIST BODY SHAPES (for Flutter)
async function listBodyShapes(req, res) {
  try {
    const shapes = await prisma.bodyShape.findMany({
      where: { isActive: true },
      select: { id: true, gender: true, height: true, weight: true, imageUrl: true },
      orderBy: [{ gender: 'asc' }, { weight: 'asc' }, { height: 'asc' }],
    });
    return response.true_status(res, shapes, 'Body shapes loaded');
  } catch (err) {
    console.error('listBodyShapes error:', err);
    return response.response_with_code(res, 500, 'Failed to load body shapes');
  }
}

// LIST PREMADE AVATARS (for Flutter)
async function listPremadeAvatars(req, res) {
  try {
    const premades = await prisma.premadeAvatar.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, label: true, gender: true, imageUrl: true },
    });
    return response.true_status(res, premades, 'Premade avatars loaded');
  } catch (err) {
    console.error('listPremadeAvatars error:', err);
    return response.response_with_code(res, 500, 'Failed to load premades');
  }
}

// AVATAR UPLOAD
async function uploadAvatarWithMulter(req, res) {
  try {
    const userId = req.authData.id;

    // Clear old drafts
    await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

    // ----- (A) Premade avatar by ID (new approach) -----
    if (req.body.premadeId) {
      const premade = await prisma.premadeAvatar.findUnique({
        where: { id: parseInt(req.body.premadeId, 10) },
      });
      if (!premade || !premade.isActive) {
        return response.response_with_code(res, 404, 'Premade avatar not found');
      }

      const minime = await prisma.minime.create({
        data: { userId, selfieUrl: premade.imageUrl, isSaved: false, isDraft: true }
      });

      return response.true_status(res, minime, 'MiniMe face set from premade avatar');
    }

    // ----- (A2) Legacy: Premade avatar by URL -----
    if (req.body.premadeUrl) {
      const premadeUrl = String(req.body.premadeUrl).trim();
      if (!premadeUrl.startsWith('http')) {
        return response.response_with_code(res, 400, 'Invalid premade URL');
      }

      const minime = await prisma.minime.create({
        data: { userId, selfieUrl: premadeUrl, isSaved: false, isDraft: true }
      });

      return response.true_status(res, minime, 'MiniMe face set from premade URL');
    }

    // ----- (B) File upload (selfie) — ALWAYS stored as selfieUrl -----
    const file = req.files?.[0];
    if (!file) return response.response_with_code(res, 400, 'No image uploaded');

    // Compress selfie before uploading to S3. This is the FACE REFERENCE fed to
    // gpt-image-1, so keep it high-res + high-quality → sharper face in the avatar.
    const originalKB = (file.buffer.length / 1024).toFixed(0);
    const compressed = await sharp(file.buffer)
      .resize(1024, 1536, { fit: 'inside', withoutEnlargement: true }) // was 768×1152
      .sharpen({ sigma: 0.6 })
      .webp({ quality: 92, alphaQuality: 100, effort: 6, smartSubsample: true }) // was q85/a95
      .toBuffer();
    const compressedKB = (compressed.length / 1024).toFixed(0);
    console.log(`[SELFIE] Compressed: ${originalKB} KB → ${compressedKB} KB (webp 1024×1536 q92)`);

    const compressedFile = {
      originalname: file.originalname.replace(/\.[^.]+$/, '.webp'),
      buffer: compressed,
      mimetype: 'image/webp',
    };
    const s3Url = await uploadToS3(compressedFile, 'avatars');

    // Persist canonical selfie on User so it's never lost when drafts are deleted
    await prisma.user.update({ where: { id: userId }, data: { selfieUrl: s3Url } });

    const minime = await prisma.minime.create({
      data: { userId, selfieUrl: s3Url, isSaved: false, isDraft: true }
    });
    return response.true_status(res, minime, 'MiniMe selfie uploaded');
  } catch (err) {
    console.error('Upload error:', err);
    return response.response_with_code(res, 500, 'Upload failed');
  }
}

async function generateMinime(req, res) {
  try {
    const userId = req.authData.id;
    const { premadeId, bodyType, bodyShapeUrl, shirt, pant, shoes, glasses, lipstick, jewelry, bag, watch } = req.body || {};

    // Resolve face reference: User.selfieUrl (real face) > premadeId > last Minime selfieUrl
    const userRecord = await prisma.user.findUnique({ where: { id: userId }, select: { selfieUrl: true } });
    let faceRef;

    if (userRecord?.selfieUrl) {
      // Always prefer the canonical selfie (real face) if available
      faceRef = userRecord.selfieUrl;
    } else if (premadeId) {
      const premade = await prisma.premadeAvatar.findUnique({
        where: { id: parseInt(premadeId, 10) },
      });
      if (!premade || !premade.isActive) {
        return response.response_with_code(res, 400, 'Premade avatar not found or inactive');
      }
      faceRef = premade.imageUrl;
    } else {
      const last = await prisma.minime.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      faceRef = last?.selfieUrl || null;
    }

    if (!faceRef) {
      return response.response_with_code(res, 400,
        'No selfie found. Please upload a selfie or select a premade avatar first.');
    }

    await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

    const draft = await prisma.minime.create({
      data: {
        userId,
        shirt: shirt || null,
        pant: pant || null,
        shoes: shoes || null,
        glasses: glasses || null,
        lipstick: lipstick || null,
        jewelry: jewelry || null,
        bag: bag || null,
        watch: watch || null,
        selfieUrl: faceRef,
        isSaved: false,
        isDraft: true,
      },
    });

    const opts = {};
    if (bodyType) opts.bodyType = bodyType;
    if (bodyShapeUrl) opts.bodyShapeUrl = bodyShapeUrl;

    const rendered = await renderCurrentMinime(userId, opts);

    return response.true_status(res, rendered, 'MiniMe draft generated');
  } catch (error) {
    console.error('generateMinime error:', error);
    return response.response_with_code(res, 500, 'Failed to generate MiniMe');
  }
}


async function regenerateMinime(req, res) {
  try {
    const userId = req.authData.id;
    const { bodyType, bodyShapeUrl } = req.body || {};

    // Prefer canonical selfie from User profile, then fall back to last Minime
    const userRecord = await prisma.user.findUnique({ where: { id: userId }, select: { selfieUrl: true } });
    let faceRef = userRecord?.selfieUrl || null;

    if (!faceRef) {
      const lastAny = await prisma.minime.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' }
      });
      faceRef = lastAny?.selfieUrl || null;
    }

    if (!faceRef) {
      return response.response_with_code(res, 400,
        'No selfie found. Please upload a selfie or select a premade avatar first.');
    }

    let draft = await prisma.minime.findFirst({
      where: { userId, isDraft: true, isSaved: false },
      orderBy: { createdAt: 'desc' }
    });

    if (!draft) {

      const seed = lastAny || {};
      draft = await prisma.minime.create({
        data: {
          userId,
          shirt: seed.shirt ?? null,
          pant: seed.pant ?? null,
          shoes: seed.shoes ?? null,
          glasses: seed.glasses ?? null,
          lipstick: seed.lipstick ?? null,
          jewelry: seed.jewelry ?? null,
          bag: seed.bag ?? null,
          watch: seed.watch ?? null,
          selfieUrl: faceRef,
          isSaved: false,
          isDraft: true
        }
      });
    } else if (!draft.selfieUrl && faceRef) {

      await prisma.minime.update({
        where: { id: draft.id },
        data: { selfieUrl: faceRef }
      });
    }

    const opts = { targetMinimeId: draft.id };
    if (bodyType) opts.bodyType = bodyType;
    if (bodyShapeUrl) opts.bodyShapeUrl = bodyShapeUrl;
    const rendered = await renderCurrentMinime(userId, opts);

    return response.true_status(res, rendered, 'MiniMe regenerated (face reference preserved)');
  } catch (err) {
    console.error('regenerateMinime error:', err);
    return response.response_with_code(res, 500, 'Regeneration failed');
  }
}


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
    orderBy: { updatedAt: 'desc' }
  });
  return res.json({ locker: minis });
}

async function setActiveMinime(req, res) {
  const userId = req.authData.id;
  const minimeId = parseInt(req.params.id, 10);

  if (!Number.isFinite(minimeId)) {
    return res.status(400).json({ error: 'Invalid minime id' });
  }

  const minime = await prisma.minime.findFirst({
    where: { id: minimeId, userId, isSaved: true },
    select: { id: true, avatarUrl: true },
  });

  if (!minime) {
    return res.status(404).json({ error: 'Minime not found in your locker' });
  }

  // Bump updatedAt so this minime sorts first in all profile queries (orderBy: updatedAt desc)
  await prisma.minime.update({
    where: { id: minimeId },
    data: { updatedAt: new Date() },
  });

  return res.json({ success: true, avatarUrl: minime.avatarUrl });
}

// PROFILE/PRIVACY/POINTS – MISC
async function getUserProfile(req, res) {
  const viewerId = req.authData.id;
  const profileUserId = parseInt(req.params.userId);

  const user = await prisma.user.findUnique({
    where: { id: profileUserId },
    select: {
      id: true,
      email: true,
      username: true,
      firstName: true,
      lastName: true,
      bio: true,
      isProfilePrivate: true,
      minime: { where: { isSaved: true }, orderBy: { updatedAt: 'desc' }, take: 1, select: { avatarUrl: true } }
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
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        bio: true,
        bodyType: true,
        bodyShapeUrl: true,
        totalPoints: true,
        isProfilePrivate: true, // RAW lock state for the settings toggle
        minime: { where: { isSaved: true }, orderBy: { updatedAt: 'desc' }, take: 1, select: { avatarUrl: true } }
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

// GET current notification master switch (null/undefined => true by default)
async function getNotificationSetting(req, res) {
  try {
    const userId = req.authData.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { notificationEnabled: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ notificationEnabled: user.notificationEnabled !== false });
  } catch (err) {
    console.error('getNotificationSetting error:', err);
    return res.status(500).json({ error: 'Failed to load notification setting' });
  }
}

// POST set notification master switch.
// Accepts the flag under `enabled` OR `notificationEnabled`, and coerces common
// shapes (boolean, "true"/"false", 1/0, "1"/"0") so a client that sends a string
// or the alternate key still persists correctly (the toggle must never silently
// fail to ON). When off, NO FCM push of any kind is delivered to this user.
function coerceBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return null;
}

async function setNotificationSetting(req, res) {
  try {
    const userId = req.authData.id;
    const raw = req.body?.enabled ?? req.body?.notificationEnabled;
    const enabled = coerceBool(raw);
    if (enabled === null) {
      return res.status(400).json({ error: 'enabled (boolean) is required' });
    }
    await prisma.user.update({
      where: { id: userId },
      data: { notificationEnabled: enabled },
    });
    return res.json({ notificationEnabled: enabled });
  } catch (err) {
    console.error('setNotificationSetting error:', err);
    return res.status(500).json({ error: 'Failed to update notification setting' });
  }
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

    const now = new Date();
    const day = now.getDay(); // Sun=0
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);

    const ledgerRows = await prisma.pointsLedger.findMany({
      where: { userId: targetUserId, createdAt: { gte: weekStart } },
      select: { finalPoints: true }

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

// GET submit-for-points cooldown status. Lets the client render a live countdown
// when "Submit for Points" is shown, WITHOUT attempting a submission. Mirrors the
// 1-hour per-user rate limit used by submitForPoints. (Challenge submissions are
// separate and have NO such limit.)
async function getSubmitForPointsStatus(req, res) {
  try {
    const userId = req.authData.id;
    const RATE_LIMIT_MINUTES = Number(process.env.SUBMIT_RATE_LIMIT_MINUTES || 30);
    if (RATE_LIMIT_MINUTES <= 0) {
      return res.json({ canSubmit: true, retryAfterSeconds: 0, nextAllowedAt: null, rateLimitMinutes: 0, lastSubmitAt: null });
    }
    const windowMs = RATE_LIMIT_MINUTES * 60 * 1000;
    const lastSubmit = await prisma.locationPoint.findFirst({
      where: { userId, createdAt: { gte: new Date(Date.now() - windowMs) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!lastSubmit) {
      return res.json({ canSubmit: true, retryAfterSeconds: 0, nextAllowedAt: null, rateLimitMinutes: RATE_LIMIT_MINUTES, lastSubmitAt: null });
    }
    const nextAllowedAt = new Date(lastSubmit.createdAt.getTime() + windowMs);
    const retryAfterSeconds = Math.max(0, Math.ceil((nextAllowedAt.getTime() - Date.now()) / 1000));
    return res.json({
      canSubmit: retryAfterSeconds <= 0,
      retryAfterSeconds,                 // seconds left on cooldown (0 = can submit now)
      nextAllowedAt: nextAllowedAt.toISOString(),
      rateLimitMinutes: RATE_LIMIT_MINUTES,
      lastSubmitAt: lastSubmit.createdAt,
    });
  } catch (err) {
    console.error('getSubmitForPointsStatus error:', err);
    return res.status(500).json({ error: 'Failed to load submit status' });
  }
}

async function submitForPoints(req, res) {
  const userId = req.authData.id;
  const { placeId, placeName, latitude, longitude } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No media uploaded' });

  try {
    // ---- 1-hour rate limit ----
    // Per spec: a user can only submit-for-points once per hour, regardless of
    // place. Cheap query (single findFirst with createdAt index) runs BEFORE
    // any other validation so spam attempts cost almost nothing. Env override
    // SUBMIT_RATE_LIMIT_MINUTES lets us tune without redeploy.
    const RATE_LIMIT_MINUTES = Number(process.env.SUBMIT_RATE_LIMIT_MINUTES || 30);
    if (RATE_LIMIT_MINUTES > 0) {
      const rateWindowAgo = new Date(Date.now() - RATE_LIMIT_MINUTES * 60 * 1000);
      const lastSubmit = await prisma.locationPoint.findFirst({
        where: { userId, createdAt: { gte: rateWindowAgo } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (lastSubmit) {
        const elapsedMs = Date.now() - lastSubmit.createdAt.getTime();
        const remainingMs = RATE_LIMIT_MINUTES * 60 * 1000 - elapsedMs;
        const retryAfterSec = Math.max(1, Math.ceil(remainingMs / 1000));
        const mins = Math.floor(retryAfterSec / 60);
        const secs = retryAfterSec % 60;
        const retryIn = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        res.set('Retry-After', String(retryAfterSec));
        return res.status(429).json({
          awarded: false,
          reason: 'rate-limited',
          message: `You can only submit once every ${RATE_LIMIT_MINUTES} minutes. Try again in ${retryIn}.`,
          rateLimitMinutes: RATE_LIMIT_MINUTES,
          retryAfterSeconds: retryAfterSec,
          retryIn,
          lastSubmitAt: lastSubmit.createdAt,
        });
      }
    }

    // De-duplicate: same placeId or same coordinates within 12h window
    const DUP_WINDOW_HOURS = 12;
    const DUP_WINDOW_MS = DUP_WINDOW_HOURS * 60 * 60 * 1000;
    const since = new Date(Date.now() - DUP_WINDOW_MS);

    const timeUntilRetry = (lastDate) => {
      const retryAt = new Date(lastDate.getTime() + DUP_WINDOW_MS);
      const diffMs = retryAt - Date.now();
      if (diffMs <= 0) return 'now';
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const mins = Math.ceil((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      if (hours > 0) return `${hours}h ${mins}m`;
      return `${mins}m`;
    };

    if (placeId) {
      const duplicate = await prisma.locationPoint.findFirst({
        where: { userId, placeId: String(placeId).trim(), createdAt: { gte: since } },
        select: { id: true, createdAt: true },
      });
      if (duplicate) {
        const retryIn = timeUntilRetry(duplicate.createdAt);
        return res.status(200).json({
          awarded: false,
          reason: 'duplicate-place-within-window',
          message: `You've already earned points at this spot. Visit again in ${retryIn} to earn more!`,
          windowHours: DUP_WINDOW_HOURS,
          retryIn,
          lastSubmitAt: duplicate.createdAt,
        });
      }
    } else if (latitude && longitude) {
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const recent = await prisma.locationPoint.findMany({
          where: { userId, createdAt: { gte: since } },
          select: { latitude: true, longitude: true, createdAt: true },
        });
        const toRad = d => (d * Math.PI) / 180;
        const haversineM = (a, b) => {
          const R = 6371000, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
          const A = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
          return 2 * R * Math.asin(Math.sqrt(A));
        };
        for (const lp of recent) {
          if (lp.latitude == null || lp.longitude == null) continue;
          if (haversineM({ lat, lng }, { lat: lp.latitude, lng: lp.longitude }) <= 50) {
            const retryIn = timeUntilRetry(lp.createdAt);
            return res.status(200).json({
              awarded: false,
              reason: 'duplicate-nearby-within-window',
              message: `You've already earned points near this location. Try a new spot or come back in ${retryIn}!`,
              windowHours: DUP_WINDOW_HOURS,
              retryIn,
              radiusMeters: 50,
              lastSubmitAt: lp.createdAt,
            });
          }
        }
      }
    }

    // Server-side place validation — runs BEFORE S3 upload so rejected
    // submissions don't burn bandwidth/storage. Skipped only if no placeId
    // (legacy free-form submissions).
    let placeCheck = null;
    if (placeId) {
      const MAX_PLACE_DISTANCE_METERS = Number(process.env.MAX_PLACE_DISTANCE_METERS || 40);
      const uLat = parseFloat(latitude);
      const uLng = parseFloat(longitude);
      if (Number.isFinite(uLat) && Number.isFinite(uLng)) {
        const check = await validatePlaceDistance({
          placeId: String(placeId).trim(),
          userLat: uLat,
          userLng: uLng,
          maxMeters: MAX_PLACE_DISTANCE_METERS,
        });
        if (!check.ok) {
          if (check.reason === 'too-far-from-place') {
            console.log(`[submitForPoints] too-far user=${userId} placeId=${placeId} dist=${check.distMeters}m max=${MAX_PLACE_DISTANCE_METERS}m viewport=${check.viewportPresent ? 'present-but-outside' : 'absent'}`);
            return res.status(403).json({
              awarded: false,
              reason: 'too-far-from-place',
              message: check.message,
              placeId,
              distanceMiles: metersToMiles(check.distMeters),
              maxMiles: metersToMiles(MAX_PLACE_DISTANCE_METERS),
            });
          }
          if (check.reason === 'google-fetch-failed') {
            return res.status(502).json({ awarded: false, reason: check.reason, message: check.message });
          }
          return res.status(400).json({ awarded: false, reason: check.reason, message: check.message });
        }
        placeCheck = check; // priceLevel + userRatingsTotal are carried through
      }
    }

    const mediaUrl = await uploadToS3(req.file, 'points');
    // Award points based on the place's Google price level (or popularity for
    // free/no-data places). If no placeId was supplied or the lookup didn't
    // yield a usable price signal, fall back to the legacy flat 5pt award so
    // historical submission flows keep working.
    const { pointsForPlace } = require('../utils/pointsForPlace');
    const basePoints = placeCheck
      ? pointsForPlace({
          priceLevel: placeCheck.priceLevel,
          userRatingsTotal: placeCheck.userRatingsTotal,
        })
      : 5;

    const lp = await prisma.locationPoint.create({
      data: {
        userId,
        mediaUrl,
        placeId: placeId ? String(placeId).trim() : null,
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


// 20 levels, each with a cumulative points threshold
// Tiers: New Explorer (1-4), Urban Explorer (5-9), City Sniper (10-19), Legendary Explorer (20)
const LEVEL_THRESHOLDS = [
  0,    // Level 1  — 0 pts
  10,   // Level 2  — 10 pts
  25,   // Level 3  — 25 pts
  45,   // Level 4  — 45 pts
  70,   // Level 5  — 70 pts
  100,  // Level 6  — 100 pts
  140,  // Level 7  — 140 pts
  190,  // Level 8  — 190 pts
  250,  // Level 9  — 250 pts
  320,  // Level 10 — 320 pts
  400,  // Level 11 — 400 pts
  500,  // Level 12 — 500 pts
  620,  // Level 13 — 620 pts
  760,  // Level 14 — 760 pts
  920,  // Level 15 — 920 pts
  1100, // Level 16 — 1100 pts
  1300, // Level 17 — 1300 pts
  1550, // Level 18 — 1550 pts
  1850, // Level 19 — 1850 pts
  2200, // Level 20 — 2200 pts
];

const getTitleForLevel = (level) => {
  if (level >= 20) return 'Legendary Explorer';
  if (level >= 10) return 'City Sniper';
  if (level >= 5) return 'Urban Explorer';
  return 'New Explorer';
};

const getLevelFromPoints = (points) => {
  let level = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (points >= LEVEL_THRESHOLDS[i]) {
      level = i + 1; // index 0 = level 1, index 1 = level 2, etc.
    } else {
      break;
    }
  }
  return { level, title: getTitleForLevel(level) };
};

const getPointsForNextLevel = (currentPoints) => {
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (currentPoints < LEVEL_THRESHOLDS[i]) return LEVEL_THRESHOLDS[i] - currentPoints;
  }
  return 0; // max level reached
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

    // Current level threshold and next level threshold for progress bar
    const currentLevelThreshold = LEVEL_THRESHOLDS[level - 1]; // points needed to reach current level
    const nextLevelThreshold = level < 20 ? LEVEL_THRESHOLDS[level] : LEVEL_THRESHOLDS[19];
    const pointsInCurrentLevel = user.totalPoints - currentLevelThreshold;
    const pointsRequiredForNextLevel = nextLevelThreshold - currentLevelThreshold;
    const progress = level >= 20 ? 1.0 : pointsInCurrentLevel / pointsRequiredForNextLevel;

    res.json({
      totalPoints: user.totalPoints,
      level,
      maxLevel: 20,
      title,
      pointsToNextLevel: remaining,
      currentLevelThreshold,
      nextLevelThreshold,
      progress: Math.min(Math.max(progress, 0), 1), // clamped 0-1
      tiers: [
        { name: 'New Explorer', unlockLevel: 1 },
        { name: 'Urban Explorer', unlockLevel: 5 },
        { name: 'City Sniper', unlockLevel: 10 },
        { name: 'Legendary Explorer', unlockLevel: 20 },
      ],
    });
  } catch (error) {
    console.error('Get achievement error:', error);
    res.status(500).json({ error: 'Could not get level info' });
  }
}

// ------------ ACCOUNT DELETE ------------
async function deleteAccount(req, res) {
  const userId = req.authData.id;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { firebaseUid: true, selfieUrl: true, bodyShapeUrl: true }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const firebaseUid = user.firebaseUid || null;

    // 1) Collect all S3 URLs before deleting DB records
    const [
      minimes,
      media,
      stories,
      messages,
      chatImages,
      submissions,
      locationPoints,
      communityImages,
    ] = await Promise.all([
      prisma.minime.findMany({ where: { userId }, select: { avatarUrl: true } }),
      prisma.media.findMany({ where: { senderId: userId }, select: { fileUrl: true } }),
      prisma.story.findMany({ where: { userId }, select: { mediaUrl: true } }),
      prisma.message.findMany({ where: { senderId: userId, imageUrl: { not: null } }, select: { imageUrl: true } }),
      prisma.chatImage.findMany({ where: { userId }, select: { fileUrl: true } }),
      prisma.submission.findMany({ where: { userId }, select: { mediaUrl: true } }),
      prisma.locationPoint.findMany({ where: { userId }, select: { mediaUrl: true } }),
      prisma.community.findMany({ where: { creatorId: userId }, select: { imageUrl: true } }),
    ]);

    const s3Urls = [
      user.selfieUrl,
      // NOTE: user.bodyShapeUrl is a SHARED admin master asset (BodyShape.imageUrl)
      // that the user only references — never theirs to delete. Deleting an account
      // must NOT feed it into S3 cleanup (would orphan-delete the master image and
      // 404 it for everyone). Same applies to any premade/shop master URL.
      ...minimes.map(m => m.avatarUrl),
      ...media.map(m => m.fileUrl),
      ...stories.map(s => s.mediaUrl),
      ...messages.map(m => m.imageUrl),
      ...chatImages.map(c => c.fileUrl),
      ...submissions.map(s => s.mediaUrl),
      ...locationPoints.map(l => l.mediaUrl),
      ...communityImages.map(c => c.imageUrl),
    ].filter(Boolean);

    // 2) Transfer ownership of any communities this user created
    // If there's another member, they become the new creator. Otherwise the community is deleted.
    const ownedCommunities = await prisma.community.findMany({
      where: { creatorId: userId },
      select: { id: true },
    });
    for (const c of ownedCommunities) {
      const nextOwner = await prisma.communityMember.findFirst({
        where: { communityId: c.id, userId: { not: userId } },
        orderBy: { joinedAt: 'asc' },
        select: { userId: true },
      });
      if (nextOwner) {
        await prisma.community.update({
          where: { id: c.id },
          data: { creatorId: nextOwner.userId },
        });
      }
      // else: community has no other members → will cascade-delete with the user below
    }

    // 3) Firebase Auth + Firestore cleanup
    if (firebaseUid) {
      try { await admin.auth().deleteUser(firebaseUid); }
      catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
      try { await admin.firestore().collection('users').doc(firebaseUid).delete(); }
      catch (_) { }
      try { await admin.database().ref(`users/${firebaseUid}`).remove(); }
      catch (_) { }
    }

    // 4) Delete user from DB — all cascade relations handle cleanup
    await prisma.user.delete({ where: { id: userId } });

    // 5) Orphan-only S3 cleanup — these URLs may still be referenced by
    // SavedStory clones owned by OTHER users; the guard keeps S3 alive for
    // those rows and only deletes truly orphaned objects. Best-effort,
    // non-blocking.
    if (s3Urls.length) {
      const { deleteS3IfOrphanBulk } = require('../utils/s3Cleanup');
      deleteS3IfOrphanBulk([...new Set(s3Urls)])
        .catch(err => console.error('account-delete S3 cleanup error', err));
    }

    return res.json({ message: 'Account deleted everywhere' });
  } catch (error) {
    console.error('Delete account error:', error);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
}
async function getUserStatsByUserId(req, res) {
  try {
    const viewerId = req.authData.id;
    const userId = parseInt(req.params.userId, 10);

    if (!Number.isFinite(userId)) {
      return res.status(400).json({ success: false, message: "Invalid userId" });
    }

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isProfilePrivate: true },
    });
    if (!targetUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isSelf = viewerId === userId;

    // Friendship status relative to the VIEWER (drives the app's profile screen)
    const friendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: viewerId, receiverId: userId },
          { requesterId: userId, receiverId: viewerId },
        ],
      },
      select: { status: true, requesterId: true },
    });
    const isFriend = friendship?.status === "ACCEPTED";

    let friendshipStatus = "NONE";
    if (isSelf) {
      friendshipStatus = "SELF";
    } else if (friendship) {
      if (friendship.status === "ACCEPTED") {
        friendshipStatus = "ACCEPTED";
      } else if (friendship.status === "PENDING") {
        friendshipStatus =
          friendship.requesterId === viewerId ? "PENDING_SENT" : "PENDING_RECEIVED";
      }
    }

    // Private account hides stats from non-friends (self & friends bypass).
    const isPrivate = !isSelf && !isFriend && !!targetUser.isProfilePrivate;
    if (isPrivate) {
      return res.json({
        success: true,
        data: {
          userId,
          isPrivate: true,
          friendshipStatus,
          bodyType: null,
          spotsVisited: 0,
          friends: 0,
          community: 0,
          challengesCompleted: 0,
          myCommunity: null,
        },
      });
    }

    // --------- Stats (all queries in parallel) ----------
    const [
      friendsCount,
      groupsCount,
      myCommunity,
      uniquePlaces,
      uniqueCoords,
      challengesCompleted,
      user,
    ] = await Promise.all([
      prisma.friendship.count({
        where: {
          status: "ACCEPTED",
          OR: [{ requesterId: userId }, { receiverId: userId }],
        },
      }),
      prisma.communityMember.count({ where: { userId } }),
      // Own created community (not just joined)
      prisma.community.findFirst({
        where: { creatorId: userId },
        select: { id: true, name: true, imageUrl: true },
      }),
      // Unique placeId-based visits
      prisma.locationPoint.findMany({
        where: { userId, placeId: { not: null } },
        distinct: ["placeId"],
        select: { placeId: true },
      }),
      // Unique coordinate-based visits (no placeId)
      prisma.locationPoint.findMany({
        where: { userId, placeId: null, latitude: { not: null }, longitude: { not: null } },
        distinct: ["latitude", "longitude"],
        select: { latitude: true, longitude: true },
      }),
      // Completed challenges (count via ChallengeCompletion — one row per completed window)
      prisma.challengeCompletion.count({ where: { userId } }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { bodyType: true },
      }),
    ]);

    const spotsVisited = uniquePlaces.length + uniqueCoords.length;

    return res.json({
      success: true,
      data: {
        userId,
        isPrivate: false,
        friendshipStatus,
        bodyType: user?.bodyType || null,
        spotsVisited,
        friends: friendsCount,
        community: groupsCount,
        challengesCompleted,
        myCommunity: myCommunity || null,
      },
    });
  } catch (err) {
    console.error("getUserStatsByUserId error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
async function getMiniMeLockerByUserId(req, res) {
  try {
    const viewerId = req.authData.id;
    const targetUserId = parseInt(req.params.userId, 10);

    if (!Number.isFinite(targetUserId)) {
      return res.status(400).json({ error: "Invalid userId" });
    }

    // ✅ target user minimal info (privacy)
    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, isProfilePrivate: true },
    });

    if (!target) return res.status(404).json({ error: "User not found" });

    const isSelf = viewerId === targetUserId;

    // ✅ block check (same idea as your computeNewCounts notBlocked)
    if (!isSelf) {
      const blocked = await prisma.user.findFirst({
        where: {
          id: targetUserId,
          OR: [
            { blockedBy: { some: { blockerId: viewerId } } }, // target blocked by viewer?
            { blocks: { some: { blockedId: viewerId } } },    // target blocked viewer?
          ],
        },
        select: { id: true },
      });

      if (blocked) {
        return res.status(403).json({ error: "You cannot view this locker." });
      }
    }

    // ✅ friend check (only needed for private profiles)
    let isFriend = false;
    if (!isSelf) {
      const fr = await prisma.friendship.findFirst({
        where: {
          status: "ACCEPTED",
          OR: [
            { requesterId: viewerId, receiverId: targetUserId },
            { requesterId: targetUserId, receiverId: viewerId },
          ],
        },
        select: { id: true },
      });
      isFriend = !!fr;
    }

    // ✅ permission
    const allowView = isSelf || !target.isProfilePrivate || isFriend;

    if (!allowView) {
      return res.status(403).json({
        error: "This locker is private. Only friends can view it.",
      });
    }

    // ✅ Return saved minis only
    const minis = await prisma.minime.findMany({
      where: { userId: targetUserId, isSaved: true },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        avatarUrl: true,
        selfieUrl: true,
        shirt: true,
        pant: true,
        shoes: true,
        glasses: true,
        lipstick: true,
        jewelry: true,
        bag: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({
      userId: targetUserId,
      isSelf,
      isFriend: isSelf ? true : isFriend,
      isPrivate: !!target.isProfilePrivate,
      locker: minis,
    });
  } catch (e) {
    console.error("getMiniMeLockerByUserId error:", e);
    return res.status(500).json({ error: "Failed to load locker" });
  }
}

async function getUserVisitedSpots(req, res) {
  try {
    const viewerId = req.authData.id;
    const userId = parseInt(req.params.userId, 10);

    if (!Number.isFinite(userId)) {
      return res.status(400).json({ success: false, message: "Invalid userId" });
    }

    // Allow self or friends only
    if (viewerId !== userId) {
      const friendship = await prisma.friendship.findFirst({
        where: {
          status: "ACCEPTED",
          OR: [
            { requesterId: viewerId, receiverId: userId },
            { requesterId: userId, receiverId: viewerId },
          ],
        },
        select: { id: true },
      });
      if (!friendship) {
        return res.status(403).json({
          success: false,
          message: "You can only view visited spots of your friends.",
        });
      }
    }

    // Fetch all location points for this user
    const allPoints = await prisma.locationPoint.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        placeId: true,
        placeName: true,
        placeType: true,
        latitude: true,
        longitude: true,
        mediaUrl: true,
        points: true,
        createdAt: true,
      },
    });

    // Infer placeType from placeName when the DB column is null (pre-migration records)
    const inferPlaceType = (name) => {
      if (!name) return null;
      const n = name.toLowerCase();
      if (/rooftop/.test(n)) return 'Rooftop Bars';
      if (/cafe|coffee|bakery|patisserie/.test(n)) return 'Cafes';
      if (/bar|pub|lounge|tavern/.test(n)) return 'Rooftop Bars';
      if (/restaurant|grill|bistro|diner|eatery|kitchen|food/.test(n)) return 'Popular Restaurants';
      if (/park|garden|trail|nature|outdoor|reserve|forest/.test(n)) return 'Outdoor Activities';
      if (/concert|venue|theater|theatre|arena|stadium|event/.test(n)) return 'Venue Events';
      return null;
    };

    // De-duplicate: group by placeId (if present) or by lat+lng key
    const spotMap = new Map();

    for (const point of allPoints) {
      const key = point.placeId
        ? `place:${point.placeId}`
        : `coord:${point.latitude?.toFixed(5)},${point.longitude?.toFixed(5)}`;

      if (!spotMap.has(key)) {
        // First visit (newest due to desc order) — use as representative
        spotMap.set(key, {
          placeId: point.placeId || null,
          placeName: point.placeName || null,
          placeType: point.placeType || inferPlaceType(point.placeName),
          latitude: point.latitude,
          longitude: point.longitude,
          mediaUrl: point.mediaUrl,
          firstVisitedAt: point.createdAt,
          lastVisitedAt: point.createdAt,
          visitCount: 1,
          totalPoints: point.points,
        });
      } else {
        const existing = spotMap.get(key);
        existing.visitCount += 1;
        existing.totalPoints += point.points;
        // allPoints is desc, so older dates come later
        existing.firstVisitedAt = point.createdAt;
        // Keep placeType from most recent visit (or infer) if not yet set
        if (!existing.placeType) {
          existing.placeType = point.placeType || inferPlaceType(point.placeName);
        }
      }
    }

    // Sort unique spots by lastVisitedAt desc
    const spots = Array.from(spotMap.values()).sort(
      (a, b) => new Date(b.lastVisitedAt) - new Date(a.lastVisitedAt)
    );

    return res.json({
      success: true,
      data: spots,
      total: spots.length,
    });
  } catch (err) {
    console.error("getUserVisitedSpots error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

async function getCompletedChallenges(req, res) {
  try {
    const viewerId = req.authData.id;
    const userId = parseInt(req.params.userId, 10);

    if (!Number.isFinite(userId)) {
      return res.status(400).json({ success: false, message: "Invalid userId" });
    }

    // Allow self or friends only
    if (viewerId !== userId) {
      const friendship = await prisma.friendship.findFirst({
        where: {
          status: "ACCEPTED",
          OR: [
            { requesterId: viewerId, receiverId: userId },
            { requesterId: userId, receiverId: viewerId },
          ],
        },
        select: { id: true },
      });
      if (!friendship) {
        return res.status(403).json({
          success: false,
          message: "You can only view completed challenges of your friends.",
        });
      }
    }

    // Fetch all completions with full challenge data + actual points from ledger
    const [completions, ledgerRows] = await Promise.all([
      prisma.challengeCompletion.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: {
          challenge: {
            select: {
              id: true,
              title: true,
              description: true,
              frequency: true,
              tier: true,
              points: true,
              requiredPhotos: true,
            },
          },
        },
      }),
      prisma.pointsLedger.findMany({
        where: { userId, reason: "CHALLENGE_COMPLETION" },
        select: { refId: true, basePoints: true, appliedMultiplier: true, finalPoints: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    // Map ledger entries by challengeId for fast lookup (keep most recent per challenge)
    const ledgerByChallenge = new Map();
    for (const row of ledgerRows) {
      if (row.refId != null && !ledgerByChallenge.has(row.refId)) {
        ledgerByChallenge.set(row.refId, row);
      }
    }

    const data = completions.map((c) => {
      const ledger = ledgerByChallenge.get(c.challengeId);
      return {
        completionId: c.id,
        windowKey: c.windowKey,
        completedAt: c.createdAt,
        challenge: {
          id: c.challenge.id,
          title: c.challenge.title,
          description: c.challenge.description,
          frequency: c.challenge.frequency,
          tier: c.challenge.tier,
          requiredPhotos: c.challenge.requiredPhotos,
          basePoints: c.challenge.points,
        },
        pointsAwarded: ledger?.finalPoints ?? c.challenge.points,
        basePoints: ledger?.basePoints ?? c.challenge.points,
        multiplierApplied: ledger?.appliedMultiplier ?? 1,
      };
    });

    return res.json({
      success: true,
      data,
      total: data.length,
    });
  } catch (err) {
    console.error("getCompletedChallenges error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = {
  listBodyShapes,
  listPremadeAvatars,
  saveProfile,
  uploadAvatarWithMulter,
  getMiniMeLockerByUserId,
  generateMinime,
  regenerateMinime,
  saveLatestMinime,
  getCurrentMinime,
  getMiniMeLocker,
  getUserProfile,
  getProfile,
  updatePrivacy,
  getNotificationSetting,
  setNotificationSetting,
  updateBio,
  updateName,

  // Points
  getUserPoints,
  submitForPoints,
  getSubmitForPointsStatus,
  getAchievementStatus,
  getUserStatsByUserId,
  getUserVisitedSpots,
  getCompletedChallenges,
  setActiveMinime,
  // Account
  deleteAccount,
};
