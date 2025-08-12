const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const uploadToS3 = require('../utils/s3Upload'); 
exports.createChallenge = async (req, res) => {
  const { title, description, type, startDate, endDate, points, requiredPhotos } = req.body;

  try {
    const challenge = await prisma.challenge.create({
      data: {
        title,
        description,
        type,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        points: parseInt(points),
        requiredPhotos: parseInt(requiredPhotos) || 1  // default fallback
      }
    });
    res.json(challenge);
  } catch (err) {
    console.error('Create Challenge Error:', err);
    res.status(500).json({ error: 'Failed to create challenge' });
  }
};

// exports.getActiveChallenges = async (req, res) => {
//   const now = new Date();
//   try {
//     const challenges = await prisma.challenge.findMany({
//       where: {
//         startDate: { lte: now },
//         endDate: { gte: now }
//       },
//       orderBy: { startDate: 'asc' }
//     });
//     res.json(challenges);
//   } catch (err) {
//     res.status(500).json({ error: 'Failed to fetch challenges' });
//   }
// };
exports.getFilteredChallenges = async (req, res) => {
  const userId = req.authData.id;
  const now = new Date();
  const status = req.query.status || 'all';

  const allChallenges = await prisma.challenge.findMany({
    orderBy: { startDate: 'desc' }
  });

  const result = await Promise.all(
    allChallenges.map(async (c) => {
      const submissions = await prisma.submission.findMany({
        where: { userId, challengeId: c.id }
      });

      const requiredCount = c.requiredPhotos || 1;
      const uploadedCount = submissions.length;
      const isCompleted = uploadedCount >= requiredCount;
      const isActive = c.startDate <= now && c.endDate >= now;

      const derivedStatus = isCompleted
        ? 'completed'
        : uploadedCount > 0
          ? 'in_progress'
          : isActive
            ? 'in_progress'
            : 'expired';

      return {
        ...c,
        status: derivedStatus,
        uploadedCount,
        requiredCount,
        hasSubmitted: uploadedCount > 0
      };
    })
  );

  let filtered;
  if (status === 'completed') {
    filtered = result.filter(r => r.status === 'completed');
  } else if (status === 'in_progress') {
    filtered = result.filter(r => r.status === 'in_progress');
  } else {
    filtered = result;
  }

  res.json(filtered);
};


exports.submitToChallenge = async (req, res) => {
  const userId = req.authData.id;
  const { challengeId } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No media uploaded' });

  try {
    // Upload buffer to S3 (assuming uploadToS3 accepts multer file object)
    const s3Url = await uploadToS3(req.file, 'challenge-submissions');

    const challenge = await prisma.challenge.findUnique({
      where: { id: parseInt(challengeId) }
    });

    if (!challenge) return res.status(404).json({ error: 'Challenge not found' });

    const requiredCount = challenge.requiredPhotos || 1;

    // Check existing submissions count
    const existingSubmissions = await prisma.submission.findMany({
      where: { userId, challengeId: parseInt(challengeId) }
    });

    if (existingSubmissions.length >= requiredCount) {
      return res.status(409).json({ error: 'Challenge already completed' });
    }

    // Create new submission with S3 URL
    const submission = await prisma.submission.create({
      data: {
        userId,
        challengeId: challenge.id,
        mediaUrl: s3Url
      }
    });

    // Award points
    await prisma.user.update({
      where: { id: userId },
      data: {
        totalPoints: {
          increment: challenge.points
        }
      }
    });

    const updatedSubmissions = [...existingSubmissions, submission];

    res.json({
      message: 'Submission saved',
      submission,
      uploadedCount: updatedSubmissions.length,
      requiredCount,
      isCompleted: updatedSubmissions.length >= requiredCount
    });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Failed to submit', details: err.message });
  }
};
exports.getSubmissions = async (req, res) => {
  const { challengeId } = req.params;
  const userId = req.authData.id;

  const others = await prisma.submission.findMany({
    where: {
      challengeId: parseInt(challengeId),
      NOT: { userId }
    },
    include: {
      user: {
        select: { id: true, username: true, minime: { select: { avatarUrl: true } } }
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  res.json(others);
};
exports.getMySubmission = async (req, res) => {
  const userId = req.authData.id;
  const { challengeId } = req.params;

 const submissions = await prisma.submission.findMany({
  where: { userId, challengeId: parseInt(challengeId) },
  orderBy: { createdAt: 'asc' }
});

if (!submissions.length) return res.status(404).json({ message: 'No submissions found' });

res.json(submissions);

 
};
