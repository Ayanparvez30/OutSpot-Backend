// controllers/referralController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const REFERRAL_REWARD = Number(process.env.REFERRAL_REWARD_POINTS || 50);

// GET /referrals/link
exports.getInviteLink = async (req, res) => {
  const userId = req.authData.id;
  let user = await prisma.user.findUnique({ where: { id: userId } });
  // স্কিমায় referralCode already unique + default(cuid()) আছে, তাই শুধু রিটার্ন
  const code = user.referralCode;
  return res.json({
    success: true,
    data: {
      code,
      shareUrl: `https://outspot.app/signup?ref=${code}`,
      deepLink: `outspot://signup?ref=${code}`,
    },
  });
};

// GET /referrals/summary
exports.getReferralSummary = async (req, res) => {
  const userId = req.authData.id;
  const [pending, rewarded] = await Promise.all([
    prisma.referral.count({ where: { inviterId: userId, status: 'PENDING' } }),
    prisma.referral.count({ where: { inviterId: userId, status: 'REWARDED' } }),
  ]);
  res.json({ success: true, data: { pending, rewarded } });
};

// POST /referrals/attach  (late attach; reward নয়, শুধু PENDING)
exports.attachReferralIfAny = async (req, res) => {
  const { inviteeId, referralCode } = req.body;
  if (!inviteeId || !referralCode) return res.status(400).json({ success: false, message: 'inviteeId and referralCode required' });

  const inviter = await prisma.user.findUnique({ where: { referralCode } });
  if (!inviter) return res.status(404).json({ success: false, message: 'Invalid code' });
  if (inviter.id === inviteeId) return res.status(400).json({ success: false, message: 'Self referral not allowed' });

  const exists = await prisma.referral.findFirst({ where: { inviteeId } });
  if (exists) return res.json({ success: true, message: 'Referral already recorded for this invitee' });

  await prisma.referral.create({ data: { inviterId: inviter.id, inviteeId, status: 'PENDING' } });
  return res.json({ success: true, message: 'Referral attached. Will reward on verification.' });
};
