const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { nearby, details, photoUrlByRef } = require('../utils/googlePlaces');
const { addPointsWithMultiplier } = require('../utils/points');
const toRad = d => (d * Math.PI) / 180;
const haversineMeters = (a, b) => {
  const R = 6371000, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const A = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(A));
};

const CATEGORIES = [
  { key: 'rooftop-bars',      title: 'Rooftop Bars',      icon: '🍹', keyword: 'rooftop bar',                         type: 'bar',             points: 4 },
  { key: 'outdoor-activities',title: 'Outdoor Activities',icon: '🌳', keyword: 'park OR hiking OR outdoor activity',  type: 'tourist_attraction', points: 3 },
  { key: 'venue-events',      title: 'Venue Events',      icon: '🎤', keyword: 'concert venue OR live music',         type: 'night_club',      points: 4 },
  { key: 'popular-restaurants',title:'Popular Restaurants',icon:'🍽️', keyword: 'popular restaurant',                  type: 'restaurant',      points: 4 },
];

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

    // keep your category logic; default to your model's default (5) if not set
    const cat = categoryKey ? getCategory(categoryKey) : null;
    const points = cat?.points ?? 5;

    const twelveHrsAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);

    // 1) High-confidence de-dupe by placeId (when provided)
    if (placeId) {
      const priorSamePlace = await prisma.locationPoint.findFirst({
        where: { userId, placeId, createdAt: { gte: twelveHrsAgo } },
        select: { id: true, createdAt: true }
      });
      if (priorSamePlace) {
        return res.status(200).json({
          awarded: false,
          reason: 'duplicate-place-within-12h',
          placeId,
          since: priorSamePlace.createdAt
        });
      }
    }

    // 2) Fallback: radius-based de-dupe (<= 50 m) over last 12 h
    const recent = await prisma.locationPoint.findMany({
      where: { userId, createdAt: { gte: twelveHrsAgo } },
      select: { latitude: true, longitude: true }
    });

    const nearHit = recent.some(lp => {
      if (lp.latitude == null || lp.longitude == null) return false;
      return haversineMeters(
        { lat: lp.latitude, lng: lp.longitude },
        { lat, lng }
      ) <= 15;
    });

    if (nearHit) {
      return res.status(200).json({
        awarded: false,
        reason: 'duplicate-nearby-within-12h',
        radiusMeters: 15
      });
    }

    // 3) Create + award
    const created = await prisma.locationPoint.create({
      data: {
        userId,
        mediaUrl: mediaUrl || '',
        placeId: placeId || null,   // 👈 persist it now
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
