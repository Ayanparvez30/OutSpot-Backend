

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { addPointsWithMultiplier } = require('../utils/points');
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

    // Compress selfie before uploading to S3
    const originalKB = (file.buffer.length / 1024).toFixed(0);
    const compressed = await sharp(file.buffer)
      .resize(768, 1152, { fit: 'inside', withoutEnlargement: true })
      .sharpen({ sigma: 0.5 })
      .webp({ quality: 85, alphaQuality: 95, effort: 6, smartSubsample: true })
      .toBuffer();
    const compressedKB = (compressed.length / 1024).toFixed(0);
    console.log(`[SELFIE] Compressed: ${originalKB} KB → ${compressedKB} KB (webp)`);

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
      email: true,
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
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        bio: true,
        bodyType: true,
        bodyShapeUrl: true,
        totalPoints: true,
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

async function submitForPoints(req, res) {
  const userId = req.authData.id;
  const { placeName, latitude, longitude } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No media uploaded' });

  try {
    const mediaUrl = await uploadToS3(req.file, 'points');
    const basePoints = 5;


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

// ------------ ACCOUNT DELETE ------------
async function deleteAccount(req, res) {
  const userId = req.authData.id;

  try {

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { firebaseUid: true }
    });
    const firebaseUid = user?.firebaseUid || null;

    // 1) Firebase Auth
    if (firebaseUid) {
      try {
        await admin.auth().deleteUser(firebaseUid);
      } catch (e) {
        if (e.code !== 'auth/user-not-found') throw e;
      }
    }

    try {
      await admin.firestore().collection('users').doc(firebaseUid).delete();
    } catch (_) {}
    try {
      await admin.database().ref(`users/${firebaseUid}`).remove();
    } catch (_) {}

    // 3) Prisma DB
    await prisma.$transaction(async (tx) => {
  
      await tx.user.delete({ where: { id: userId } });
    });

    return res.json({ message: 'Account deleted everywhere' });
  } catch (error) {
    console.error('Delete account error:', error);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
}
async function getUserStatsByUserId (req, res){
  try {
    const viewerId = req.authData.id;
    const userId = parseInt(req.params.userId, 10);

    if (!Number.isFinite(userId)) {
      return res.status(400).json({ success: false, message: "Invalid userId" });
    }

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!targetUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // --------- Stats ----------
    const friendsCount = await prisma.friendship.count({
      where: {
        status: "ACCEPTED",
        OR: [{ requesterId: userId }, { receiverId: userId }],
      },
    });

    const groupsCount = await prisma.communityMember.count({
      where: { userId },
    });

    // ✅ latest joined community (joinedAt preferred; fallback by id)
    const myCommunity = await prisma.communityMember.findFirst({
      where: { userId },
      orderBy: [{ joinedAt: "desc" }, { id: "desc" }],
      include: {
        community: { select: { id: true, name: true, imageUrl: true } },
      },
    });

    // spots visited: unique placeIds + unique coordinates from records without placeId
    let spotsVisited = 0;

    // Count unique placeId-based visits
    const uniquePlaces = await prisma.locationPoint.findMany({
      where: { userId, placeId: { not: null } },
      distinct: ["placeId"],
      select: { placeId: true },
    });
    spotsVisited += uniquePlaces.length;

    // Also count unique coordinate-based visits that have NO placeId
    const uniqueCoords = await prisma.locationPoint.findMany({
      where: { userId, placeId: null, latitude: { not: null }, longitude: { not: null } },
      distinct: ["latitude", "longitude"],
      select: { latitude: true, longitude: true },
    });
    spotsVisited += uniqueCoords.length;

    const challengesCompleted = await prisma.pointsLedger.count({
      where: {
        userId,
        reason: { in: ["DAILY_CHALLENGE_COMPLETE", "WEEKLY_CHALLENGE_COMPLETE"] },
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { bodyType: true },
    });

    return res.json({
      success: true,
      data: {
        userId,
        bodyType: user?.bodyType || null,
        spotsVisited,
        friends: friendsCount,
        community: groupsCount,
        challengesCompleted,
        myCommunity: myCommunity?.community || null,
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

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [spots, total] = await Promise.all([
      prisma.locationPoint.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          placeId: true,
          placeName: true,
          latitude: true,
          longitude: true,
          mediaUrl: true,
          points: true,
          createdAt: true,
        },
      }),
      prisma.locationPoint.count({ where: { userId } }),
    ]);

    return res.json({
      success: true,
      data: spots,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("getUserVisitedSpots error:", err);
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
  updateBio,
  updateName,

  // Points
  getUserPoints,
  submitForPoints,
  getAchievementStatus,
getUserStatsByUserId,
  getUserVisitedSpots,
  // Account
  deleteAccount,
};
