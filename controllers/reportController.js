const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.reportUser = async (req, res) => {
  const reportedId = req.body.reportedId;
  const reporterId = req.authData.id; // Get the authenticated user's ID

  if (!reportedId) {
    return res.status(400).json({ error: 'Reported user ID is required' });
  }

  try {
    // Create a new report record
    const report = await prisma.report.create({
      data: {
        reporterId,
        reportedId,
        status: 'PENDING',  // Default status
      },
    });

    // Optionally, you could increment a report count or perform other actions here

    return res.status(201).json({
      message: 'User reported successfully',
      
    });
  } catch (error) {
    console.error('Error reporting user:', error);
    return res.status(500).json({ error: 'Failed to report user' });
  }
};
