// Map a place's Google signals to a base points value per the launch spec.
//
//   Google price_level   App label   Points
//   ──────────────────   ─────────   ──────
//   0  (free)             —          5..15  (scaled by user_ratings_total)
//   1  ($)                Low-cost   10
//   2  ($$)               Moderate   20
//   3  ($$$)              Expensive  35
//   4  ($$$$ / luxury)    Ultra      50
//   null/undefined        no data    5..15  (treated as free-ish)
//
// The free/no-data bucket uses review count as a proxy for popularity:
//   <100 reviews  →  5
//   <1000         → 10
//   ≥1000         → 15
//
// Pure function. No I/O. Easy to unit-test. Callers pass the values they
// already have on hand (validatePlaceDistance returns them now).

function pointsForPlace({ priceLevel, userRatingsTotal } = {}) {
  const reviews = Number(userRatingsTotal) || 0;
  const freeBucket = reviews >= 1000 ? 15 : reviews >= 100 ? 10 : 5;

  if (priceLevel == null) return freeBucket;       // no signal → popularity-based
  const lvl = Number(priceLevel);
  if (!Number.isFinite(lvl)) return freeBucket;

  switch (lvl) {
    case 0: return freeBucket;
    case 1: return 10;
    case 2: return 20;
    case 3: return 35;
    case 4: return 50;
    default: return freeBucket;
  }
}

module.exports = { pointsForPlace };
