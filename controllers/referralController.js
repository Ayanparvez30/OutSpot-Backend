// controllers/referralController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const CREDIT = Number(process.env.REFERRAL_REWARD_POINTS || 50);
const { addPointsDirect } = require('../utils/points'); // ✅ use direct (no multiplier)

exports.rewardForSharing = async (req, res) => {
  try {
    const userId = req.authData.id;

    // (ঐচ্ছিক) ডাবল-ট্যাপ রোধ করতে “once per day” থ্রটল চাইলে আনকমেন্ট করুন
    // const today = new Date(); today.setHours(0,0,0,0);
    // const already = await prisma.pointsLedger.findFirst({
    //   where: { userId, reason: 'REFERRAL_SHARE', createdAt: { gte: today } },
    //   select: { id: true }
    // });
    // if (already) return res.json({ success: true, message: 'Already credited today', data: {} });

    // ✅ একেবারে ফ্ল্যাট পয়েন্ট—multiplier ছাড়াই
    const { finalPoints } = await addPointsDirect(userId, CREDIT, 'REFERRAL_SHARE', null, prisma);

    // টোটাল এখন ইউটিলিটিই increment করেছে; চাইলে রিড-ব্যাক করে পাঠাতে পারেন:
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


// GET /referrals/link  -> এখন কোড ছাড়াই জেনেরিক লিংক
exports.getInviteLink = async (req, res) => {
  return res.json({
    success: true,
    data: {
      code: null, // backward-compat রাখলাম; এখন ব্যবহার হচ্ছে না
      shareUrl: `https://outspot.app/signup`,   // ref কোড ছাড়া
      deepLink: `outspot://signup`,
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

// // POST /referrals/attach  (late attach; reward নয়, শুধু PENDING)
// exports.attachReferralIfAny = async (req, res) => {
//   const { inviteeId, referralCode } = req.body;
//   if (!inviteeId || !referralCode) return res.status(400).json({ success: false, message: 'inviteeId and referralCode required' });

//   const inviter = await prisma.user.findUnique({ where: { referralCode } });
//   if (!inviter) return res.status(404).json({ success: false, message: 'Invalid code' });
//   if (inviter.id === inviteeId) return res.status(400).json({ success: false, message: 'Self referral not allowed' });

//   const exists = await prisma.referral.findFirst({ where: { inviteeId } });
//   if (exists) return res.json({ success: true, message: 'Referral already recorded for this invitee' });

//   await prisma.referral.create({ data: { inviterId: inviter.id, inviteeId, status: 'PENDING' } });
//   return res.json({ success: true, message: 'Referral attached. Will reward on verification.' });
// };
