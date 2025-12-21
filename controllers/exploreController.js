const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { nearby, nearbyAll, details, photoUrlByRef } = require('../utils/googlePlaces');
const { addPointsWithMultiplier } = require('../utils/points');

const toRad = d => (d * Math.PI) / 180;
const haversineMeters = (a, b) => {
  const R = 6371000, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const A = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(A));
};

// ---- de-dupe tuning (env overrideable) ----
const NEARBY_WITH_PLACEID   = Number(process.env.EXPLORE_DUP_RADIUS_WITH_PLACEID || 0);   // 0 = skip proximity when placeId present
const NEARBY_WITHOUT_PLACEID= Number(process.env.EXPLORE_DUP_RADIUS_METERS       || 15);  // fallback when no placeId
const DUP_WINDOW_HOURS      = Number(process.env.EXPLORE_DUP_WINDOW_HOURS        || 12);  // 12h window

const CATEGORIES = [
  { key: 'rooftop-bars',      title: 'Rooftop Bars',      icon: '🍹', keyword: 'rooftop bar',                         type: 'bar',               points: 4 },
  { key: 'outdoor-activities',title: 'Outdoor Activities',icon: '🌳', keyword: 'park OR hiking OR outdoor activity',  type: 'tourist_attraction', points: 3 },
  { key: 'venue-events',      title: 'Venue Events',      icon: '🎤', keyword: 'concert venue OR live music',         type: 'night_club',         points: 4 },
  { key: 'popular-restaurants',title:'Popular Restaurants',icon:'🍽️', keyword: 'popular restaurant',                  type: 'restaurant',         points: 4 },
];

// ===================== Restaurant Tabs (Home Restaurants) =====================
// UI tabs: Trending | Popular | Bars | Outdoors | Events
const RESTAURANT_CATEGORIES = [
  { key: 'trending', title: 'Trending', icon: '🔥', type: 'restaurant', keyword: 'popular restaurants' },
  { key: 'popular',  title: 'Popular',  icon: '⭐', type: 'restaurant', keyword: 'top rated restaurants' },
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

async function computeNewCounts({ userId, lat, lng, radius = 2500 }) {
  const ttlMinutes = Number(
    process.env.STORY_TTL_MINUTES || (process.env.NODE_ENV === 'development' ? 5 : 24 * 60)
  );
  const since = new Date(Date.now() - ttlMinutes * 60 * 1000);

  // requester-এর communities
  const myCommunities = await prisma.communityMember.findMany({
    where: { userId }, select: { communityId: true }
  });
  const communityIds = myCommunities.map(c => c.communityId);

  const friendOR = [
    { friendRequestsSent:     { some: { receiverId: userId,  status: 'ACCEPTED' } } },
    { friendRequestsReceived: { some: { requesterId: userId, status: 'ACCEPTED' } } }
  ];
  const notBlocked = {
    NOT: [
      { user: { blockedBy: { some: { blockerId: userId } } } },
      { user: { blocks:    { some: { blockedId:  userId } } } }
    ]
  };

  const recentStories = await prisma.story.findMany({
    where: {
      status: 'ACTIVE',
      createdAt: { gte: since },
      latitude: { not: null },
      longitude: { not: null },
      ...notBlocked,
      OR: [
        { userId },
        { visibility: 'profile', user: { OR: friendOR } },
        ...(communityIds.length ? [{ visibility: 'profile', user: { communities: { some: { communityId: { in: communityIds } } } } }] : [])
      ]
    },
    select: { id: true, latitude: true, longitude: true }
  });

  const results = {};
  for (const cat of CATEGORIES) {
    const places = await nearby({ lat, lng, radius, keyword: cat.keyword, type: cat.type });
    const top = places.slice(0, 10).map(p => ({
      lat: p.geometry?.location?.lat, lng: p.geometry?.location?.lng
    }));

    let count = 0;
    for (const s of recentStories) {
      const here = { lat: s.latitude, lng: s.longitude };
      if (top.some(p => p.lat && p.lng && haversineMeters(here, p) <= 120)) count++;
    }
    results[cat.key] = count;
  }
  return results;
}

exports.getExploreHome = async (req, res) => {
  try {
    const userId = req.authData.id;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 2500;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng required' });
    }

    const newCounts = await computeNewCounts({ userId, lat, lng, radius });
    const cards = CATEGORIES.map(c => ({
      key: c.key, title: c.title, icon: c.icon, newCount: newCounts[c.key] || 0, points: c.points
    }));

    res.json({ categories: cards });
  } catch (e) {
    console.error('Explore home error', e);
    res.status(500).json({ error: 'Failed to load explore' });
  }
};

// GET /api/explore/category/:key/places?lat&lng&radius=2500
exports.getCategoryPlaces = async (req, res) => {
  try {
    const { key } = req.params;
    const cat = getCategory(key);
    if (!cat) return res.status(404).json({ error: 'Unknown category' });

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 2500;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng required' });
    }

    const places = await nearby({ lat, lng, radius, keyword: cat.keyword, type: cat.type });

    const items = places.map(p => {
      const bestPhotoRef = p.photos?.[0]?.photo_reference || null;
      return {
        placeId: p.place_id,
        name: p.name,
        address: p.vicinity || p.formatted_address || null,
        photoUrl: photoUrlByRef(bestPhotoRef, 400),
        points: cat.points,
        distanceMeters: haversineMeters({ lat, lng }, { lat: p.geometry.location.lat, lng: p.geometry.location.lng }),
        location: { lat: p.geometry.location.lat, lng: p.geometry.location.lng },
        rating: p.rating || null,
        userRatingsTotal: p.user_ratings_total || null
      };
    });

    items.sort((a, b) => a.distanceMeters - b.distanceMeters || (b.rating || 0) - (a.rating || 0));

    res.json({ category: { key: cat.key, title: cat.title, points: cat.points }, places: items });
  } catch (e) {
    console.error('Category places error', e);
    res.status(500).json({ error: 'Failed to load places' });
  }
};

exports.recordVisit = async (req, res) => {
  try {
    const userId = req.authData.id;
    let { placeId, name, latitude, longitude, mediaUrl, categoryKey } = req.body;

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Bad latitude/longitude' });
    }

    // points per category (fallback to 5, matches your schema default)
    const cat = categoryKey ? getCategory(categoryKey) : null;
    const points = cat?.points ?? 5;

    const since = new Date(Date.now() - DUP_WINDOW_HOURS * 60 * 60 * 1000);

    /* ---------- 1) Precise de-dupe by placeId (best) ---------- */
    if (placeId) {
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
    }

    /* ---------- 2) Proximity fallback (configurable) ---------- 
       Only apply when placeId is missing (or you set a tiny nonzero radius). */
    const fallbackRadius = placeId ? NEARBY_WITH_PLACEID : NEARBY_WITHOUT_PLACEID;

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
        placeId: placeId || null,     // persist precise place
        placeName: name || null,
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
      placeId: placeId || null
    });
  } catch (e) {
    console.error('recordVisit error', e);
    return res.status(500).json({ error: 'Failed to record visit' });
  }
};

exports.getPlaceDetail = async (req, res) => {
  try {
    const { placeId } = req.params;
    const d = await details(placeId);
    const photo = d.photos?.[0]?.photo_reference
      ? photoUrlByRef(d.photos[0].photo_reference, 800)
      : null;

    res.json({
      placeId: d.place_id,
      name: d.name,
      address: d.formatted_address || null,
      location: d.geometry?.location || null,
      openNow: d.opening_hours?.open_now ?? null,
      photoUrl: photo,
      rating: d.rating || null,
      userRatingsTotal: d.user_ratings_total || null,
      types: d.types || []
    });
  } catch (e) {
    console.error('place detail error', e);
    res.status(500).json({ error: 'Failed to load place detail' });
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

// GET /api/restaurants/category/:key/places?lat&lng&radius=2500
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

    // ✅ pull up to ~60 results (3 pages) inside radius
    const places = await nearbyAll({
      lat,
      lng,
      radius,
      keyword: cat.keyword,
      type: cat.type,
      maxPages: 3,
    });

    // ✅ details calls are expensive; enrich top N only
    const DETAIL_LIMIT = Number(process.env.RESTAURANT_DETAILS_LIMIT || 15);

    const restaurants = await Promise.all(
      places.map(async (p, idx) => {
        const placeId = p.place_id;
        let d = null;
        if (idx < DETAIL_LIMIT) {
          try {
            d = await details(placeId);
          } catch (e) {
            d = null;
          }
        }

        const photoRef =
          p.photos?.[0]?.photo_reference ||
          d?.photos?.[0]?.photo_reference ||
          null;

        const image = photoUrlByRef(photoRef, 800) || '';

        const lat2 = p.geometry?.location?.lat ?? d?.geometry?.location?.lat;
        const lng2 = p.geometry?.location?.lng ?? d?.geometry?.location?.lng;

        const openNow = d?.opening_hours?.open_now ?? p.opening_hours?.open_now;
        const status = openNowToStatus(openNow);

        return {
          id: String(placeId),
          name: d?.name || p.name || '',
          address: d?.formatted_address || p.vicinity || '',
          phone: d?.formatted_phone_number || d?.international_phone_number || '',
          website: d?.website || d?.url || '',
          lat: typeof lat2 === 'number' ? lat2 : 0,
          lng: typeof lng2 === 'number' ? lng2 : 0,
          image,
          category: cat.title,
          priceRange: priceLevelToRange(d?.price_level) || '',
          status,
          rating: Number(d?.rating ?? p.rating ?? 0),
        };
      })
    );

    // Sort: rating desc then distance asc
    const here = { lat, lng };
    restaurants.sort((a, b) => {
      const dA = haversineMeters(here, { lat: a.lat, lng: a.lng });
      const dB = haversineMeters(here, { lat: b.lat, lng: b.lng });
      return (b.rating || 0) - (a.rating || 0) || dA - dB;
    });

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
