
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const CREDIT = Number(process.env.REFERRAL_REWARD_POINTS || 50);
const { addPointsDirect } = require('../utils/points'); 

exports.rewardForSharing = async (req, res) => {
  try {
    const userId = req.authData.id;


    const { finalPoints } = await addPointsDirect(userId, CREDIT, 'REFERRAL_SHARE', null, prisma);

  
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { totalPoints: true } });

    return res.json({
      success: true,
      message: `+${finalPoints} points for sharing`,
      data: { credited: finalPoints, totalPoints: u.totalPoints }
    });
  } catch (e) {
    console.error('rewardForSharing error:', e);
    return res.status(500).json({ success: false, message: 'Failed to credit share reward' });
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
