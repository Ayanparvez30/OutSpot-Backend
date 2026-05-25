const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { nearbyPage, nearbyAll, nearbyByDistance, details, textSearch, photoUrlByRef } = require('../utils/googlePlaces');
const { addPointsWithMultiplier } = require('../utils/points');

const toRad = d => (d * Math.PI) / 180;
const haversineMeters = (a, b) => {
  const R = 6371000, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const A = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(A));
};
const metersToMiles = (m) => +(m / 1609.344).toFixed(2);
function buildPhotosArray(d, max = 8) {
  const refs = (d?.photos || []).slice(0, max).map(p => p.photo_reference).filter(Boolean);
  return refs.map(ref => photoUrlByRef(ref, 1200)).filter(Boolean);
}

// ---- de-dupe tuning (env overrideable) ----
const NEARBY_WITH_PLACEID   = Number(process.env.EXPLORE_DUP_RADIUS_WITH_PLACEID || 0);   // 0 = skip proximity when placeId present
const NEARBY_WITHOUT_PLACEID= Number(process.env.EXPLORE_DUP_RADIUS_METERS       || 15);  // fallback when no placeId
const DUP_WINDOW_HOURS      = Number(process.env.EXPLORE_DUP_WINDOW_HOURS        || 12);  // 12h window

// Priority order matters. Walk top-down — first match wins.
// A Starbucks tagged ['cafe','food','restaurant'] hits Cafes first → primary=Cafes,
// excluded from Restaurants results. A pub tagged ['bar','restaurant'] → primary=Bars.
const CATEGORIES = [
  { key: 'venue-events', title: 'Venue Events', icon: '🎤', points: 4, imageKey: 'venue-events',
    googleTypes: ['stadium', 'movie_theater', 'amusement_park', 'bowling_alley', 'casino', 'concert_hall', 'performing_arts_theater'] },
  { key: 'outdoors',     title: 'Outdoors',     icon: '🌳', points: 3, imageKey: 'outdoors',
    googleTypes: ['park', 'campground', 'tourist_attraction', 'natural_feature', 'hiking_area'] },
  { key: 'bars',         title: 'Bars',         icon: '🍻', points: 4, imageKey: 'bars',
    googleTypes: ['bar', 'night_club', 'pub'] },
  { key: 'cafes',        title: 'Cafes',        icon: '☕', points: 3, imageKey: 'cafes',
    googleTypes: ['cafe'] },
  { key: 'restaurants',  title: 'Restaurants',  icon: '🍽️', points: 4, imageKey: 'restaurants',
    googleTypes: ['restaurant', 'meal_takeaway', 'meal_delivery'] },
];

// Name patterns suggesting "this is coffee-focused" — used to disambiguate when
// Google tags a place as BOTH cafe and restaurant (McDonald's vs Starbucks both
// get those tags identically; only the name distinguishes them).
const COFFEE_NAME_RE = /coffee|caf[eé]|espresso|barista|roastery|donut|doughnut|pastry|brewhouse|\bbrew\b|bakery/i;

function findCat(key) { return CATEGORIES.find(c => c.key === key); }

// Determine the PRIMARY category for a place. Walks priority list. For the
// cafe/restaurant overlap (McDonald's, Dunkin, Starbucks all tagged both), uses
// name + bakery tag as tiebreaker so:
//   Starbucks ("...Coffee Company") -> Cafes
//   McDonald's ("McDonald's")        -> Restaurants
//   Dunkin (cafe + bakery)           -> Cafes
function primaryCategory(place) {
  const types = Array.isArray(place?.types) ? place.types : [];
  const tset = new Set(types);
  const name = String(place?.name || '');

  // 1) Venue Events
  if (findCat('venue-events').googleTypes.some(t => tset.has(t))) return findCat('venue-events');
  // 2) Outdoors
  if (findCat('outdoors').googleTypes.some(t => tset.has(t))) return findCat('outdoors');
  // 3) Bars
  if (findCat('bars').googleTypes.some(t => tset.has(t))) return findCat('bars');

  // 4) Cafe vs Restaurant disambiguation
  const isCafe = tset.has('cafe');
  const isRest = tset.has('restaurant') || tset.has('meal_takeaway') || tset.has('meal_delivery');
  const isBakery = tset.has('bakery');
  const nameLooksCoffee = COFFEE_NAME_RE.test(name);

  if (isCafe && (isBakery || nameLooksCoffee)) return findCat('cafes');
  if (isCafe && isRest) return findCat('restaurants'); // fast-food w/ McCafe-style cafe tag
  if (isCafe) return findCat('cafes');
  if (isRest) return findCat('restaurants');

  return null;
}


const RESTAURANT_CATEGORIES = [
  { key: 'trending', title: 'Trending', icon: '🔥', type: 'restaurant', keyword: 'popular restaurants' },
  { key: 'popular',  title: 'Popular',  icon: '⭐', type: 'restaurant', keyword: 'top rated restaurants' },

  { key: 'cafes',    title: 'Cafes',    icon: '☕', type: 'cafe',       keyword: 'cafe' },

  { key: 'bars',     title: 'Bars',     icon: '🍻', type: 'bar',        keyword: 'bar' },
  { key: 'outdoors', title: 'Outdoors', icon: '🌿', type: 'restaurant', keyword: 'outdoor seating restaurant' },
  { key: 'events',   title: 'Events',   icon: '🎉', type: 'restaurant', keyword: 'live music restaurant' },
];

const getRestaurantCategory = (key) => RESTAURANT_CATEGORIES.find((c) => c.key === key);

function priceLevelToRange(level) {
  if (level === 0) return '$';
  if (level === 1) return '$$';
  if (level === 2) return '$$$';
  if (level === 3) return '$$$$';
  return '';
}

function openNowToStatus(openNow) {
  if (openNow === true) return 'Open';
  if (openNow === false) return 'Closed';
  return 'Unknown';
}

const getCategory = key => CATEGORIES.find(c => c.key === key);

// helper: map raw Google place to response object
function mapPlace(p, lat, lng, points) {
  const placeLat = p.geometry?.location?.lat ?? 0;
  const placeLng = p.geometry?.location?.lng ?? 0;
  return {
    placeId: p.place_id,
    name: p.name,
    address: p.vicinity || p.formatted_address || null,
    photoUrl: photoUrlByRef(p.photos?.[0]?.photo_reference, 400),
    points,
    distanceMiles: placeLat && placeLng
      ? metersToMiles(haversineMeters({ lat, lng }, { lat: placeLat, lng: placeLng }))
      : null,
    lat: Number(placeLat),
    lng: Number(placeLng),
    rating: p.rating || null,
    userRatingsTotal: p.user_ratings_total || null,
  };
}

// GET /api/explore/category/:key/places?lat&lng&radius=5000
exports.getCategoryPlaces = async (req, res) => {
  try {
    const { key } = req.params;
    const cat = getCategory(key);
    if (!cat) return res.status(404).json({ error: 'Unknown category' });

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 5000;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng required' });
    }

    // Fetch by each Google type for this category, then classify each result via
    // the priority hierarchy. A place stays only if its PRIMARY bucket matches the
    // requested category (Starbucks tagged [cafe,restaurant,food] → primary=Cafes
    // → excluded from /restaurants results).
    const all = await Promise.all(
      cat.googleTypes.map(t => nearbyByDistance({ lat, lng, type: t }).catch(() => []))
    );

    const radiusMiles = metersToMiles(radius);
    const seen = new Set();
    const items = [];
    for (const list of all) {
      for (const p of list) {
        if (!p?.place_id || seen.has(p.place_id)) continue;
        seen.add(p.place_id);
        const primary = primaryCategory(p);
        if (!primary || primary.key !== cat.key) continue; // wrong bucket
        const m = { ...mapPlace(p, lat, lng, cat.points), category: cat.title };
        if (m.distanceMiles != null && m.distanceMiles <= radiusMiles) items.push(m);
      }
    }
    items.sort((a, b) => (a.distanceMiles ?? 99999) - (b.distanceMiles ?? 99999));

    res.json({
      category: { key: cat.key, title: cat.title, points: cat.points },
      places: items,
      nextPageToken: null,
    });
  } catch (e) {
    console.error('Category places error', e);
    res.status(500).json({ error: 'Failed to load places' });
  }
};

// GET /api/explore/category/:key/more?pagetoken=X&lat&lng
exports.getCategoryMorePlaces = async (req, res) => {
  try {
    const { key } = req.params;
    const cat = getCategory(key);
    if (!cat) return res.status(404).json({ error: 'Unknown category' });

    const pagetoken = req.query.pagetoken;
    if (!pagetoken) return res.status(400).json({ error: 'pagetoken required' });

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng required' });
    }

    const page = await nearbyPage({ pagetoken });
    const items = (page.results || []).map(p => mapPlace(p, lat, lng, cat.points));
    items.sort((a, b) => (a.distanceMiles || 0) - (b.distanceMiles || 0) || (b.rating || 0) - (a.rating || 0));

    res.json({
      places: items,
      nextPageToken: page.next_page_token || null,
    });
  } catch (e) {
    console.error('Category more places error', e);
    res.status(500).json({ error: 'Failed to load more places' });
  }
};
exports.recordVisit = async (req, res) => {
  try {
    const userId = req.authData.id;
    let { placeId, name, latitude, longitude, mediaUrl, categoryKey } = req.body || {};

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Bad latitude/longitude' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Latitude/longitude out of range' });
    }

    // ✅ require placeId (so we can validate)
    if (!placeId || typeof placeId !== 'string' || placeId.trim().length < 5) {
      return res.status(400).json({ error: 'placeId required to award points' });
    }
    placeId = placeId.trim();

    // points per category (fallback to 5)
    const cat = categoryKey ? getCategory(categoryKey) : null;
    const points = cat?.points ?? 5;

    // --------------------------
    // ✅ server-side place validate
    // --------------------------
    const MAX_PLACE_DISTANCE_METERS = Number(process.env.MAX_PLACE_DISTANCE_METERS || 15);

    let placeLat = null;
    let placeLng = null;
    let placeNameFromGoogle = null;

    try {
      const d = await details(placeId);
      placeLat = d?.geometry?.location?.lat ?? null;
      placeLng = d?.geometry?.location?.lng ?? null;
      placeNameFromGoogle = d?.name ?? null;
    } catch (e) {
      return res.status(502).json({
        awarded: false,
        error: 'Failed to verify placeId via Google Places',
      });
    }

    if (!Number.isFinite(placeLat) || !Number.isFinite(placeLng)) {
      return res.status(400).json({
        awarded: false,
        error: 'Invalid placeId (no geometry)',
      });
    }

    const distToPlace = haversineMeters(
      { lat, lng },
      { lat: placeLat, lng: placeLng }
    );

    if (distToPlace > MAX_PLACE_DISTANCE_METERS) {
      const dist = Math.round(distToPlace);
      return res.status(403).json({
        awarded: false,
        reason: 'too-far-from-place',
        message: `You need to be within ${MAX_PLACE_DISTANCE_METERS}m of this place to check in. You are currently ${dist}m away. Please get closer and try again.`,
        placeId,
        distanceMiles: metersToMiles(dist),
        maxMiles: metersToMiles(MAX_PLACE_DISTANCE_METERS),
      });
    }

    const since = new Date(Date.now() - DUP_WINDOW_HOURS * 60 * 60 * 1000);

    /* ---------- 1) Precise de-dupe by placeId ---------- */
    const priorSamePlace = await prisma.locationPoint.findFirst({
      where: { userId, placeId, createdAt: { gte: since } },
      select: { id: true, createdAt: true }
    });

    if (priorSamePlace) {
      return res.status(200).json({
        awarded: false,
        reason: 'duplicate-place-within-window',
        placeId,
        windowHours: DUP_WINDOW_HOURS,
        since: priorSamePlace.createdAt
      });
    }

    /* ---------- 2) Proximity fallback (optional) ---------- 
       If you keep NEARBY_WITH_PLACEID=0 it will skip. */
    const fallbackRadius = NEARBY_WITH_PLACEID;

    if (fallbackRadius > 0) {
      const recent = await prisma.locationPoint.findMany({
        where: { userId, createdAt: { gte: since } },
        select: { latitude: true, longitude: true, createdAt: true }
      });

      let nearest = null;
      for (const lp of recent) {
        if (lp.latitude == null || lp.longitude == null) continue;
        const d = haversineMeters({ lat: lp.latitude, lng: lp.longitude }, { lat, lng });
        if (!nearest || d < nearest.distance) nearest = { ...lp, distance: d };
      }

      if (nearest && nearest.distance <= fallbackRadius) {
        return res.status(200).json({
          awarded: false,
          reason: 'duplicate-nearby-within-window',
          radiusMeters: fallbackRadius,
          nearestMeters: Math.round(nearest.distance),
          windowHours: DUP_WINDOW_HOURS,
          lastCheckinAt: nearest.createdAt
        });
      }
    }

    /* ---------- 3) Create + award ---------- */
    const created = await prisma.locationPoint.create({
      data: {
        userId,
        mediaUrl: mediaUrl || '',
        placeId,
        placeName: (name && String(name).trim()) || placeNameFromGoogle || null,
        placeType: cat?.title || null,
        latitude: lat,
        longitude: lng,
        points
      }
    });

    await addPointsWithMultiplier(userId, points, 'LOCATION_VISIT', created.id);

    return res.json({
      awarded: true,
      points,
      id: created.id,
      placeId,
      distanceMiles: metersToMiles(distToPlace),
    });
  } catch (e) {
    console.error('recordVisit error', e);
    return res.status(500).json({ error: 'Failed to record visit' });
  }
};

exports.getPlaceDetail = async (req, res) => {
  try {
    const { placeId } = req.params;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const d = await details(placeId);

    const photos = buildPhotosArray(d, 8);
    const image = photos[0] || photoUrlByRef(d.photos?.[0]?.photo_reference, 1200) || '';
    const openNow = d.opening_hours?.open_now ?? null;
    const placeLat = d.geometry?.location?.lat;
    const placeLng = d.geometry?.location?.lng;

    let distanceMiles = null;
    if (Number.isFinite(lat) && Number.isFinite(lng) && placeLat && placeLng) {
      distanceMiles = metersToMiles(haversineMeters({ lat, lng }, { lat: placeLat, lng: placeLng }));
    }

    // Match which app categories this place falls under based on Google types
    const placeTypes = d.types || [];
    const TYPE_TO_SECTIONS = {
      restaurant: ['Popular Restaurants'],
      cafe: ['Cafes'],
      bar: ['Bars'],
      night_club: ['Bars'],
      park: ['Outdoor Activities'],
      campground: ['Outdoor Activities'],
      tourist_attraction: ['Outdoor Activities'],
      rooftop: ['Rooftop Bars'],
    };
    const sections = new Set();
    for (const t of placeTypes) {
      if (TYPE_TO_SECTIONS[t]) TYPE_TO_SECTIONS[t].forEach(s => sections.add(s));
    }
    // Keyword-based fallback from name
    const nameLower = (d.name || '').toLowerCase();
    if (nameLower.includes('rooftop')) sections.add('Rooftop Bars');
    if (nameLower.includes('cafe') || nameLower.includes('coffee')) sections.add('Cafes');

    // Cuisine / services from Google data
    const cuisine = [];
    if (d.serves_breakfast) cuisine.push('Breakfast');
    if (d.serves_brunch) cuisine.push('Brunch');
    if (d.serves_lunch) cuisine.push('Lunch');
    if (d.serves_dinner) cuisine.push('Dinner');
    if (d.serves_beer) cuisine.push('Beer');
    if (d.serves_wine) cuisine.push('Wine');
    if (d.serves_vegetarian_food) cuisine.push('Vegetarian');

    const services = [];
    if (d.dine_in) services.push('Dine-in');
    if (d.takeout) services.push('Takeout');
    if (d.delivery) services.push('Delivery');
    if (d.reservable) services.push('Reservable');
    if (d.wheelchair_accessible_entrance) services.push('Wheelchair Accessible');

    // Reviews (top 5 from Google)
    const reviews = (d.reviews || []).slice(0, 5).map(r => ({
      author: r.author_name || '',
      authorPhoto: r.profile_photo_url || null,
      rating: r.rating || 0,
      text: r.text || '',
      timeAgo: r.relative_time_description || '',
    }));

    res.json({
      id: String(d.place_id),
      name: d.name || '',
      address: d.formatted_address || '',
      phone: d.formatted_phone_number || d.international_phone_number || '',
      website: d.website || '',
      googleMapsUrl: d.url || '',
      lat: Number(placeLat ?? 0),
      lng: Number(placeLng ?? 0),
      distanceMiles,
      image,
      photos,
      description: d.editorial_summary?.overview || null,
      category: d.types?.[0] || '',
      sections: [...sections],
      cuisine,
      services,
      priceLevel: d.price_level ?? null,
      priceRange: priceLevelToRange(d.price_level) || '',
      openNow,
      status: openNowToStatus(openNow),
      weekdayText: d.opening_hours?.weekday_text || [],
      rating: Number(d.rating ?? 0),
      totalReviews: Number(d.user_ratings_total ?? 0),
      reviews,
      businessStatus: d.business_status || null,
      types: d.types || [],
    });
  } catch (e) {
    console.error('place detail error', e);
    res.status(500).json({ error: 'Failed to load place detail' });
  }
};

// GET /api/explore/search?q=starbucks&lat=X&lng=Y&radius=5000
exports.searchPlaces = async (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Search query required (min 2 characters)' });
    }

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 5000;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng required' });
    }

    const results = await textSearch({ query, lat, lng, radius });

    const places = results.map(p => {
      const pLat = p.geometry?.location?.lat ?? 0;
      const pLng = p.geometry?.location?.lng ?? 0;
      return {
        placeId: p.place_id,
        name: p.name,
        address: p.formatted_address || p.vicinity || null,
        photoUrl: photoUrlByRef(p.photos?.[0]?.photo_reference, 400),
        points: 5,
        distanceMiles: pLat && pLng
          ? metersToMiles(haversineMeters({ lat, lng }, { lat: pLat, lng: pLng }))
          : null,
        lat: Number(pLat),
        lng: Number(pLng),
        rating: p.rating || null,
        userRatingsTotal: p.user_ratings_total || null,
      };
    });

    places.sort((a, b) => (a.distanceMiles || 99999) - (b.distanceMiles || 99999));

    res.json({ query, places });
  } catch (e) {
    console.error('Search places error', e);
    res.status(500).json({ error: 'Search failed' });
  }
};

// ===================== Restaurant APIs =====================
// GET /api/restaurants/categories
exports.getRestaurantCategories = async (req, res) => {
  try {
    return res.json({
      success: true,
      categories: RESTAURANT_CATEGORIES.map((c) => ({
        key: c.key,
        title: c.title,
        icon: c.icon,
      })),
    });
  } catch (e) {
    console.error('getRestaurantCategories error', e);
    return res.status(500).json({ success: false, error: 'Failed to load categories' });
  }
};
exports.getRestaurantsByCategory = async (req, res) => {
  try {
    const { key } = req.params;
    const cat = getRestaurantCategory(key);
    if (!cat) return res.status(404).json({ success: false, error: 'Unknown category' });

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 2500;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ success: false, error: 'lat/lng required' });
    }

    const places = await nearbyAll({
      lat,
      lng,
      radius,
      keyword: cat.keyword,
      type: cat.type,
      maxPages: 3,
    });

    // ✅ IMPORTANT: এখানে details call বেশি হবে
    // limit এর উপর details call নিয়ন্ত্রণ করবেন
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;

    const top = places.slice(0, limit);

    const restaurants = await Promise.all(
      top.map(async (p) => {
        const placeId = p.place_id;

        // ✅ Full details for every item in list (আপনার চাওয়া অনুযায়ী)
        let d = null;
        try {
          d = await details(placeId);
        } catch (err) {
          d = null;
        }

        const photos = buildPhotosArray(d, 8);        // ✅ multiple photos
        const image =
          photos[0] ||
          photoUrlByRef(p.photos?.[0]?.photo_reference, 1200) ||
          '';

        const lat2 = p.geometry?.location?.lat ?? d?.geometry?.location?.lat ?? 0;
        const lng2 = p.geometry?.location?.lng ?? d?.geometry?.location?.lng ?? 0;

        const openNow = d?.opening_hours?.open_now ?? p.opening_hours?.open_now;
        const status = openNowToStatus(openNow);

        return {
          id: String(placeId),
          name: d?.name || p.name || '',
          address: d?.formatted_address || p.vicinity || '',
          phone: d?.formatted_phone_number || d?.international_phone_number || '',
          website: d?.website || '',
          googleMapsUrl: d?.url || '',
          lat: Number(lat2),
          lng: Number(lng2),

          // ✅ images
          image,
          photos,

          category: cat.title,
          priceLevel: d?.price_level ?? null,
          priceRange: priceLevelToRange(d?.price_level) || '',
          openNow: openNow ?? null,
          status,
          weekdayText: d?.opening_hours?.weekday_text || [],

          rating: Number(d?.rating ?? p.rating ?? 0),
          totalReviews: Number(d?.user_ratings_total ?? p.user_ratings_total ?? 0),
          businessStatus: d?.business_status || null,
          types: d?.types || p.types || [],
        };
      })
    );

    return res.json({
      success: true,
      category: { key: cat.key, title: cat.title },
      radius,
      restaurants,
    });
  } catch (e) {
    console.error('getRestaurantsByCategory error', e);
    return res.status(500).json({ success: false, error: 'Failed to load restaurants' });
  }
};

function startOfWeekMonday(d = new Date()) {
  const date = new Date(d);
  const day = date.getDay(); // 0=Sun,1=Mon...
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

async function getFriendIds(userId) {
  const rows = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ requesterId: userId }, { receiverId: userId }],
    },
    select: { requesterId: true, receiverId: true },
  });

  const ids = new Set();
  for (const r of rows) {
    ids.add(r.requesterId === userId ? r.receiverId : r.requesterId);
  }
  return [...ids];
}

async function getUserAvatar(userId) {
  // Optional: latest saved minime avatar
  const m = await prisma.minime.findFirst({
    where: { userId, isSaved: true },
    select: { avatarUrl: true, selfieUrl: true },
    orderBy: { updatedAt: 'desc' },
  });
  return m?.avatarUrl || m?.selfieUrl || null;
}

exports.getTopTrendingWeekRestaurants = async (req, res) => {
  try {
    const userId = req.authData.id;

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 3000;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ success: false, error: 'lat/lng required' });
    }

    const since = startOfWeekMonday(new Date());

const grouped = await prisma.locationPoint.groupBy({
  by: ['placeId'],
  where: {
    createdAt: { gte: since },
    placeId: { not: null },
    latitude: { not: null },
    longitude: { not: null },
  },
  _count: { placeId: true },  // ✅ visitCount
  _sum: { points: true },     // ✅ pointsCollected
  take: limit * 6,
  orderBy: [
    { _sum: { points: 'desc' } },
    { _count: { placeId: 'desc' } },
  ],
});


    if (!grouped.length) {
      return res.json({
        success: true,
        title: 'Top Trending',
        subtitle: 'Best of the week',
        since,
        radius,
        restaurants: [],
      });
    }

    const placeIds = grouped.map(g => g.placeId).filter(Boolean);

    // ✅ uniqueUsers: placeId ভিত্তিতে distinct user গণনা
    // Prisma distinct + count workaround:
    const allWeekPoints = await prisma.locationPoint.findMany({
      where: {
        createdAt: { gte: since },
        placeId: { in: placeIds },
      },
      select: { placeId: true, userId: true, latitude: true, longitude: true, placeName: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const uniqueUsersMap = new Map(); // placeId -> Set(userId)
    const latestByPlace = new Map();  // placeId -> latest lp

    for (const lp of allWeekPoints) {
      if (!uniqueUsersMap.has(lp.placeId)) uniqueUsersMap.set(lp.placeId, new Set());
      uniqueUsersMap.get(lp.placeId).add(lp.userId);

      if (!latestByPlace.has(lp.placeId)) {
        latestByPlace.set(lp.placeId, lp); // because sorted desc
      }
    }

    // ✅ Friend list
    const friendIds = await getFriendIds(userId);

    // ✅ Friends who went where (distinct by placeId+userId)
    let friendsByPlace = new Map(); // placeId -> Set(friendId)
    if (friendIds.length) {
      const friendVisits = await prisma.locationPoint.findMany({
        where: {
          createdAt: { gte: since },
          placeId: { in: placeIds },
          userId: { in: friendIds },
        },
        select: { placeId: true, userId: true },
      });

      friendsByPlace = new Map();
      for (const v of friendVisits) {
        if (!friendsByPlace.has(v.placeId)) friendsByPlace.set(v.placeId, new Set());
        friendsByPlace.get(v.placeId).add(v.userId);
      }
    }

    // ✅ Build output
    const here = { lat, lng };
    const out = [];

    for (const g of grouped) {
      const placeId = g.placeId;
      const last = latestByPlace.get(placeId);
      if (!last?.latitude || !last?.longitude) continue;

      // radius filter (user position)
      const dMeters = haversineMeters(here, { lat: last.latitude, lng: last.longitude });
      if (dMeters > radius) continue;

      // Google details for proper address/phone/website/photo
      let d = null;
      try { d = await details(placeId); } catch (e) { d = null; }

      const photoRef = d?.photos?.[0]?.photo_reference || null;

      const friendSet = friendsByPlace.get(placeId) || new Set();
      const friendsCount = friendSet.size;

      // Preview 3 friends
      const previewIds = [...friendSet].slice(0, 3);
      const previewUsers = previewIds.length
        ? await prisma.user.findMany({
            where: { id: { in: previewIds } },
            select: { id: true, username: true, firstName: true, lastName: true },
          })
        : [];

      const friendsPreview = [];
      for (const u of previewUsers) {
        friendsPreview.push({
          id: u.id,
          username: u.username,
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
          avatar: await getUserAvatar(u.id),
        });
      }
const photos = buildPhotosArray(d, 8);
const image = photos[0] || '';

out.push({
  id: String(placeId),
  name: d?.name || last.placeName || '',
  address: d?.formatted_address || '',
  phone: d?.formatted_phone_number || d?.international_phone_number || '',
  website: d?.website || '',
  googleMapsUrl: d?.url || '',
  lat: d?.geometry?.location?.lat ?? last.latitude,
  lng: d?.geometry?.location?.lng ?? last.longitude,

  image,
  photos,

  category: 'Trending',
  priceLevel: d?.price_level ?? null,
  priceRange: priceLevelToRange(d?.price_level) || '',
  openNow: d?.opening_hours?.open_now ?? null,
  status: openNowToStatus(d?.opening_hours?.open_now),
  weekdayText: d?.opening_hours?.weekday_text || [],

  rating: Number(d?.rating ?? 0),
  totalReviews: Number(d?.user_ratings_total ?? 0),
  businessStatus: d?.business_status || null,
  types: d?.types || [],

  visitCount: g._count?.placeId || 0,     
  uniqueUsers: uniqueUsersMap.get(placeId)?.size || 0,
  pointsCollected: g._sum?.points || 0,
  distanceMiles: metersToMiles(dMeters),

  friendsCount,
  friendsPreview,
});

      if (out.length >= limit) break;
    }

    // ✅ Sort: points -> uniqueUsers -> visitCount -> distance
    out.sort((a, b) =>
      (b.pointsCollected || 0) - (a.pointsCollected || 0) ||
      (b.uniqueUsers || 0) - (a.uniqueUsers || 0) ||
      (b.visitCount || 0) - (a.visitCount || 0) ||
      (a.distanceMiles || 0) - (b.distanceMiles || 0)
    );

    return res.json({
      success: true,
      title: 'Top Trending',
      subtitle: 'Best of the week',
      since,
      radius,
      restaurants: out.slice(0, limit),
    });
  } catch (e) {
    console.error('getTopTrendingWeekRestaurants error', e);
    return res.status(500).json({ success: false, error: 'Failed to load trending week' });
  }
};
