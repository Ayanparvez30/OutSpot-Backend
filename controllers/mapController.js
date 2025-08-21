
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

    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: userId }, { receiverId: userId }]
      }
    });

    const friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId);

    const locations = await prisma.location.findMany({
      where: { userId: { in: friendIds } },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            totalPoints: true,
            minime: {
              select: { avatarUrl: true },
              where: { isSaved: true },
              take: 1
            }
          }
        }
      }
    });

    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);

    const locationsWithDetails = await Promise.all(locations.map(async (r) => {
      const friend = r.user;

      // Weekly challenge points
      const submissions = await prisma.submission.findMany({
        where: {
          userId: friend.id,
          createdAt: { gte: weekStart }
        },
        include: { challenge: true }
      });
      const challengePoints = submissions.reduce((sum, s) => sum + (s.challenge?.points || 0), 0);

      // Weekly location points
      const locationPoints = await prisma.locationPoint.findMany({
        where: {
          userId: friend.id,
          createdAt: { gte: weekStart }
        }
      });
      const mapPoints = locationPoints.reduce((sum, p) => sum + (p.points || 0), 0);

      const thisWeekPoints = challengePoints + mapPoints;

      return {
        userId: r.userId,
        username: r.user.username,
        firstName: r.user.firstName,
        lastName: r.user.lastName,
        avatarUrl: r.user.minime?.[0]?.avatarUrl || null,
        totalPoints: r.user.totalPoints || 0,
        thisWeekPoints,
        profileUrl: `/api/users/${r.userId}/profile`,
        latitude: r.latitude,
        longitude: r.longitude
      };
    }));

    res.json(locationsWithDetails);
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
exports.getRecentStoriesWithLocation = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { minLat, minLng, maxLat, maxLng } = req.query;

    // Fetch all friendships where status is ACCEPTED
    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: userId }, { receiverId: userId }]
      }
    });

    // Get IDs of friends
    const friendIds = friendships.map(f => f.requesterId === userId ? f.receiverId : f.requesterId);

    const whereBase = {
      // Get stories of the logged-in user, friends, and public stories with 'profile' visibility
      OR: [
        { userId }, // Get stories of the logged-in user
        { userId: { in: friendIds } }, // Get stories of friends
        {
          visibility: 'profile', // Publicly visible stories
          user: {
            OR: [
              { friendRequestsSent: { some: { receiverId: userId, status: 'ACCEPTED' } } }, // Sent requests accepted
              { friendRequestsReceived: { some: { requesterId: userId, status: 'ACCEPTED' } } } // Received requests accepted
            ]
          }
        }
      ],
      latitude: { not: null },
      longitude: { not: null },
      isInVault: false, // Ensure the story is not in the vault
    };

    // Apply geographical boundaries if provided
    if ([minLat, minLng, maxLat, maxLng].every(v => v !== undefined)) {
      whereBase.AND = [
        { latitude: { gte: parseFloat(minLat) } },
        { latitude: { lte: parseFloat(maxLat) } },
        { longitude: { gte: parseFloat(minLng) } },
        { longitude: { lte: parseFloat(maxLng) } }
      ];
    }

    // Fetch all stories that match the conditions, ordered by 'createdAt' in descending order
    const stories = await prisma.story.findMany({
      where: whereBase,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            minime: { select: { avatarUrl: true }, where: { isSaved: true }, take: 1 }
          }
        }
      },
      orderBy: { createdAt: 'desc' }, // Sort by the most recent stories first
    });

    // Map and return the stories with details
    res.json(stories.map(s => ({
      id: s.id,
      userId: s.userId,
      username: s.user.username,
      avatarUrl: s.user.minime?.[0]?.avatarUrl || null,
      mediaUrl: s.mediaUrl,
      type: s.type,
      latitude: s.latitude,
      longitude: s.longitude,
      createdAt: s.createdAt
    })));
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
