

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { addPointsWithMultiplier } = require('../utils/points');
const { OpenAI } = require('openai');
const path = require('path');
const multer = require('multer');
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

    // ----- (A) Premade avatar by URL  -----
    if (req.body.premadeUrl) {
      const premadeUrl = String(req.body.premadeUrl).trim();
      if (!premadeUrl.startsWith('http')) {
        return response.response_with_code(res, 400, 'Invalid premade URL');
      }

      // পুরোনো ড্রাফট ক্লিয়ার
      await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

      // ✅ premade URL কে selfieUrl হিসেবে সেভ করি → এটি হবে STRICT face reference
      const minime = await prisma.minime.create({
        data: { userId, selfieUrl: premadeUrl, isSaved: false, isDraft: true }
      });

      return response.true_status(res, minime, 'MiniMe face set from premade URL');
    }

    // ----- (B) File upload (selfie or gallery) -----
    const file = req.files?.[0];
    if (!file) return response.response_with_code(res, 400, 'No image uploaded');

    const s3Url = await uploadToS3(file, 'avatars');

    await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

   
    const data = {
      userId,
      isSaved: false,
      isDraft: true,
      ...(file.fieldname?.toLowerCase() === 'selfie'
        ? { selfieUrl: s3Url }         
        : { avatarUrl: s3Url }          
      ),
    };

    const minime = await prisma.minime.create({ data });
    return response.true_status(res, minime, 'MiniMe source uploaded');
  } catch (err) {
    console.error('Upload error:', err);
    return response.response_with_code(res, 500, 'Upload failed');
  }
}

async function generateMinime(req, res) {
  try {
    const userId = req.authData.id;
    const { shirt, pant, shoes, glasses, lipstick, jewelry, bag } = req.body || {};

    const last = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    const faceRef = last?.selfieUrl || null;

    await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

    const draft = await prisma.minime.create({
      data: {
        userId,
        shirt,
        pant,
        shoes,
        glasses,
        lipstick,
        jewelry,
        bag,
        selfieUrl: faceRef,  
        isSaved: false,
        isDraft: true,
      },
    });

    // 🔹 4) Render
    const rendered = await renderCurrentMinime(userId);

    return response.true_status(res, rendered, 'MiniMe draft generated');
  } catch (error) {
    console.error('generateMinime error:', error);
    return response.response_with_code(res, 500, 'Failed to generate MiniMe');
  }
}


async function regenerateMinime(req, res) {
  try {
    const userId = req.authData.id;

    const lastAny = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
    const faceRef = lastAny?.selfieUrl || null; 


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

    const rendered = await renderCurrentMinime(userId, { targetMinimeId: draft.id });

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
module.exports = {

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
