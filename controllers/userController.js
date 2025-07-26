const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');
const { hashPassword, comparePassword, randomKey, generateOTP } = require('../utils/helper');
const { OpenAI } = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
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

exports.uploadAvatar = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { avatarUrl, selfieUrl } = req.body;

    let updateData = {};
    if (avatarUrl) updateData.avatarUrl = avatarUrl;
    if (selfieUrl) updateData.selfieUrl = selfieUrl;

    const minime = await prisma.minime.upsert({
      where: { userId },
      update: updateData,
      create: { userId, ...updateData },
    });

    return response.true_status(res, minime, 'Avatar uploaded');
  } catch (error) {
    console.error('Upload error:', error);
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

    const data = {
      shirt, pant, shoes, glasses,
      ...(isFeminine && { lipstick, jewelry, bag })
    };

    const minime = await prisma.minime.update({
      where: { userId },
      data
    });

    return response.true_status(res, minime, 'MiniMe options saved');
  } catch (error) {
    console.error('Save Minime error:', error);
    return response.response_with_code(res, 500, 'Failed to save Minime');
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
      // isInVault: false
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

exports.generateOrRegenerateMinime = async (req, res) => {
  try {
    const userId = req.authData.id;

    // Step 1: Fetch user and MiniMe data
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return response.response_with_code(res, 404, 'User not found');

    const minime = await prisma.minime.findUnique({ where: { userId } });
    if (!minime) return response.response_with_code(res, 400, 'MiniMe options not set yet');

    const isFeminine = user.bodyType === 'feminine';
    const bodyShapeUrl = user.bodyShapeUrl;

    if (!bodyShapeUrl) {
      return response.response_with_code(res, 400, "No reference image for this user's body shape");
    }

    // Step 2: Construct the prompt
    const promptParts = [
      "Create a cartoon-style full-body avatar.",
      `Base body shape image: ${bodyShapeUrl}`,
      `Face reference: ${minime.selfieUrl || minime.avatarUrl}`,
      "Outfit:",
      `- Shirt: ${minime.shirt || 'none'}`,
      `- Pant: ${minime.pant || 'none'}`,
      `- Shoes: ${minime.shoes || 'none'}`,
      `- Glasses: ${minime.glasses || 'none'}`,
    ];

    if (isFeminine) {
      promptParts.push(
        `- Lipstick: ${minime.lipstick || 'none'}`,
        `- Jewelry: ${minime.jewelry || 'none'}`,
        `- Bag: ${minime.bag || 'none'}`
      );
    }

    promptParts.push("Pose or gesture should be slightly different each time for uniqueness.");

    const finalPrompt = promptParts.join('\n');

    // Step 3: Generate image from OpenAI
    const imageResponse = await openai.images.generate({
      prompt: finalPrompt,
      n: 1,
      size: "512x512",
    });

    const generatedUrl = imageResponse.data[0].url;

    // Step 4: Save to database
    await prisma.minime.upsert({
      where: { userId },
      update: { avatarUrl: generatedUrl },
      create: {
        userId,
        avatarUrl: generatedUrl,
        shirt: minime.shirt,
        pant: minime.pant,
        shoes: minime.shoes,
        glasses: minime.glasses,
        selfieUrl: minime.selfieUrl,
        ...(isFeminine && {
          lipstick: minime.lipstick,
          jewelry: minime.jewelry,
          bag: minime.bag,
        }),
      },
    });

    return response.true_status(res, { avatarUrl: generatedUrl }, 'MiniMe generated successfully');
  } catch (error) {
    console.error('Generate/Regenerate MiniMe error:', error);
    return response.response_with_code(res, 500, 'Failed to generate MiniMe');
  }
};