// controllers/locationMapController.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ✅ weekly points single source of truth (pointsLedger.finalPoints)
const { getWeeklyPointsForUsers } = require('../utils/weeklyPoints');
const realtime = require('../utils/realtime');

// -------------------- helpers --------------------
const toRad = (d) => (d * Math.PI) / 180;
const haversine = (a, b) => {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const A =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(A));
};

const firstAvatar = (minimeArr) =>
  Array.isArray(minimeArr) && minimeArr.length > 0
    ? (minimeArr[0]?.avatarUrl || null)
    : null;

// -------------------- updateLocation --------------------
exports.updateLocation = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const userId = req.authData.id;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ error: 'Invalid lat/lng' });
    }

    const last = await prisma.location.findUnique({ where: { userId } });

    if (!last) {
      await prisma.location.create({ data: { userId, latitude, longitude } });
      await prisma.locationHistory.create({ data: { userId, latitude, longitude } });
      realtime.toFriends(userId, 'friend.location_updated', { userId, latitude, longitude }, { throttleMs: 5000 });
      return res.json({ moved: true, created: true });
    }

    const dist = haversine(
      { lat: last.latitude, lng: last.longitude },
      { lat: latitude, lng: longitude }
    );

    // movement threshold (env override optional)
    const MIN_MOVE_METERS = Number(process.env.LOCATION_MIN_MOVE_METERS || 50);
    if (dist < MIN_MOVE_METERS) return res.json({ moved: false, dist });

    await prisma.location.update({ where: { userId }, data: { latitude, longitude } });
    await prisma.locationHistory.create({ data: { userId, latitude, longitude } });

    realtime.toFriends(userId, 'friend.location_updated', { userId, latitude, longitude }, { throttleMs: 5000 });
    return res.json({ moved: true, dist });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
};

// -------------------- getFriendLocations --------------------
exports.getFriendLocations = async (req, res) => {
  try {
    const userId = req.authData.id;

    // 1) Friends
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: userId }, { receiverId: userId }],
      },
      select: { requesterId: true, receiverId: true },
    });

    if (friendships.length === 0) {
      return res.json([]);
    }

    const friendIds = friendships.map((f) =>
      f.requesterId === userId ? f.receiverId : f.requesterId
    );

    // 2) Friends + latest avatar + last known location
    const friends = await prisma.user.findMany({
      where: { id: { in: friendIds } },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        totalPoints: true,
        minime: {
          where: { isSaved: true },
          select: { avatarUrl: true },
          take: 1,
          orderBy: { updatedAt: 'desc' },
        },
        Location: {
          select: {
            latitude: true,
            longitude: true,
            updatedAt: true,
          },
        },
      },
    });

    // 3) Weekly points (ledger-based, batched)
    const weekMap = await getWeeklyPointsForUsers(friendIds);

    // 4) Shape response
    const data = friends.map((u) => ({
      userId: u.id,
      username: u.username,
      firstName: u.firstName,
      lastName: u.lastName,
      avatarUrl: firstAvatar(u.minime),
      totalPoints: u.totalPoints || 0,
      thisWeekPoints: weekMap.get(u.id) || 0,
      profileUrl: `/api/users/${u.id}/profile`,
      latitude: u.Location?.latitude ?? null,
      longitude: u.Location?.longitude ?? null,
      lastUpdatedAt: u.Location?.updatedAt ?? null,
    }));

    res.json(data);
  } catch (error) {
    console.error('Error fetching friend locations:', error);
    res.status(500).json({ error: 'Failed to fetch friend locations' });
  }
};

// -------------------- getVisitedTrail --------------------
exports.getVisitedTrail = async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId, 10);
    const currentUserId = req.authData.id;

    if (Number.isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Bad userId' });
    }

    if (targetUserId !== currentUserId) {
      const friendship = await prisma.friendship.findFirst({
        where: {
          status: 'ACCEPTED',
          OR: [
            { requesterId: currentUserId, receiverId: targetUserId },
            { requesterId: targetUserId, receiverId: currentUserId },
          ],
        },
      });
      if (!friendship) return res.status(403).json({ error: 'Not authorized to view trail' });
    }

    const history = await prisma.locationHistory.findMany({
      where: { userId: targetUserId },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ trail: history });
  } catch (error) {
    console.error('Error fetching trail:', error);
    res.status(500).json({ error: 'Failed to fetch visited trail' });
  }
};

// -------------------- mediaController.getRecentStoriesWithLocation --------------------
exports.getRecentStoriesWithLocation = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { minLat, minLng, maxLat, maxLng } = req.query;

    const STORY_TTL_MINUTES = Number(
      process.env.STORY_TTL_MINUTES ||
        (process.env.NODE_ENV === 'development' ? 5 : 24 * 60)
    );
    const windowAgo = new Date(Date.now() - STORY_TTL_MINUTES * 60 * 1000);

    // 1) Communities of requester
    const myCommunities = await prisma.communityMember.findMany({
      where: { userId },
      select: { communityId: true },
    });
    const communityIds = myCommunities.map((c) => c.communityId);
    const hasCommunities = communityIds.length > 0;

    // 2) Friend condition (either direction, ACCEPTED)
    const friendOR = [
      { friendRequestsSent: { some: { receiverId: userId, status: 'ACCEPTED' } } },
      { friendRequestsReceived: { some: { requesterId: userId, status: 'ACCEPTED' } } },
    ];

    // 3) Same-community condition
    const sameCommunityCond = hasCommunities
      ? { communities: { some: { communityId: { in: communityIds } } } }
      : undefined;

    // 4) Exclude blocked (either way)
    const notBlocked = {
      NOT: [
        { user: { blockedBy: { some: { blockerId: userId } } } }, // I blocked them
        { user: { blocks: { some: { blockedId: userId } } } }, // They blocked me
      ],
    };

    // 5) Base where
    const whereBase = {
      status: 'ACTIVE',
      createdAt: { gte: windowAgo },
      latitude: { not: null },
      longitude: { not: null },
      ...notBlocked,
      OR: [
        // a) My own stories
        { userId },

        // b) Friends' profile-visible stories
        { visibility: 'profile', user: { OR: friendOR } },

        // c) Same-community users' profile-visible stories
        ...(hasCommunities ? [{ visibility: 'profile', user: sameCommunityCond }] : []),
      ],
    };

    // 6) Optional bounding box filter
    if ([minLat, minLng, maxLat, maxLng].every((v) => v !== undefined)) {
      whereBase.AND = [
        { latitude: { gte: parseFloat(minLat) } },
        { latitude: { lte: parseFloat(maxLat) } },
        { longitude: { gte: parseFloat(minLng) } },
        { longitude: { lte: parseFloat(maxLng) } },
      ];
    }

    // 7) Fetch stories
    const stories = await prisma.story.findMany({
      where: whereBase,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              take: 1,
              orderBy: { updatedAt: 'desc' },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // 8) Shape payload
    const payload = stories.map((s) => ({
      id: s.id,
      userId: s.userId,
      username: s.user?.username || null,
      avatarUrl: firstAvatar(s.user?.minime),
      mediaUrl: s.mediaUrl,
      type: s.type,
      latitude: s.latitude,
      longitude: s.longitude,
      createdAt: s.createdAt,
    }));

    res.json(payload);
  } catch (error) {
    console.error('Error fetching stories with location:', error);
    res.status(500).json({ error: 'Failed to fetch stories with location' });
  }
};

// -------------------- searchOnMap --------------------
exports.searchOnMap = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ users: [], places: [] });

    const users = await prisma.user.findMany({
      where: {
        OR: [
          { username: { contains: q } },
          { firstName: { contains: q } },
          { lastName: { contains: q } },
        ],
      },
      select: {
        id: true,
        username: true,
        minime: {
          where: { isSaved: true },
          select: { avatarUrl: true },
          take: 1,
          orderBy: { updatedAt: 'desc' },
        },
        Location: { select: { latitude: true, longitude: true } },
      },
      take: 20,
    });

    const places = await prisma.locationPoint.findMany({
      where: { placeName: { contains: q } },
      select: { id: true, placeName: true, latitude: true, longitude: true, mediaUrl: true },
      take: 20,
    });

    return res.json({
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        avatarUrl: firstAvatar(u.minime),
        latitude: u.Location?.latitude ?? null,
        longitude: u.Location?.longitude ?? null,
      })),
      places,
    });
  } catch (error) {
    console.error('Error searching map:', error);
    return res.status(500).json({ error: 'Failed to search' });
  }
};
