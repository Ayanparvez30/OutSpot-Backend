
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const CREDIT = Number(process.env.REFERRAL_REWARD_POINTS || 50);
const { addPointsDirect } = require('../utils/points'); 

// referralController.js

exports.rewardForSharing = async (req, res) => {
  try {
    const userId = req.authData.id;

    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, referralCode: true, totalPoints: true },
    });

    if (!me) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // ❌ এখানে আর কোনো পয়েন্ট ক্রেডিট হবে না
    // ✅ পয়েন্ট শুধু তখনই যখন কোনো নতুন user signup/verify complete করবে

    return res.json({
      success: true,
      message: 'Invite link ready. You will earn points when your friend signs up using your link.',
      data: {
        totalPoints: me.totalPoints || 0,
        referralCode: me.referralCode || null,
      },
    });
  } catch (e) {
    console.error('rewardForSharing error:', e);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to prepare invite link' });
  }
};



exports.getInviteLink = async (req, res) => {
  return res.json({
    success: true,
    data: {
      code: null,
      shareUrl: `https://outspot.app/signup`,  
      deepLink: `outspot://signup`,
    },
  });
};


exports.getReferralSummary = async (req, res) => {
  const userId = req.authData.id;
  const [pending, rewarded] = await Promise.all([
    prisma.referral.count({ where: { inviterId: userId, status: 'PENDING' } }),
    prisma.referral.count({ where: { inviterId: userId, status: 'REWARDED' } }),
  ]);
  res.json({ success: true, data: { pending, rewarded } });
};
