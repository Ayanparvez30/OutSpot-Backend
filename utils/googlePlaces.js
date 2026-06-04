// utils/googlePlaces.js
// Migrated to Places API (New) v1. External call signatures + return shapes
// preserved as legacy schema so all callers in controllers/* remain unchanged.

const NEW_BASE = 'https://places.googleapis.com/v1';
const LEGACY_BASE = 'https://maps.googleapis.com/maps/api/place';

// Field mask for searchNearby / searchText — must list every nested field caller depends on.
const SEARCH_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.location',
  'places.viewport',
  'places.types',
  'places.primaryType',
  'places.photos',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.businessStatus',
  'places.regularOpeningHours',
  'places.currentOpeningHours',
].join(',');

// Field mask for details (single place) — no `places.` prefix on the v1 single-resource endpoint.
const DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'shortFormattedAddress',
  'location',
  'viewport',
  'types',
  'primaryType',
  'photos',
  'rating',
  'userRatingCount',
  'priceLevel',
  'businessStatus',
  'regularOpeningHours',
  'currentOpeningHours',
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'websiteUri',
  'googleMapsUri',
  'editorialSummary',
  'reviews',
  'servesBeer',
  'servesBreakfast',
  'servesBrunch',
  'servesDinner',
  'servesLunch',
  'servesWine',
  'servesCocktails',
  'servesCoffee',
  'servesDessert',
  'servesVegetarianFood',
  'takeout',
  'delivery',
  'dineIn',
  'reservable',
  'accessibilityOptions',
].join(',');

// Convert new v1 priceLevel enum to legacy 0-4 integer.
function priceLevelToLegacy(enumStr) {
  if (!enumStr) return null;
  const map = {
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4,
  };
  return map[enumStr] ?? null;
}

// Map a Places API (New) v1 place object into the legacy schema callers expect.
function mapNewToLegacy(p) {
  if (!p) return null;

  const photos = (p.photos || []).map((ph) => ({
    photo_reference: ph.name, // new v1 photo "name" path, used by photoUrlByRef
    height: ph.heightPx,
    width: ph.widthPx,
  }));

  const opening_hours = (p.regularOpeningHours || p.currentOpeningHours)
    ? {
        open_now: (p.currentOpeningHours || p.regularOpeningHours).openNow,
        weekday_text: (p.regularOpeningHours || p.currentOpeningHours).weekdayDescriptions || [],
      }
    : undefined;

  const geometry = {
    location: p.location
      ? { lat: p.location.latitude, lng: p.location.longitude }
      : undefined,
    viewport: p.viewport
      ? {
          northeast: { lat: p.viewport.high.latitude, lng: p.viewport.high.longitude },
          southwest: { lat: p.viewport.low.latitude, lng: p.viewport.low.longitude },
        }
      : undefined,
  };

  return {
    place_id: p.id,
    name: p.displayName?.text || '',
    formatted_address: p.formattedAddress || '',
    vicinity: p.shortFormattedAddress || p.formattedAddress || '',
    geometry,
    types: p.types || [],
    primary_type: p.primaryType || null,
    photos,
    rating: p.rating ?? 0,
    user_ratings_total: p.userRatingCount ?? 0,
    price_level: priceLevelToLegacy(p.priceLevel),
    business_status: p.businessStatus || null,
    opening_hours,
    formatted_phone_number: p.nationalPhoneNumber || '',
    international_phone_number: p.internationalPhoneNumber || '',
    website: p.websiteUri || '',
    url: p.googleMapsUri || '',
    editorial_summary: p.editorialSummary ? { overview: p.editorialSummary.text } : undefined,
    // Normalize reviews to legacy shape — new API returns text/author as nested
    // objects { text, languageCode } which crashes Flutter expecting strings.
    reviews: (p.reviews || []).map(r => ({
      author_name: r.authorAttribution?.displayName || '',
      profile_photo_url: r.authorAttribution?.photoUri || null,
      author_url: r.authorAttribution?.uri || null,
      rating: r.rating || 0,
      text: r.text?.text || r.originalText?.text || '',
      relative_time_description: r.relativePublishTimeDescription || '',
      time: r.publishTime || null,
    })),
    serves_beer: p.servesBeer,
    serves_breakfast: p.servesBreakfast,
    serves_brunch: p.servesBrunch,
    serves_dinner: p.servesDinner,
    serves_lunch: p.servesLunch,
    serves_wine: p.servesWine,
    serves_cocktails: p.servesCocktails,
    serves_coffee: p.servesCoffee,
    serves_dessert: p.servesDessert,
    serves_vegetarian_food: p.servesVegetarianFood,
    takeout: p.takeout,
    delivery: p.delivery,
    dine_in: p.dineIn,
    reservable: p.reservable,
    wheelchair_accessible_entrance: p.accessibilityOptions?.wheelchairAccessibleEntrance,
  };
}

// --------------- Places API (New) searchNearby ---------------
// Returns up to 20 places per call. No pagination available on searchNearby.
// rankPreference: 'POPULARITY' (default, matches Google Maps app) or 'DISTANCE'.
async function searchNearbyNew({ lat, lng, type, radius = 5000, maxResults = 20, rank = 'POPULARITY' }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_MAPS_API_KEY');
  if (!type) throw new Error('searchNearbyNew: type required');

  const body = {
    includedTypes: [type],
    locationRestriction: {
      circle: { center: { latitude: lat, longitude: lng }, radius },
    },
    maxResultCount: Math.min(20, Math.max(1, maxResults)),
    rankPreference: rank,
  };

  const r = await fetch(`${NEW_BASE}/places:searchNearby`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': SEARCH_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    console.error('[searchNearbyNew] failed', r.status, JSON.stringify(j?.error || j).slice(0, 500));
    throw new Error(`Places searchNearby error: ${j?.error?.status || r.status} ${j?.error?.message || ''}`);
  }
  return j;
}

// Legacy-compat: same shape as old nearbyByDistance — returns { results: [...] } in legacy schema.
async function nearbyByDistance({ lat, lng, type, pagetoken }) {
  if (pagetoken) {
    // searchNearby has no pagination; signal end-of-results.
    return { status: 'OK', results: [], next_page_token: null };
  }
  const j = await searchNearbyNew({ lat, lng, type, rank: 'POPULARITY' });
  const results = (j.places || []).map(mapNewToLegacy).filter(Boolean);
  return { status: 'OK', results, next_page_token: null };
}

// searchNearby returns max 20 in one call — no pagination on this endpoint.
// maxPages is preserved in signature for caller compat but ignored (single fetch).
async function nearbyByDistanceAll({ lat, lng, type, radius, maxPages = 3 }) { // eslint-disable-line no-unused-vars
  const j = await searchNearbyNew({ lat, lng, type, radius: radius || 5000, rank: 'POPULARITY' });
  return (j.places || []).map(mapNewToLegacy).filter(Boolean);
}

// --------------- Photo URL (new v1 media endpoint) ---------------
// Accepts either new "places/.../photos/..." name OR legacy `photoreference` string.
function photoUrlByRef(photoRef, maxwidth = 800) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!photoRef || !key) return null;
  // New v1 format: name = "places/<placeId>/photos/<photoId>"
  if (typeof photoRef === 'string' && photoRef.startsWith('places/')) {
    return `${NEW_BASE}/${photoRef}/media?maxWidthPx=${maxwidth}&key=${key}`;
  }
  // Legacy fallback (kept in case any old photo_reference still floats through caches)
  return `${LEGACY_BASE}/photo?maxwidth=${maxwidth}&photoreference=${photoRef}&key=${key}`;
}

// --------------- Place details (new v1) ---------------
async function details(place_id) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_MAPS_API_KEY');
  if (!place_id) throw new Error('details: place_id required');

  const r = await fetch(`${NEW_BASE}/places/${encodeURIComponent(place_id)}`, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': DETAILS_FIELD_MASK,
    },
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(`Places Details error: ${j?.error?.status || r.status} ${j?.error?.message || ''}`);
  }
  return mapNewToLegacy(j);
}

// --------------- Text search (new v1) ---------------
async function textSearch({ query, lat, lng, radius = 5000 }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_MAPS_API_KEY');

  const body = {
    textQuery: query,
    locationBias: {
      circle: { center: { latitude: lat, longitude: lng }, radius },
    },
    pageSize: 20,
  };

  const r = await fetch(`${NEW_BASE}/places:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': SEARCH_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(`Places TextSearch error: ${j?.error?.status || r.status} ${j?.error?.message || ''}`);
  }
  return (j.places || []).map(mapNewToLegacy).filter(Boolean);
}

// --------------- Legacy radius-based nearby — backed by searchNearby ---------------
// Kept for any caller that still uses them. Type-only or keyword fallback to textSearch.
async function nearby({ lat, lng, radius = 2500, keyword, type }) {
  if (type) {
    const j = await searchNearbyNew({ lat, lng, type, radius, rank: 'POPULARITY' });
    return (j.places || []).map(mapNewToLegacy).filter(Boolean);
  }
  if (keyword) return textSearch({ query: keyword, lat, lng, radius });
  return [];
}

async function nearbyPage(opts) {
  const results = await nearby(opts);
  return { status: 'OK', results, next_page_token: null };
}

async function nearbyAll(opts) {
  return nearby(opts);
}

module.exports = {
  nearby,
  nearbyPage,
  nearbyAll,
  nearbyByDistance,
  nearbyByDistanceAll,
  details,
  textSearch,
  photoUrlByRef,
};
