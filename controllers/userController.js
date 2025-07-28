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

    const file = req.files?.[0]; // ✅ handle any field
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
      // default fallback if fieldname is unknown
      avatarData.avatarUrl = fileUrl;
    }

    // Clear previous MiniMe (single record per user)
    await prisma.minime.deleteMany({ where: { userId } });

    const minime = await prisma.minime.create({ data: avatarData });

    return response.true_status(res, minime, 'MiniMe uploaded (field-detected)');
  } catch (err) {
    console.error('Upload error:', err);
    return response.response_with_code(res, 500, 'Upload failed');
  }
};
exports.saveMinimeOptions = async (req, res) => {
  try {
    const userId = req.authData.id;
    const {
      shirt, pant, shoes, glasses,
      lipstick, jewelry, bag
    } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return response.response_with_code(res, 404, 'User not found');

    const isFeminine = user.bodyType === 'feminine';
    const bodyShapeUrl = user.bodyShapeUrl;

    const latestMini = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    const faceReference = latestMini?.selfieUrl || latestMini?.avatarUrl;

    if (!bodyShapeUrl || !faceReference) {
      return response.response_with_code(res, 400, 'Missing body shape or face reference');
    }

    const prompt = [
      "Generate a high-quality Pixar-style 3D avatar with detailed clothing and soft lighting.",
      `Base Body: ${bodyShapeUrl}`,
      `Face Image: ${faceReference}`,
      "Outfit includes:",
      `- Shirt: ${shirt || 'none'}`,
      `- Pant: ${pant || 'none'}`,
      `- Shoes: ${shoes || 'none'}`,
      `- Glasses: ${glasses || 'none'}`,
      ...(isFeminine ? [
        `- Lipstick: ${lipstick || 'none'}`,
        `- Jewelry: ${jewelry || 'none'}`,
        `- Bag: ${bag || 'none'}`
      ] : []),
      "Visual specs:",
      "Full body visible, plain white background, crisp rendering, front-facing, clear eyes, expressive and vibrant facial details."
    ].join('\n');

    const imageResponse = await openai.images.generate({
      prompt,
      n: 1,
      size: "512x512",
    });

    const generatedUrl = imageResponse.data[0].url;

    const newMini = await prisma.minime.create({
      data: {
        userId,
        avatarUrl: generatedUrl,
        selfieUrl: latestMini?.selfieUrl || null,
        shirt, pant, shoes, glasses,
        ...(isFeminine && { lipstick, jewelry, bag })
      }
    });

    return response.true_status(res, newMini, 'MiniMe created with updated style and clothes');
  } catch (error) {
    console.error('saveMinimeOptions error:', error);
    return response.response_with_code(res, 500, 'MiniMe generation failed');
  }
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
exports.RegenerateMinime = async (req, res) => {
  try {
    const userId = req.authData.id;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const lastMini = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    if (!user || !lastMini) return response.response_with_code(res, 404, 'MiniMe data missing');

    const isFeminine = user.bodyType === 'feminine';
    const faceReference = lastMini.selfieUrl || lastMini.avatarUrl;

    if (!user.bodyShapeUrl || !faceReference) {
      return response.response_with_code(res, 400, 'Missing body or face data');
    }

    // 👇 Random facial expression (used in prompt only)
    const expressions = [
      'gentle smile',
      'neutral face',
      'subtle smirk',
      'slightly raised eyebrows',
      'happy expression',
      'soft eyes with slight blush'
    ];
    const randomExpression = expressions[Math.floor(Math.random() * expressions.length)];

    const prompt = [
      "Generate a single 3D cartoon avatar with Pixar-like detail.",
      `Body shape image: ${user.bodyShapeUrl}`,
      `Face reference: ${faceReference}`,
      "Clothing:",
      `- Shirt: ${lastMini.shirt || 'none'}`,
      `- Pant: ${lastMini.pant || 'none'}`,
      `- Shoes: ${lastMini.shoes || 'none'}`,
      `- Glasses: ${lastMini.glasses || 'none'}`,
      ...(isFeminine ? [
        `- Lipstick: ${lastMini.lipstick || 'none'}`,
        `- Jewelry: ${lastMini.jewelry || 'none'}`,
        `- Bag: ${lastMini.bag || 'none'}`
      ] : []),
      "Visual specs:",
      "Full body, centered, white background.",
      `Facial expression: ${randomExpression}.`,
      "High-resolution, front-facing, expressive eyes, smooth lighting."
    ].join('\n');

    const imageResponse = await openai.images.generate({
      prompt,
      n: 1,
      size: "512x512",
    });

    const regeneratedUrl = imageResponse.data[0].url;

    await prisma.minime.delete({ where: { id: lastMini.id } });

    const newMini = await prisma.minime.create({
      data: {
        userId,
        avatarUrl: regeneratedUrl,
        selfieUrl: lastMini.selfieUrl,
        shirt: lastMini.shirt,
        pant: lastMini.pant,
        shoes: lastMini.shoes,
        glasses: lastMini.glasses,
        ...(isFeminine && {
          lipstick: lastMini.lipstick,
          jewelry: lastMini.jewelry,
          bag: lastMini.bag
        })
      }
    });

    return response.true_status(res, { avatarUrl: regeneratedUrl }, 'MiniMe successfully regenerated');
  } catch (error) {
    console.error('RegenerateMinime error:', error);
    return response.response_with_code(res, 500, 'MiniMe regeneration failed');
  }
};



exports.getMiniMeLocker = async (req, res) => {
  const userId = req.authData.id;
  const locker = await prisma.minime.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' }
  });

  res.json({ locker });
};
exports.getCurrentMinime = async (req, res) => {
  try {
    const userId = req.authData.id;

    const minime = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    if (!minime) {
      return response.response_with_code(res, 404, 'No MiniMe found');
    }

    return response.true_status(res, minime, 'Current MiniMe fetched');
  } catch (error) {
    console.error('Get current MiniMe error:', error);
    return response.response_with_code(res, 500, 'Failed to get current MiniMe');
  }
};
