
const GMAPS_BASE = 'https://maps.googleapis.com/maps/api/place';
// utils/googlePlaces.js

const fieldsForDetails = [
  'place_id',
  'name',
  'formatted_address',
  'vicinity',
  'geometry/location',
  'types',
  'photos',

  'opening_hours/open_now',
  'opening_hours/weekday_text',

  'rating',
  'user_ratings_total',
  'reviews',

  'formatted_phone_number',
  'international_phone_number',
  'website',
  'url',

  'price_level',
  'business_status',
  'editorial_summary',
  'serves_beer',
  'serves_breakfast',
  'serves_brunch',
  'serves_dinner',
  'serves_lunch',
  'serves_wine',
  'serves_vegetarian_food',
  'takeout',
  'delivery',
  'dine_in',
  'reservable',
  'wheelchair_accessible_entrance',
].join(',');

// Nearbysearch with rankby=distance — returns ALL places of given type within ~3km,
// sorted by distance ascending. No prominence filtering, so chains (Starbucks etc.) included naturally.
async function nearbyByDistance({ lat, lng, type, pagetoken }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_MAPS_API_KEY');

  const params = new URLSearchParams({ key });
  if (pagetoken) {
    params.set('pagetoken', pagetoken);
  } else {
    if (!type) throw new Error('nearbyByDistance: type required');
    params.set('location', `${lat},${lng}`);
    params.set('rankby', 'distance');
    params.set('type', type);
  }
  const url = `${GMAPS_BASE}/nearbysearch/json?${params.toString()}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS' && j.status !== 'INVALID_REQUEST') {
    throw new Error(`Places Nearby (rankby=distance) error: ${j.status} ${j.error_message || ''}`);
  }
  return j;
}

// Multi-page version — up to maxPages × 20 results per type. Tokens need ~2s delay.
async function nearbyByDistanceAll({ lat, lng, type, maxPages = 3 }) {
  const out = [];
  let page = await nearbyByDistance({ lat, lng, type });
  out.push(...(page.results || []));
  let token = page.next_page_token;
  let pages = 1;
  while (token && pages < maxPages) {
    await new Promise(r => setTimeout(r, 2000));
    let tries = 0;
    let next;
    while (tries < 4) {
      next = await nearbyByDistance({ pagetoken: token });
      if (next.status !== 'INVALID_REQUEST') break;
      tries++;
      await new Promise(r => setTimeout(r, 1500));
    }
    if (!next || next.status === 'INVALID_REQUEST') break;
    out.push(...(next.results || []));
    token = next.next_page_token;
    pages++;
  }
  return out;
}

function photoUrlByRef(photoRef, maxwidth = 800) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!photoRef || !key) return null;
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxwidth}&photoreference=${photoRef}&key=${key}`;
}


async function nearby({ lat, lng, radius = 2500, keyword, type }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_MAPS_API_KEY');

  const params = new URLSearchParams({
    key,
    location: `${lat},${lng}`,
    radius: String(radius),
  });
  if (keyword) params.set('keyword', keyword);
  if (type) params.set('type', type);

  const url = `${GMAPS_BASE}/nearbysearch/json?${params.toString()}`;
  const r = await fetch(url);
  const j = await r.json();

  if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
    throw new Error(`Places Nearby error: ${j.status} ${j.error_message || ''}`);
  }
  return j.results || [];
}

// Nearby search with page token
async function nearbyPage({ lat, lng, radius = 2500, keyword, type, pagetoken }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_MAPS_API_KEY');

  const params = new URLSearchParams({ key });

  if (pagetoken) {
    // Google requires only pagetoken + key for the next page
    params.set('pagetoken', pagetoken);
  } else {
    params.set('location', `${lat},${lng}`);
    params.set('radius', String(radius));
    if (keyword) params.set('keyword', keyword);
    if (type) params.set('type', type);
  }

  const url = `${GMAPS_BASE}/nearbysearch/json?${params.toString()}`;
  const r = await fetch(url);
  const j = await r.json();

  // INVALID_REQUEST can happen briefly for next_page_token; caller will retry
  if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS' && j.status !== 'INVALID_REQUEST') {
    throw new Error(`Places Nearby error: ${j.status} ${j.error_message || ''}`);
  }

  return j;
}

// Fetch multiple pages (max ~60 results). Google next_page_token needs a short delay.
async function nearbyAll({ lat, lng, radius = 2500, keyword, type, maxPages = 3 }) {
  const out = [];

  let page = await nearbyPage({ lat, lng, radius, keyword, type });
  out.push(...(page.results || []));

  let token = page.next_page_token;
  let pages = 1;

  while (token && pages < maxPages) {
    // token becomes valid after a short delay
    await new Promise((r) => setTimeout(r, 2000));

    // retry a few times if INVALID_REQUEST
    let tries = 0;
    let next;
    while (tries < 4) {
      next = await nearbyPage({ pagetoken: token });
      if (next.status !== 'INVALID_REQUEST') break;
      tries += 1;
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!next || next.status === 'INVALID_REQUEST') break;

    out.push(...(next.results || []));
    token = next.next_page_token;
    pages += 1;
  }

  return out;
}

async function details(place_id) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const url = `${GMAPS_BASE}/details/json?place_id=${place_id}&fields=${encodeURIComponent(
    fieldsForDetails
  )}&key=${key}`;

  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== 'OK') throw new Error(`Places Details error: ${j.status} ${j.error_message || ''}`);
  return j.result;
}

async function textSearch({ query, lat, lng, radius = 5000 }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_MAPS_API_KEY');

  const params = new URLSearchParams({
    key,
    query,
    location: `${lat},${lng}`,
    radius: String(radius),
  });

  const url = `${GMAPS_BASE}/textsearch/json?${params.toString()}`;
  const r = await fetch(url);
  const j = await r.json();

  if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
    throw new Error(`Places TextSearch error: ${j.status} ${j.error_message || ''}`);
  }
  return j.results || [];
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
