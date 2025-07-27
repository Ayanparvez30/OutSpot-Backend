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

    // Ensure selfie or avatar exists before proceeding
    const latestMini = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    const faceReference = latestMini?.selfieUrl || latestMini?.avatarUrl;

    if (!bodyShapeUrl || !faceReference) {
      return response.response_with_code(res, 400, 'Missing body shape or face reference for regeneration');
    }

    const prompt = [
      "Create a single cartoon-style full-body avatar of a human character.",
      `Base body shape image: ${bodyShapeUrl}`,
      `Face reference: ${faceReference}`,
      "Clothing:",
      `- Shirt: ${shirt || 'none'}`,
      `- Pant: ${pant || 'none'}`,
      `- Shoes: ${shoes || 'none'}`,
      `- Glasses: ${glasses || 'none'}`,
      ...(isFeminine ? [
        `- Lipstick: ${lipstick || 'none'}`,
        `- Jewelry: ${jewelry || 'none'}`,
        `- Bag: ${bag || 'none'}`
      ] : []),
      "Use a plain white background. Only show one character, centered in the image.",
      "Style: Pixar-like, 3D rendered, soft facial features, clear eyes, expressive face, front-facing. High quality lighting."
    ].join('\n');

    const imageResponse = await openai.images.generate({
      prompt,
      n: 1,
      size: "512x512",
    });

    const generatedUrl = imageResponse.data[0].url;

    // Create a new MiniMe entry instead of updating existing
    const newMini = await prisma.minime.create({
      data: {
        userId,
        avatarUrl: generatedUrl,
        selfieUrl: latestMini?.selfieUrl || null,
        shirt, pant, shoes, glasses,
        ...(isFeminine && { lipstick, jewelry, bag })
      }
    });

    return response.true_status(res, newMini, 'MiniMe saved and regenerated');
  } catch (error) {
    console.error('Save Minime error:', error);
    return response.response_with_code(res, 500, 'Failed to save and regenerate MiniMe');
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
    if (!user) return response.response_with_code(res, 404, 'User not found');

    const minime = await prisma.minime.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
    if (!minime) return response.response_with_code(res, 400, 'MiniMe options not set yet');

    const isFeminine = user.bodyType === 'feminine';
    const bodyShapeUrl = user.bodyShapeUrl;
    const faceReference = minime.selfieUrl || minime.avatarUrl;

    if (!bodyShapeUrl || !faceReference) {
      return response.response_with_code(res, 400, 'Missing body shape or face reference. Please upload a selfie or avatar.');
    }

const prompt = [
  "Create a single cartoon-style full-body avatar of a human character.",
  `Base body shape image: ${bodyShapeUrl}`,
  `Face reference: ${faceReference}`,
  "Clothing:",
  `- Shirt: ${minime.shirt || 'none'}`,
  `- Pant: ${minime.pant || 'none'}`,
  `- Shoes: ${minime.shoes || 'none'}`,
  `- Glasses: ${minime.glasses || 'none'}`,
  ...(isFeminine ? [
    `- Lipstick: ${minime.lipstick || 'none'}`,
    `- Jewelry: ${minime.jewelry || 'none'}`,
    `- Bag: ${minime.bag || 'none'}`
  ] : []),
  "Use a plain white background. Only show one character, centered in the image.",
  "Style: Pixar-like, 3D rendered, soft facial features, clear eyes, expressive face, front-facing. High quality lighting."
].join('\n');


    const imageResponse = await openai.images.generate({
      prompt,
      n: 1,
      size: "512x512",
    });

    const generatedUrl = imageResponse.data[0].url;

    if (minime) {
      await prisma.minime.delete({ where: { id: minime.id } });
    }

    const newMini = await prisma.minime.create({
      data: {
        userId,
        avatarUrl: generatedUrl,
        selfieUrl: minime.selfieUrl,
        shirt: minime.shirt,
        pant: minime.pant,
        shoes: minime.shoes,
        glasses: minime.glasses,
        ...(isFeminine && {
          lipstick: minime.lipstick,
          jewelry: minime.jewelry,
          bag: minime.bag
        })
      }
    });

    return response.true_status(res, { avatarUrl: generatedUrl }, 'MiniMe regenerated and saved');
  } catch (error) {
    console.error('MiniMe generation error:', error);
    return response.response_with_code(res, 500, 'Failed to regenerate MiniMe');
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
