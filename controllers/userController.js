const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');
const { hashPassword, comparePassword, randomKey, generateOTP } = require('../utils/helper');
const { OpenAI } = require("openai");
const multer = require('multer');
const path = require('path');
const response = require('../functions/response');
require('dotenv').config();
const validBodyTypes = ['masculine', 'feminine'];
const uploadToS3 = require('../utils/s3Upload');

// Lazy import fetch for CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
      return cb(new Error('Only images are allowed'), false);
    }
    cb(null, true);
  }
});

// ================== UTILITY ==================
async function uploadToS3FromUrl(url, keyPrefix) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch image from ${url}`);

    const buffer = await res.arrayBuffer(); // fetch buffer from response
    const file = {
      originalname: `${keyPrefix}.png`,
      buffer: Buffer.from(buffer), // convert ArrayBuffer to Node Buffer
      mimetype: 'image/png',
    };

    return await uploadToS3(file, 'minimes');
  } catch (err) {
    console.error('uploadToS3FromUrl error:', err);
    throw err;
  }
}

// ================== PROFILE ==================
exports.saveProfile = async (req, res) => {
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
};

// ================== AVATAR UPLOAD ==================
exports.uploadAvatarWithMulter = async (req, res) => {
  try {
    const userId = req.authData.id;

    if (req.body.premadeUrl) {
      const premadeUrl = req.body.premadeUrl;
      if (!premadeUrl.startsWith('http')) {
        return response.response_with_code(res, 400, 'Invalid premade URL');
      }
      await prisma.minime.deleteMany({ where: { userId } });
      const minime = await prisma.minime.create({
        data: {
          userId,
          avatarUrl: premadeUrl,
          isSaved: false,
          isDraft: true
        }
      });
      return response.true_status(res, minime, 'MiniMe uploaded from premade URL');
    }

    const file = req.files?.[0];
    if (!file) return response.response_with_code(res, 400, 'No image uploaded');

    const s3Url = await uploadToS3(file, "avatars");

    const avatarData = { userId, isSaved: false, isDraft: true };
    if (file.fieldname.toLowerCase() === 'selfie') avatarData.selfieUrl = s3Url;
    else avatarData.avatarUrl = s3Url;

    await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

    const minime = await prisma.minime.create({ data: avatarData });

    return response.true_status(res, minime, 'MiniMe uploaded to S3');
  } catch (err) {
    console.error('Upload error:', err);
    return response.response_with_code(res, 500, 'Upload failed');
  }
};

exports.generateMinime = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { shirt, pant, shoes, glasses, lipstick, jewelry, bag } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.bodyShapeUrl) {
      return response.response_with_code(res, 400, 'Missing body shape');
    }

    const isFeminine = user.bodyType === 'feminine';

    const lastMini = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    const faceReference = lastMini?.selfieUrl || lastMini?.avatarUrl;
    if (!faceReference) return response.response_with_code(res, 400, 'No face reference available');

    await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

    const prompt = `
      Create a full-body 3D cartoon avatar in Pixar style.
      Body shape: ${user.bodyShapeUrl}
      Face: ${faceReference}
      Outfit:
        Shirt: ${shirt || 'none'}
        Pant: ${pant || 'none'}
        Shoes: ${shoes || 'none'}
        Glasses: ${glasses || 'none'}
      ${isFeminine ? `Lipstick: ${lipstick || 'none'}\nJewelry: ${jewelry || 'none'}\nBag: ${bag || 'none'}` : ''}
      Standing straight, front-facing, white background.
    `;

    const imageResponse = await openai.images.generate({
      // model: "gpt-image-1",
      prompt,
      size: "1024x1024"
    });

    const uploadedImageUrl = await uploadToS3FromUrl(
      imageResponse.data[0].url,
      `minime-${userId}-${Date.now()}`
    );

    const newMini = await prisma.minime.create({
      data: {
        userId,
        avatarUrl: uploadedImageUrl,
        selfieUrl: lastMini.selfieUrl,
        shirt, pant, shoes, glasses, lipstick, jewelry, bag,
        isSaved: false,
        isDraft: true
      }
    });

    return response.true_status(res, newMini, 'MiniMe draft generated');
  } catch (error) {
    console.error('generateMinime error:', error);
    return response.response_with_code(res, 500, 'Failed to generate MiniMe');
  }
};

// ================== REGENERATE MINIME ==================
exports.regenerateMinime = async (req, res) => {
  try {
    const userId = req.authData.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    const lastMini = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    if (!user || !lastMini) return response.response_with_code(res, 404, 'No MiniMe available');

    const isFeminine = user.bodyType === 'feminine';
    const expressions = ['natural face', 'slight smile', 'happy look'];

    const prompt = `
      Full-body 3D cartoon avatar in Pixar style.
      Body: ${user.bodyShapeUrl}
      Face: ${lastMini.selfieUrl || lastMini.avatarUrl}
      Clothes: shirt=${lastMini.shirt}, pant=${lastMini.pant}, shoes=${lastMini.shoes}, glasses=${lastMini.glasses}
      ${isFeminine ? `Lipstick=${lastMini.lipstick}, Jewelry=${lastMini.jewelry}, Bag=${lastMini.bag}` : ''}
      Expression: ${expressions[Math.floor(Math.random() * expressions.length)]}
      White background.
    `;

    await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

    const imageResponse = await openai.images.generate({
      // model: "gpt-image-1",
      prompt,
      size: "1024x1024"
    });

    const uploadedImageUrl = await uploadToS3FromUrl(
      imageResponse.data[0].url,
      `minime-${userId}-${Date.now()}`
    );

    const newMini = await prisma.minime.create({
      data: {
        userId,
        avatarUrl: uploadedImageUrl,
        selfieUrl: lastMini.selfieUrl,
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
};

// ================== SAVE LATEST MINIME ==================
exports.saveLatestMinime = async (req, res) => {
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
};


exports.getCurrentMinime = async (req, res) => {
  const userId = req.authData.id;
  const minime = await prisma.minime.findFirst({
    where: { userId, isSaved: true },
    orderBy: { createdAt: 'desc' }
  });

  if (!minime) return response.response_with_code(res, 404, 'No MiniMe found');
  return response.true_status(res, minime, 'Latest MiniMe');
};

exports.getMiniMeLocker = async (req, res) => {
  const userId = req.authData.id;
  const minis = await prisma.minime.findMany({
    where: { userId, isSaved: true },
    orderBy: { createdAt: 'desc' }
  });

  return res.json({ locker: minis });
};


exports.getUserProfile = async (req, res) => {
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
     minime: {
  select: { avatarUrl: true },
  where: { isSaved: true } 
}
    }
  });

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Friend check
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
    where: {
      userId: profileUserId,
      visibility: 'profile',
       NOT: { status: 'VAULT' }
    },
    orderBy: { createdAt: 'desc' }
  });

  return res.json({
    user,
    isPrivate: false,
    stories,
    message: 'Profile loaded successfully.'
  });
};

exports.getUserPoints = async (req, res) => {
  const targetUserId = parseInt(req.params.userId);

  try {
    const user = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, username: true, totalPoints: true }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get start of current week (Monday 00:00)
    const now = new Date();
    const day = now.getDay(); // Sunday = 0
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // adjust to Monday
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);
const challengeSubmissions = await prisma.submission.findMany({
  where: {
    userId: targetUserId,
    createdAt: { gte: weekStart }
  },
  include: { challenge: true }
});


    const challengePoints = challengeSubmissions.reduce(
      (sum, s) => sum + (s.challenge.points || 0),
      0
    );

    // 🟦 Points from location submissions this week
    const locationPoints = await prisma.locationPoint.findMany({
      where: {
        userId: targetUserId,
        createdAt: { gte: weekStart }
      }
    });

    const mapPoints = locationPoints.reduce((sum, p) => sum + (p.points || 0), 0);

    const thisWeekPoints = challengePoints + mapPoints;

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
};


exports.submitForPoints = async (req, res) => {
  const userId = req.authData.id;
  const { placeName, latitude, longitude } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No media uploaded' });

  try {
  
    const mediaUrl = await uploadToS3(req.file, "points");

    const points = 5; 

    await prisma.locationPoint.create({
      data: {
        userId,
        mediaUrl, 
        placeName,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        points
      }
    });

    await prisma.user.update({
      where: { id: userId },
      data: {
        totalPoints: { increment: points }
      }
    });

    res.json({ message: `You received ${points} points!`, points,mediaUrl });
  } catch (err) {
    console.error('Submit for points error:', err);
    res.status(500).json({ error: 'Submission failed', details: err.message });
  }
};

const getLevelFromPoints = (points) => {
  if (points >= 400) return { level: 20, title: "Legendary Explorer" };
  if (points >= 300) return { level: 19, title: "City Sniper" };
  if (points >= 250) return { level: 18, title: "City Sniper" };
  if (points >= 200) return { level: 15, title: "City Sniper" };
  if (points >= 150) return { level: 12, title: "City Sniper" };
  if (points >= 100) return { level: 10, title: "City Sniper" };
  if (points >= 75) return { level: 8, title: "Urban Explorer" };
  if (points >= 50) return { level: 6, title: "Urban Explorer" };
  if (points >= 25) return { level: 4, title: "New Explorer" };
  if (points >= 10) return { level: 2, title: "New Explorer" };
  return { level: 1, title: "New Explorer" };
};

const getPointsForNextLevel = (currentPoints) => {
  const thresholds = [0, 10, 25, 50, 75, 100, 150, 200, 250, 300, 400];
  for (let i = 0; i < thresholds.length; i++) {
    if (currentPoints < thresholds[i]) {
      return thresholds[i] - currentPoints;
    }
  }
  return 0; 
};
exports.getAchievementStatus = async (req, res) => {
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
};
exports.deleteAccount = async (req, res) => {
  const userId = req.authData.id;

  try {
    await prisma.user.delete({ where: { id: userId } });

    return res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
};
//get profile
exports.getProfile = async (req, res) => {
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
     minime: {
  select: { avatarUrl: true },
  where: { isSaved: true } 
}

      }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    return response.true_status(res, user, 'Profile loaded successfully');
  } catch (error) {
    console.error('Get profile error:', error);
    return response.response_with_code(res, 500, 'Failed to load profile');
  }
};
exports.updatePrivacy = async (req, res) => {
  const userId = req.authData.id;
  const { isPrivate } = req.body;

  await prisma.user.update({
    where: { id: userId },
    data: { isProfilePrivate: !!isPrivate }
  });

  res.json({ message: `Profile privacy set to ${!!isPrivate}` });
};
//update bio
exports.updateBio = async (req, res) => {
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
};

exports.updateName = async (req, res) => {
  const userId = req.authData.id;
  const { firstName, lastName } = req.body;

  if (!firstName && !lastName) {
    return response.response_with_code(res, 400, 'At least one of first name or last name is required');
  }

  const updateData = {};
  if (firstName) updateData.firstName = firstName;
  if (lastName) updateData.lastName = lastName;

  try {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData
    });

    return response.true_status(res, updatedUser, 'Name updated successfully');
  } catch (error) {
    console.error('Update name error:', error);
    return response.response_with_code(res, 500, 'Failed to update name');
  }
};
