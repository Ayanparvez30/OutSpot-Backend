const { details } = require('./googlePlaces');

const toRad = d => (d * Math.PI) / 180;
const haversineMeters = (a, b) => {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const A = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(A));
};
const metersToMiles = (m) => +(m / 1609.344).toFixed(2);

// Verify user GPS is at-or-very-near a Google place. Returns:
//   { ok: true,  distMeters, placeName, placeLat, placeLng }                       — within radius OR inside viewport
//   { ok: false, reason, distMeters?, message, maxMeters, placeName?, placeLat?, placeLng? }
async function validatePlaceDistance({ placeId, userLat, userLng, maxMeters }) {
  if (!placeId || typeof placeId !== 'string' || placeId.trim().length < 5) {
    return { ok: false, reason: 'invalid-placeId', message: 'placeId required to validate location' };
  }

  let d;
  try {
    d = await details(placeId.trim());
  } catch (e) {
    return { ok: false, reason: 'google-fetch-failed', message: 'Failed to verify placeId via Google Places' };
  }

  const placeLat = d?.geometry?.location?.lat;
  const placeLng = d?.geometry?.location?.lng;
  const viewport = d?.geometry?.viewport || null;
  const placeName = d?.name || null;

  if (!Number.isFinite(placeLat) || !Number.isFinite(placeLng)) {
    return { ok: false, reason: 'invalid-place-geometry', message: 'Invalid placeId (no geometry)' };
  }

  const dist = haversineMeters({ lat: userLat, lng: userLng }, { lat: placeLat, lng: placeLng });

  // Accept if user is inside Google's viewport rectangle (large venues — stadiums,
  // malls, parks — where the center pin can be 100+ m from any actual edge).
  const insideViewport = viewport &&
    userLat >= viewport.southwest.lat && userLat <= viewport.northeast.lat &&
    userLng >= viewport.southwest.lng && userLng <= viewport.northeast.lng;

  if (insideViewport || dist <= maxMeters) {
    // Pass through Google's price + popularity signals so the caller can
    // compute the points award without making a second details() call.
    return {
      ok: true,
      distMeters: dist,
      placeName, placeLat, placeLng,
      priceLevel: d?.price_level ?? null,        // 0..4 (legacy ints from googlePlaces mapping)
      userRatingsTotal: d?.user_ratings_total ?? null,
      rating: d?.rating ?? null,
    };
  }

  const rounded = Math.round(dist);
  return {
    ok: false,
    reason: 'too-far-from-place',
    distMeters: rounded,
    maxMeters,
    placeName,
    placeLat,
    placeLng,
    message: `You need to be within ${maxMeters}m of this place. You are currently ${rounded}m away.`,
    viewportPresent: !!viewport,
  };
}

module.exports = { validatePlaceDistance, haversineMeters, metersToMiles };
