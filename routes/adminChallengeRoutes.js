// routes/adminChallengeRoutes.js
const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { checkAuth } = require('../middlewares/authMiddleware');
const requireAdmin = require('../middlewares/requireAdmin');
const { getAssignedChallenge, resolveZone } = require('../utils/challenges');
const { pointsForDifficulty } = require('../utils/challengeDifficulty');
// CREATE
router.post('/admin/challenges', checkAuth, requireAdmin, async (req, res) => {
  try {
    const rawFreq = String(req.body.frequency || 'DAILY').toUpperCase();
    const frequency = rawFreq === 'WEEKLY' ? 'WEEKLY' : 'DAILY';
    const tier  = req.body.tier || (frequency === 'WEEKLY' ? 'GOLD' : 'SILVER');

    // Difficulty → points: EASY 10 / MEDIUM 15 / HARD 20 / MULTI_STEP 25.
    // Explicit body.points always wins; otherwise difficulty sets it; else
    // fall back to the frequency default.
    const difficulty = req.body.difficulty ? String(req.body.difficulty).toUpperCase() : null;
    const diffPoints = pointsForDifficulty(difficulty); // null if absent/invalid
    const points = req.body.points != null
      ? parseInt(req.body.points, 10)
      : (diffPoints != null ? diffPoints : (frequency === 'WEEKLY' ? 50 : 10));
    const requiredPhotos = parseInt(req.body.requiredPhotos ?? 1, 10);

    const created = await prisma.challenge.create({
      data: {
        title: req.body.title,
        description: req.body.description,
        type: req.body.type || null,
        frequency,
        tier,
        points,
        requiredPhotos,
        difficulty: diffPoints != null ? difficulty : null, // store only valid enum values
      },
    });
    res.json(created);
  } catch (e) {
    res.status(400).json({ error: 'Create failed', details: e.message });
  }
});

// UPDATE
router.put('/admin/challenges/:id', checkAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const data = {
      title: req.body.title,
      description: req.body.description,
      type: req.body.type,
      tier: req.body.tier,
      points: req.body.points != null ? parseInt(req.body.points, 10) : undefined,
      requiredPhotos: req.body.requiredPhotos != null ? parseInt(req.body.requiredPhotos, 10) : undefined,
    };

    // Difficulty change → store it and, unless points are explicitly set,
    // realign points to the difficulty (EASY 10/MEDIUM 15/HARD 20/MULTI_STEP 25).
    if (req.body.difficulty != null) {
      const difficulty = String(req.body.difficulty).toUpperCase();
      const diffPoints = pointsForDifficulty(difficulty);
      if (diffPoints != null) {
        data.difficulty = difficulty;
        if (req.body.points == null) data.points = diffPoints;
      }
    }
    if (req.body.frequency) {
      const rawFreq = String(req.body.frequency).toUpperCase();
      data.frequency = rawFreq === 'WEEKLY' ? 'WEEKLY' : 'DAILY';
      if (!req.body.tier) data.tier = data.frequency === 'WEEKLY' ? 'GOLD' : 'SILVER';
    }

    const updated = await prisma.challenge.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: 'Update failed', details: e.message });
  }
});

// DELETE
router.delete('/admin/challenges/:id', checkAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await prisma.challenge.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'Delete failed', details: e.message });
  }
});

// LIST
router.get('/admin/challenges', checkAuth, requireAdmin, async (req, res) => {
  const items = await prisma.challenge.findMany({ orderBy: [{ frequency: 'asc' }, { id: 'asc' }] });
  res.json(items);
});

// PREVIEW: কোন user/date এ কী assign হবে
router.get('/admin/challenges/preview', checkAuth, requireAdmin, async (req, res) => {
  const userId = parseInt(req.query.userId, 10);
  const frequency = String(req.query.frequency || 'DAILY').toUpperCase();
  const zone = req.query.zone || resolveZone(null);
  const date = req.query.date ? new Date(`${req.query.date}T12:00:00Z`) : new Date();

  if (!userId || !['DAILY','WEEKLY'].includes(frequency)) {
    return res.status(400).json({ error: 'userId and frequency required' });
    }
  const { challenge, windowKey } = await getAssignedChallenge(prisma, userId, frequency, zone, date);
  res.json({ userId, frequency, zone, date: req.query.date || 'today', windowKey, assigned: challenge });
});

module.exports = router;
