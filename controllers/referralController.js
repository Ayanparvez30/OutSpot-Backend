
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const CREDIT = Number(process.env.REFERRAL_REWARD_POINTS || 50);
const { addPointsDirect } = require('../utils/points'); 
exports.rewardForSharing = async (req, res) => {
  try {
    const userId = req.authData.id;

    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, totalPoints: true },
    });

    if (!me) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const code = (me.username || '').trim();
    if (!code) {
      return res.status(400).json({ success: false, message: 'Username not set. Please set a username first.' });
    }

    const webBase = process.env.APP_SHARE_BASE || 'https://outspot.app/signup';
    const deepBase = process.env.APP_DEEP_LINK || 'outspot://signup';

    const shareUrl = `${webBase}?ref=${encodeURIComponent(code)}`;
    const deepLink = `${deepBase}?ref=${encodeURIComponent(code)}`;

    return res.json({
      success: true,
      message: 'Invite link ready. You will earn points when your friend signs up using your link.',
      data: {
        totalPoints: me.totalPoints || 0,
        referralCode: code, // ✅ username
        shareUrl,
        deepLink,
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
  const userId = req.authData.id;

  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true },
  });

  const code = (me?.username || '').trim() || null;

  const webBase = process.env.APP_SHARE_BASE || 'https://outspot.app/signup';
  const deepBase = process.env.APP_DEEP_LINK || 'outspot://signup';

  const shareUrl = code ? `${webBase}?ref=${encodeURIComponent(code)}` : `${webBase}`;
  const deepLink = code ? `${deepBase}?ref=${encodeURIComponent(code)}` : `${deepBase}`;

  return res.json({
    success: true,
    data: {
      code,        // ✅ username
      shareUrl,    // ✅ includes ref
      deepLink,    // ✅ includes ref
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
