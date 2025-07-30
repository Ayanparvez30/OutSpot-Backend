const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');
const { hashPassword, comparePassword, randomKey, generateOTP } = require('../utils/helper');
const { OpenAI } = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const multer = require('multer');
const path = require('path');
const upload = multer({
  dest: 'uploads/',
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
      return cb(new Error('Only images are allowed'), false);
    }
    cb(null, true);
  }
});
const response = require('../functions/response');
require('dotenv').config();
const nodemailer = require('nodemailer');
const validBodyTypes = ['masculine', 'feminine'];


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

    // Update user profile with bodyShapeUrl instead of height/weight
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        firstName,
        lastName,
        bio,
        bodyType,
        bodyShapeUrl 
      },
    });

    return response.true_status(res, updatedUser, 'Profile saved');
  } catch (error) {
    console.error('Profile error:', error);
    return response.response_with_code(res, 500, 'Server error');
  }
};

exports.uploadAvatarWithMulter = async (req, res) => {
  try {
    const userId = req.authData.id;

    // 🟢 Handle premade URL only (no file)
    if (req.body.premadeUrl) {
      const premadeUrl = req.body.premadeUrl;
      if (!premadeUrl.startsWith('http')) {
        return response.response_with_code(res, 400, 'Invalid premade URL');
      }

      // Clear previous MiniMe
      await prisma.minime.deleteMany({ where: { userId } });

   const minime = await prisma.minime.create({
  data: {
    userId,
    avatarUrl: premadeUrl,
    isSaved: true  
  }
});


      return response.true_status(res, minime, 'MiniMe uploaded from premade URL');
    }

    // 🟡 Else: Handle file upload normally
    const file = req.files?.[0];
    if (!file) {
      return response.response_with_code(res, 400, 'No image uploaded');
    }

    const fileUrl = `/uploads/${file.filename}`;
    const fieldName = file.fieldname.toLowerCase();

    let avatarData = { userId };

    if (fieldName === 'selfie') {
      avatarData.selfieUrl = fileUrl;
    } else if (fieldName === 'avatar' || fieldName === 'premade') {
      avatarData.avatarUrl = fileUrl;
    } else {
      avatarData.avatarUrl = fileUrl;
    }

    await prisma.minime.deleteMany({ where: { userId } });

    const minime = await prisma.minime.create({ data: avatarData });

    return response.true_status(res, minime, 'MiniMe uploaded (field-detected)');
  } catch (err) {
    console.error('Upload error:', err);
    return response.response_with_code(res, 500, 'Upload failed');
  }
};
exports.generateMinime = async (req, res) => {
  try {
    const userId = req.authData.id;
    const {
      shirt, pant, shoes, glasses,
      lipstick, jewelry, bag
    } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.bodyShapeUrl) {
      return response.response_with_code(res, 400, 'Missing body shape');
    }

    const isFeminine = user.bodyType === 'feminine';

    const lastMini = await prisma.minime.findFirst({
      where: { userId, isSaved: true },
      orderBy: { createdAt: 'desc' }
    });

    const faceReference = lastMini?.selfieUrl || lastMini?.avatarUrl;
    if (!faceReference) return response.response_with_code(res, 400, 'No face reference available');

    // Clear previous draft
    await prisma.minime.deleteMany({ where: { userId, isSaved: false, isDraft: true } });

    const prompt = [
      "Create a full-body 3D cartoon avatar in Pixar-style with realistic soft textures.",
      `Use the provided body shape image: ${user.bodyShapeUrl}`,
      `Use the face reference image: ${faceReference}`,
      `- Shirt: ${shirt || 'none'}`,
      `- Pant: ${pant || 'none'}`,
      `- Shoes: ${shoes || 'none'}`,
      `- Glasses: ${glasses || 'none'}`,
      ...(isFeminine ? [
        `- Lipstick: ${lipstick || 'none'}`,
        `- Jewelry: ${jewelry || 'none'}`,
        `- Bag: ${bag || 'none'}`
      ] : []),
      "Pose reference: standing straight, front-facing, arms relaxed at sides.",
      "Add 10% padding below the feet to prevent cutoff.",
      "Use a clean white background."
    ].join('\n');

    const imageResponse = await openai.images.generate({ prompt, n: 1, size: "1024x1024" });

    const newMini = await prisma.minime.create({
      data: {
        userId,
        avatarUrl: imageResponse.data[0].url,
        selfieUrl: faceReference,
        shirt, pant, shoes, glasses,
        lipstick, jewelry, bag,
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

exports.regenerateMinime = async (req, res) => {
  try {
    const userId = req.authData.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    const draft = await prisma.minime.findFirst({
      where: { userId, isSaved: false, isDraft: true },
      orderBy: { createdAt: 'desc' }
    });

    if (!user || !draft) return response.response_with_code(res, 404, 'No draft MiniMe found');

    const isFeminine = user.bodyType === 'feminine';
    const faceReference = draft.selfieUrl;

    const expressions = ['natural face', 'slight smile', 'happy look'];
    const prompt = [
      "Full-body 3D cartoon avatar in Pixar style with soft textures and realistic proportions.",
      `Body: ${user.bodyShapeUrl}`,
      `Face: ${faceReference}`,
      `Clothes: shirt=${draft.shirt}, pant=${draft.pant}, shoes=${draft.shoes}, glasses=${draft.glasses}`,
      ...(isFeminine ? [`Extras: lipstick=${draft.lipstick}, jewelry=${draft.jewelry}, bag=${draft.bag}`] : []),
      `Expression: ${expressions[Math.floor(Math.random() * expressions.length)]}`
    ].join('\n');

    // Delete current draft
    await prisma.minime.delete({ where: { id: draft.id } });

    const imageResponse = await openai.images.generate({ prompt, n: 1, size: "1024x1024" });

    const newMini = await prisma.minime.create({
      data: {
        userId,
        avatarUrl: imageResponse.data[0].url,
        selfieUrl: faceReference,
        shirt: draft.shirt,
        pant: draft.pant,
        shoes: draft.shoes,
        glasses: draft.glasses,
        lipstick: draft.lipstick,
        jewelry: draft.jewelry,
        bag: draft.bag,
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

  const isFriend = await prisma.friendship.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: viewerId, receiverId: profileUserId },
        { requesterId: profileUserId, receiverId: viewerId }
      ]
    }
  });

  const user = await prisma.user.findUnique({
    where: { id: profileUserId },
    select: {
      id: true,
      username: true,
      firstName: true,
      lastName: true,
      bio: true,
      minime: { select: { avatarUrl: true } }
    }
  });

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (!isFriend && viewerId !== profileUserId) {
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
      isInVault: false
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

  const mediaUrl = `/uploads/${req.file.filename}`;

  try {
    const points = 5; // 🔁 You can make this dynamic later

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

    res.json({ message: `You received ${points} points!`, points });
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
  return 0; // Already maxed out
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
        minime: { select: { avatarUrl: true } }
      }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    return response.true_status(res, user, 'Profile loaded successfully');
  } catch (error) {
    console.error('Get profile error:', error);
    return response.response_with_code(res, 500, 'Failed to load profile');
  }
};