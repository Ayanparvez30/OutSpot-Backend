const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const uploadToS3 = require('../utils/s3Upload');

let getIO;
try { ({ getIO } = require('../utils/socket')); } catch (_) {}

const toBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
};

const parseIdArray = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  if (typeof v === 'string') {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.map(Number).filter(Number.isFinite);
    } catch (_) {}
    return v.split(',').map((s) => Number(String(s).trim())).filter(Number.isFinite);
  }
  return [];
};
exports.uploadMedia = async (req, res) => {
  const userId = req?.authData?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  let { chatIds, chatId, type, postToStory, latitude, longitude, visibility } = req.body;

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Validate media/story type to match your StoryType enum
  const ALLOWED = new Set(['IMAGE', 'VIDEO']);
  type = String(type || 'IMAGE').trim().toUpperCase();
  if (!ALLOWED.has(type)) {
    return res.status(400).json({ error: "Invalid 'type'. Use IMAGE or VIDEO" });
  }


  const chats = [...new Set(parseIdArray(chatIds || chatId))];
  const sendToChats = chats.length > 0;
  const alsoStory = toBool(postToStory);

  if (!sendToChats && !alsoStory) {
    return res.status(400).json({ error: 'Nothing to do. Provide chatIds and/or postToStory=true' });
  }

  const lat = latitude != null && latitude !== '' ? Number(latitude) : null;
  const lon = longitude != null && longitude !== '' ? Number(longitude) : null;

  try {

    const publicUrl = await uploadToS3(req.file, `users/${userId}/media`);

   
    if (sendToChats) {
      const membership = await prisma.userOnChat.findMany({
        where: { chatId: { in: chats }, userId },
        select: { chatId: true },
      });
      const allowed = new Set(membership.map((m) => m.chatId));
      const invalid = chats.filter((id) => !allowed.has(id));
      if (invalid.length) {
        return res.status(403).json({ error: 'You are not a member of some chats', invalidChatIds: invalid });
      }
    }

    const ops = [];
    let storyIdx = -1;

    if (alsoStory) {

      const storyVisibility = (visibility || 'profile').toLowerCase() === 'private' ? 'private' : 'profile';

      const storyData = {
        userId,
        mediaUrl: publicUrl,                        
        type: type === 'VIDEO' ? 'VIDEO' : 'IMAGE',  
        visibility: storyVisibility,         
        status: 'ACTIVE',                    
        latitude: lat ?? null,
        longitude: lon ?? null,
      };

      storyIdx = ops.push(prisma.story.create({ data: storyData })) - 1;
    }

    if (sendToChats) {
      for (const cid of chats) {
        const msgData = {
          chatId: cid,
          senderId: userId,
          content: null,        
          imageUrl: publicUrl, 
        };
        ops.push(
          prisma.message.create({
            data: msgData,
            include: { sender: { select: { id: true, username: true } } },
          })
        );
     
      }
    }

    const results = ops.length ? await prisma.$transaction(ops) : [];
    const story = storyIdx > -1 ? results[storyIdx] : null;


    const createdMessages = results
      .filter(r => r && typeof r.chatId === 'number')
      .map(m => ({
        id: m.id,
        chatId: m.chatId,
        content: m.content,
        imageUrl: m.imageUrl,
        createdAt: m.createdAt,
        sender: m.sender ? { id: m.sender.id, username: m.sender.username } : { id: userId },
      }));


    try {
      const io = typeof getIO === 'function' ? getIO() : req.app?.get('io');
      if (io && createdMessages.length) {
        for (const m of createdMessages) {
          io.to(`chat_${m.chatId}`).emit('newMessage', m);
        }
      }
    } catch (e) {
      console.error('Socket emit failed', e);
    }
    return res.json({
      message: 'Media processed successfully',
      fileUrl: publicUrl,
      story: story || null,
      messages: createdMessages,
      sentToChats: sendToChats ? chats : [],
    });
  } catch (err) {
    console.error('uploadMedia error', err);
    return res.status(500).json({ error: 'Upload failed', details: err.message });
  }
};


exports.saveToProfile = async (req, res) => {
  const authenticatedUserId = req.authData.id;
  const { storyId } = req.body;

  try {
    const story = await prisma.story.findUnique({
      where: { id: storyId },
      include: {
        user: {
          select: {
            id: true,
            friendRequestsSent: true,
            friendRequestsReceived: true,
            username: true
          }
        }
      }
    });
    if (!story) return res.status(404).json({ error: 'Story not found' });

    const isOwner = story.userId === authenticatedUserId;
    const isFriend =
      story.user.friendRequestsSent?.some(r => r.receiverId === authenticatedUserId && r.status === 'ACCEPTED') ||
      story.user.friendRequestsReceived?.some(r => r.requesterId === authenticatedUserId && r.status === 'ACCEPTED');

    if (!isOwner && !(isFriend && story.visibility === 'profile')) {
      return res.status(403).json({ error: 'You can only save your own stories or friends’ profile-visible stories' });
    }

    const existingSaved = await prisma.savedStory.findUnique({
      where: {
        userId_storyId_status: {
          userId: authenticatedUserId,
          storyId,
          status: 'SAVED'
        }
      }
    });
    if (existingSaved) return res.status(400).json({ error: 'Already saved to profile' });

    const savedStory = await prisma.savedStory.create({
      data: { userId: authenticatedUserId, storyId, status: 'SAVED' }
    });

    res.json({
      message: `Saved to your profile.`,
      savedStory
    });
  } catch (error) {
    console.error('Error saving story to profile:', error);
    res.status(500).json({ error: 'Failed to save story to profile' });
  }
};

exports.getSavedStories = async (req, res) => {
  const requesterId = req.authData.id;
  const { targetUserId } = req.query;
  const uid = targetUserId ? parseInt(targetUserId, 10) : requesterId;

  try {
    // target user info + privacy
    const targetUser = await prisma.user.findUnique({
      where: { id: uid },
      select: { id: true, isProfilePrivate: true }
    });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const isOwner = uid === requesterId;

    // are they friends?
    let isFriend = false;
    if (!isOwner) {
      const friendship = await prisma.friendship.findFirst({
        where: {
          status: 'ACCEPTED',
          OR: [
            { requesterId: requesterId, receiverId: uid },
            { requesterId: uid, receiverId: requesterId }
          ]
        }
      });
      isFriend = Boolean(friendship);
    }

    // profile privacy gate
    if (!isOwner && targetUser.isProfilePrivate && !isFriend) {
      return res.status(403).json({ error: 'This profile is private' });
    }

    // owner sees all SAVED; others only those whose story.visibility = 'profile' and not VAULT
    const savedStories = await prisma.savedStory.findMany({
      where: {
        userId: uid,
        status: 'SAVED',
        ...(isOwner
          ? {}
          : {
            story: {
              visibility: 'profile',
              NOT: { status: 'VAULT' }
            }
          })
      },
      include: {
        story: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                minime: {
                  where: { isSaved: true },
                  select: { avatarUrl: true },

                  orderBy: { updatedAt: 'desc' }
                }
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const stories = savedStories.map(s => {
      const u = s.story.user;
      const avatarUrl =
        Array.isArray(u.minime) && u.minime.length > 0 ? u.minime[0]?.avatarUrl || null : null;

      return {
        ...s.story,
        user: {
          id: u.id,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          avatarUrl
        }
      };
    });

    res.json({ savedStories: stories });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch saved stories' });
  }
};

exports.saveToVault = async (req, res) => {
  const userId = req.authData.id;
  const { storyId } = req.body;

  try {
    const story = await prisma.story.findUnique({
      where: { id: storyId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            friendRequestsSent: true,
            friendRequestsReceived: true
          }
        }
      }
    });
    if (!story) return res.status(404).json({ error: 'Story not found' });

    const isOwner = story.userId === userId;
    const isFriend =
      story.user.friendRequestsSent?.some(r => r.receiverId === userId && r.status === 'ACCEPTED') ||
      story.user.friendRequestsReceived?.some(r => r.requesterId === userId && r.status === 'ACCEPTED');

    if (!isOwner && !(isFriend && story.visibility === 'profile')) {
      return res.status(403).json({ error: 'You do not have permission to save this story to your vault' });
    }

    const existingVaultStory = await prisma.savedStory.findUnique({
      where: {
        userId_storyId_status: {
          userId,
          storyId,
          status: 'VAULT'
        }
      }
    });
    if (existingVaultStory) return res.status(400).json({ error: 'Already saved to vault' });

    const savedStory = await prisma.savedStory.create({
      data: { userId, storyId, status: 'VAULT' }
    });

    res.json({
      message: `Saved to your vault`,
      savedStory
    });
  } catch (error) {
    console.error('Error saving story to vault:', error);
    res.status(500).json({ error: 'Failed to save story to vault' });
  }
};

exports.getVaultStories = async (req, res) => {
  const userId = req.authData.id;

  try {
    const vaultStories = await prisma.savedStory.findMany({
      where: { userId, status: 'VAULT' },
      include: {
        story: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                username: true,
                minime: { select: { avatarUrl: true }, orderBy: { updatedAt: 'desc' } }
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ vaultStories: vaultStories.map(s => s.story) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch vault stories' });
  }
};

exports.removeStory = async (req, res) => {
  const userId = req.authData.id;
  const { storyId } = req.params;

  try {
    const story = await prisma.story.findUnique({ where: { id: parseInt(storyId, 10) } });
    if (!story || story.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Delete dependent SavedStory rows first to avoid FK issues
    await prisma.savedStory.deleteMany({ where: { storyId: story.id } });
    await prisma.story.delete({ where: { id: story.id } });

    res.json({ message: 'Story removed successfully.' });
  } catch (error) {
    console.error('Error removing story:', error);
    res.status(500).json({ error: 'Failed to remove story' });
  }
};
// controllers/mediaController.js → replace only this handler
exports.getStories = async (req, res) => {
  const userId = req.authData.id;

  // TTL minutes for feed window (dev: 5, prod: 24h)
  const STORY_TTL_MINUTES = Number(
    process.env.STORY_TTL_MINUTES || (process.env.NODE_ENV === 'development' ? 5 : 24 * 60)
  );
  const windowAgo = new Date(Date.now() - STORY_TTL_MINUTES * 60 * 1000);

  try {
    // 1) Find all communities the requester belongs to
    const myCommunities = await prisma.communityMember.findMany({
      where: { userId },
      select: { communityId: true }
    });
    const communityIds = myCommunities.map(c => c.communityId);
    const hasCommunities = communityIds.length > 0;

    // 2) Build friend condition (either direction, ACCEPTED)
    const friendOR = [
      { friendRequestsSent: { some: { receiverId: userId, status: 'ACCEPTED' } } },
      { friendRequestsReceived: { some: { requesterId: userId, status: 'ACCEPTED' } } }
    ];

    // 3) Build same-community condition (optional if you’re in any)
    const sameCommunityCond = hasCommunities
      ? { communities: { some: { communityId: { in: communityIds } } } }
      : undefined;

    // 4) Exclude blocked users (either direction)
    const notBlocked = {
      NOT: [
        { user: { blockedBy: { some: { blockerId: userId } } } }, // I blocked them
        { user: { blocks: { some: { blockedId: userId } } } }  // They blocked me
      ]
    };

    // 5) Query stories
    const stories = await prisma.story.findMany({
      where: {
        status: 'ACTIVE',
        createdAt: { gte: windowAgo },
        ...notBlocked,
        OR: [
          // a) my own stories (always show)
          { userId },

          // b) friends' profile-visible stories
          {
            visibility: 'profile',
            user: { OR: friendOR }
          },

          // c) same-community users' profile-visible stories
          ...(hasCommunities ? [{
            visibility: 'profile',
            user: sameCommunityCond
          }] : [])
        ]
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            // latest saved avatar only
            minime: { select: { avatarUrl: true }, take: 1, orderBy: { updatedAt: 'desc' } },
            Location: { select: { latitude: true, longitude: true } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ stories });
  } catch (error) {
    console.error('Error fetching stories:', error);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
};

exports.getMyStories = async (req, res) => {
  const userId = req.authData.id;

  const MY_STORY_TTL_MINUTES = Number(process.env.MY_STORY_TTL_MINUTES || 24 * 60);
  const windowAgo = new Date(Date.now() - MY_STORY_TTL_MINUTES * 60 * 1000);

  try {
    const stories = await prisma.story.findMany({
      where: {
        userId,
        status: 'ACTIVE',            // only active stories
        createdAt: { gte: windowAgo } // last 24h (or env override)
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,

            minime: { select: { avatarUrl: true }, take: 1, orderBy: { updatedAt: 'desc' } },
            Location: { select: { latitude: true, longitude: true } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const myStories = stories.map(s => {
      const u = s.user;
      const avatarUrl = Array.isArray(u.minime) && u.minime.length > 0 ? u.minime[0]?.avatarUrl || null : null;
      return {
        ...s,
        user: {
          id: u.id,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          avatarUrl
        }
      };
    });

    return res.json({ stories: myStories });
  } catch (error) {
    console.error('Error fetching my stories:', error);
    return res.status(500).json({ error: 'Failed to fetch your stories' });
  }
};

// exports.uploadMediaBulk = async (req, res) => {
//   const senderId = req.authData.id;

//   // Accept arrays or comma-separated strings
//   let {
//     type,
//     receiverIds,     // friends/users
//     groupIds,
//     communityIds,
//     // optional extras
//     postToStory,
//     latitude,
//     longitude
//   } = req.body;

//   try {
//     if (!req.file) {
//       return res.status(400).json({ error: 'No file uploaded' });
//     }

//     // Validate type
//     type = (type || '').toString().trim().toUpperCase();
//     const ALLOWED = new Set(['IMAGE', 'VIDEO']);
//     if (!ALLOWED.has(type)) {
//       return res.status(400).json({ error: "Invalid 'type'. Use IMAGE or VIDEO" });
//     }

//     // Parse targets
//     const userTargets       = toIdArray(receiverIds).filter(id => id !== senderId); // don’t send to self here
//     const groupTargets      = toIdArray(groupIds);
//     const communityTargets  = toIdArray(communityIds);

//     if (userTargets.length + groupTargets.length + communityTargets.length === 0) {
//       return res.status(400).json({ error: 'Provide at least one target: receiverIds, groupIds, or communityIds' });
//     }

//     // Safety cap to avoid abuse
//     const MAX_TARGETS = 100;
//     if (userTargets.length + groupTargets.length + communityTargets.length > MAX_TARGETS) {
//       return res.status(413).json({ error: `Too many targets. Max ${MAX_TARGETS}.` });
//     }

//     // Normalize optional flags/coords
//     const postToStoryBool = ((postToStory ?? '').toString().trim().toLowerCase() === 'true');
//     const lat = Number.isFinite(parseFloat(latitude)) ? parseFloat(latitude) : null;
//     const lng = Number.isFinite(parseFloat(longitude)) ? parseFloat(longitude) : null;

//     // Upload once to S3
//     const fileUrl = await uploadToS3(req.file, 'media');

//     // ----- permission checks -----
//     // 1) Users: must be friends (ACCEPTED) in either direction
//     const userPermissions = {};
//     if (userTargets.length) {
//       const friendships = await prisma.friendship.findMany({
//         where: {
//           status: 'ACCEPTED',
//           OR: userTargets.flatMap(targetId => ([
//             { requesterId: senderId, receiverId: targetId },
//             { requesterId: targetId, receiverId: senderId }
//           ]))
//         },
//         select: { requesterId: true, receiverId: true }
//       });

//       const okPairs = new Set(friendships.map(f => `${f.requesterId}-${f.receiverId}`));
//       for (const id of userTargets) {
//         const ok = okPairs.has(`${senderId}-${id}`) || okPairs.has(`${id}-${senderId}`);
//         userPermissions[id] = !!ok;
//       }
//     }

//     // 2) Groups: must be a member
//     // NOTE: if your schema name differs (e.g., GroupMember vs groupMember), adjust below.
//     const groupPermissions = {};
//     if (groupTargets.length) {
//       const myGroupMemberships = await prisma.groupMember.findMany({
//         where: { userId: senderId, groupId: { in: groupTargets } },
//         select: { groupId: true }
//       });
//       const allowedGroups = new Set(myGroupMemberships.map(g => g.groupId));
//       for (const gid of groupTargets) groupPermissions[gid] = allowedGroups.has(gid);
//     }

//     // 3) Communities: must be a member
//     const communityPermissions = {};
//     if (communityTargets.length) {
//       const myCommunityMemberships = await prisma.communityMember.findMany({
//         where: { userId: senderId, communityId: { in: communityTargets } },
//         select: { communityId: true }
//       });
//       const allowedCommunities = new Set(myCommunityMemberships.map(c => c.communityId));
//       for (const cid of communityTargets) communityPermissions[cid] = allowedCommunities.has(cid);
//     }

//     // ----- build create ops -----
//     const createOps = [];
//     const successes = { users: [], groups: [], communities: [] };
//     const failures  = { users: [], groups: [], communities: [] };

//     for (const uid of userTargets) {
//       if (userPermissions[uid]) {
//         createOps.push(prisma.media.create({
//           data: { senderId, fileUrl, type, receiverId: uid }
//         }));
//         successes.users.push(uid);
//       } else {
//         failures.users.push({ id: uid, reason: 'Not friends/permission denied' });
//       }
//     }

//     for (const gid of groupTargets) {
//       if (groupPermissions[gid]) {
//         createOps.push(prisma.media.create({
//           data: { senderId, fileUrl, type, groupId: gid }
//         }));
//         successes.groups.push(gid);
//       } else {
//         failures.groups.push({ id: gid, reason: 'Not a group member' });
//       }
//     }

//     for (const cid of communityTargets) {
//       if (communityPermissions[cid]) {
//         createOps.push(prisma.media.create({
//           data: { senderId, fileUrl, type, communityId: cid }
//         }));
//         successes.communities.push(cid);
//       } else {
//         failures.communities.push({ id: cid, reason: 'Not a community member' });
//       }
//     }

//     // Optionally also post to Story once
//     if (postToStoryBool) {
//       createOps.push(prisma.story.create({
//         data: {
//           userId: senderId,
//           mediaUrl: fileUrl,
//           type,
//           visibility: 'profile',
//           status: 'ACTIVE',
//           latitude: lat,
//           longitude: lng
//         }
//       }));
//     }

//     // Execute in a transaction
//     const results = await prisma.$transaction(createOps);

//     return res.json({
//       message: 'Bulk media processed.',
//       fileUrl,
//       createdCount: results.length - (postToStoryBool ? 1 : 0),
//       postedToStory: postToStoryBool,
//       successes,
//       failures
//     });
//   } catch (error) {
//     console.error('uploadMediaBulk error:', error);
//     return res.status(500).json({ error: 'Failed to send media in bulk' });
//   }
// };
