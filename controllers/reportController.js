const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.reportUser = async (req, res) => {
  const reportedId = req.body.reportedId;
  const reporterId = req.authData.id; // Get the authenticated user's ID
  // New (optional, additive). Old clients that don't send these still work.
  const { reason, note } = req.body || {};

  if (!reportedId) {
    return res.status(400).json({ error: 'Reported user ID is required' });
  }

  try {
    // Create a new report record. Report.type defaults to "user" via the
    // column default — existing clients keep working with zero change.
    const report = await prisma.report.create({
      data: {
        reporterId,
        reportedId: parseInt(reportedId, 10),
        status: 'PENDING',  // Default status
        // Only forward optional fields when the client supplied them.
        ...(reason ? { reason: String(reason).slice(0, 191) } : {}),
        ...(note   ? { note:   String(note).slice(0, 10000) } : {}),
      },
    });

    return res.status(201).json({
      message: 'User reported successfully',
    });
  } catch (error) {
    console.error('Error reporting user:', error);
    return res.status(500).json({ error: 'Failed to report user' });
  }
};
