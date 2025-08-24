
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const toRad = d => (d * Math.PI)/180;
const haversine = (a,b)=>{ 
  const R=6371000, dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
  const A=Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(A));
};

exports.updateLocation = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const userId = req.authData.id;

    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'Invalid lat/lng' });
    }

    const last = await prisma.location.findUnique({ where: { userId } });

    if (!last) {
      await prisma.location.create({ data: { userId, latitude, longitude }});
      await prisma.locationHistory.create({ data: { userId, latitude, longitude }});
      return res.json({ moved: true, created: true });
    }

    const dist = haversine(
      { lat: last.latitude, lng: last.longitude },
      { lat: latitude, lng: longitude }
    );

    if (dist < 50) return res.json({ moved: false, dist });

    await prisma.location.update({ where: { userId }, data: { latitude, longitude }});
    await prisma.locationHistory.create({ data: { userId, latitude, longitude }});
    return res.json({ moved: true, dist });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
};
exports.getFriendLocations = async (req, res) => {
  try {
    const userId = req.authData.id;

    // 1) Friends
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: userId }, { receiverId: userId }]
      },
      select: { requesterId: true, receiverId: true }
    });

    if (friendships.length === 0) {
      return res.json([]);
    }

    const friendIds = friendships.map(f =>
      f.requesterId === userId ? f.receiverId : f.requesterId
    );

    // 2) Friends + their latest profile avatar + last known location (LEFT JOIN style)
    const friends = await prisma.user.findMany({
      where: { id: { in: friendIds } },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        totalPoints: true,
        // pick first saved minime avatar (most recent)
        minime: {
          where: { isSaved: true },
          select: { avatarUrl: true },
          take: 1,
          orderBy: { updatedAt: 'desc' }
        },
        // LEFT relation
        Location: {
          select: {
            latitude: true,
            longitude: true,
            updatedAt: true
          }
        }
      }
    });

    // 3) Weekly points (batch)
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);

    // Submissions for all friends
    const allSubs = await prisma.submission.findMany({
      where: {
        userId: { in: friendIds },
        createdAt: { gte: weekStart }
      },
      select: {
        userId: true,
        challenge: { select: { points: true } }
      }
    });

    // LocationPoints for all friends
    const allLocPts = await prisma.locationPoint.findMany({
      where: {
        userId: { in: friendIds },
        createdAt: { gte: weekStart }
      },
      select: { userId: true, points: true }
    });

    // Aggregate
    const subMap = new Map(); // userId -> sum
    for (const s of allSubs) {
      const prev = subMap.get(s.userId) || 0;
      subMap.set(s.userId, prev + (s.challenge?.points || 0));
    }

    const locMap = new Map(); // userId -> sum
    for (const p of allLocPts) {
      const prev = locMap.get(p.userId) || 0;
      locMap.set(p.userId, prev + (p.points || 0));
    }

    // 4) Shape response (include all friends, even if no Location row)
    const data = friends.map(u => {
      const avatarUrl =
        Array.isArray(u.minime) && u.minime.length > 0 ? u.minime[0]?.avatarUrl || null : null;

      const challengePoints = subMap.get(u.id) || 0;
      const mapPoints = locMap.get(u.id) || 0;
      const thisWeekPoints = challengePoints + mapPoints;

      return {
        userId: u.id,
        username: u.username,
        firstName: u.firstName,
        lastName: u.lastName,
        avatarUrl,
        totalPoints: u.totalPoints || 0,
        thisWeekPoints,
        profileUrl: `/api/users/${u.id}/profile`,
        latitude: u.Location?.latitude ?? null,
        longitude: u.Location?.longitude ?? null,
        lastUpdatedAt: u.Location?.updatedAt ?? null
      };
    });

 
    res.json(data);
  } catch (error) {
    console.error('Error fetching friend locations:', error);
    res.status(500).json({ error: 'Failed to fetch friend locations' });
  }
};


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
            { requesterId: targetUserId, receiverId: currentUserId }
          ]
        }
      });
      if (!friendship) return res.status(403).json({ error: 'Not authorized to view trail' });
    }

    const history = await prisma.locationHistory.findMany({
      where: { userId: targetUserId },
      orderBy: { createdAt: 'asc' }
    });

    res.json({ trail: history });
  } catch (error) {
    console.error('Error fetching trail:', error);
    res.status(500).json({ error: 'Failed to fetch visited trail' });
  }
};
// controllers/mediaController.js → replace only this handler
exports.getRecentStoriesWithLocation = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { minLat, minLng, maxLat, maxLng } = req.query;

    // TTL minutes for feed window (dev: 5, prod: 24h)
    const STORY_TTL_MINUTES = Number(
      process.env.STORY_TTL_MINUTES || (process.env.NODE_ENV === 'development' ? 5 : 24 * 60)
    );
    const windowAgo = new Date(Date.now() - STORY_TTL_MINUTES * 60 * 1000);

    // 1) Communities of requester
    const myCommunities = await prisma.communityMember.findMany({
      where: { userId },
      select: { communityId: true }
    });
    const communityIds = myCommunities.map(c => c.communityId);
    const hasCommunities = communityIds.length > 0;

    // 2) Friend condition (either direction, ACCEPTED)
    const friendOR = [
      { friendRequestsSent:     { some: { receiverId: userId,  status: 'ACCEPTED' } } },
      { friendRequestsReceived: { some: { requesterId: userId, status: 'ACCEPTED' } } }
    ];

    // 3) Same-community condition
    const sameCommunityCond = hasCommunities
      ? { communities: { some: { communityId: { in: communityIds } } } }
      : undefined;

    // 4) Exclude blocked (either way)
    const notBlocked = {
      NOT: [
        { user: { blockedBy: { some: { blockerId: userId } } } }, // I blocked them
        { user: { blocks:    { some: { blockedId:  userId } } } } // They blocked me
      ]
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
        ...(hasCommunities ? [{ visibility: 'profile', user: sameCommunityCond }] : [])
      ]
    };

    // 6) Optional bounding box filter
    if ([minLat, minLng, maxLat, maxLng].every(v => v !== undefined)) {
      whereBase.AND = [
        { latitude:  { gte: parseFloat(minLat) } },
        { latitude:  { lte: parseFloat(maxLat) } },
        { longitude: { gte: parseFloat(minLng) } },
        { longitude: { lte: parseFloat(maxLng) } }
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
            // latest saved avatar only
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              take: 1,
              orderBy: { updatedAt: 'desc' }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // 8) Return in the requested flat array format
    const payload = stories.map(s => ({
      id: s.id,
      userId: s.userId,
      username: s.user?.username || null,
      avatarUrl: s.user?.minime?.[0]?.avatarUrl || null,
      mediaUrl: s.mediaUrl,
      type: s.type,
      latitude: s.latitude,
      longitude: s.longitude,
      createdAt: s.createdAt
    }));

    res.json(payload);
  } catch (error) {
    console.error('Error fetching stories with location:', error);
    res.status(500).json({ error: 'Failed to fetch stories with location' });
  }
};


exports.searchOnMap = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ users: [], places: [] });

    const users = await prisma.user.findMany({
      where: {
        OR: [
          { username:  { contains: q } },
          { firstName: { contains: q } },
          { lastName:  { contains: q } }
        ]
      },
      select: {
        id: true,
        username: true,
        minime: {
          where: { isSaved: true },
          select: { avatarUrl: true },
          take: 1
        },
     
        Location: { select: { latitude: true, longitude: true } }
      },
      take: 20
    });

    const places = await prisma.locationPoint.findMany({
      where: { placeName: { contains: q } },
      select: { id: true, placeName: true, latitude: true, longitude: true, mediaUrl: true },
      take: 20
    });

    return res.json({
      users: users.map(u => ({
        id: u.id,
        username: u.username,
        avatarUrl: u.minime?.[0]?.avatarUrl || null,
     
        latitude:  u.Location?.latitude  ?? null,
        longitude: u.Location?.longitude ?? null
      })),
      places
    });
  } catch (error) {
    console.error('Error searching map:', error);
    return res.status(500).json({ error: 'Failed to search' });
  }
};
