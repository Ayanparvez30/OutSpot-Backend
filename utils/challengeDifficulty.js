// Difficulty → recommended points map per the launch spec.
//
//   EASY        → 10
//   MEDIUM      → 15
//   HARD        → 20
//   MULTI_STEP  → 25
//
// Helper is read-only. It does NOT mutate Challenge.points by itself —
// admin/seed code calls this when they want a sensible default. Once a
// challenge row exists, `points` is the source of truth for awards.

const DIFFICULTY_POINTS = Object.freeze({
  EASY: 10,
  MEDIUM: 15,
  HARD: 20,
  MULTI_STEP: 25,
});

function pointsForDifficulty(difficulty) {
  if (difficulty == null) return null;
  const key = String(difficulty).toUpperCase();
  return Object.prototype.hasOwnProperty.call(DIFFICULTY_POINTS, key)
    ? DIFFICULTY_POINTS[key]
    : null;
}

// Useful inverse — given a points value, infer the closest difficulty bucket.
// Returns null for values that don't match any bucket exactly.
function difficultyForPoints(points) {
  const n = Number(points);
  if (!Number.isFinite(n)) return null;
  for (const [k, v] of Object.entries(DIFFICULTY_POINTS)) {
    if (v === n) return k;
  }
  return null;
}

module.exports = { DIFFICULTY_POINTS, pointsForDifficulty, difficultyForPoints };
