// utils/realtime.js
// -----------------------------------------------------------------------------
// Single source of truth for all NON-CHAT realtime signals.
//
// Controllers call these helpers instead of using io.emit() directly, so that
// fan-out targeting, the event envelope, and throttling all live in ONE place.
// Chat messaging keeps its own named socket events (newMessage, etc.) — this
// module is only for the lightweight "something changed, refetch" signals.
//
// Delivery model: every signal is emitted on a single socket channel named
// 'realtime' with shape { type, ...payload }. The Flutter RealtimeDispatcher
// listens to 'realtime' once and routes by `type` ("namespace.action").
//
// Rooms reused from utils/socket.js (joined on connect):
//   user:{id}        -> that one user
//   friendOf:{id}    -> all ONLINE friends of {id}  (no DB query needed)
//   community:{id}   -> all ONLINE members of a community
//   chat_{id}        -> all members of a chat/group
// -----------------------------------------------------------------------------

const { getIO } = require('./socket');

const CHANNEL = 'realtime';

// Throttle map: key -> last emit timestamp. Used for high-frequency signals
// (e.g. points) so a burst collapses to at most one emit per window per key.
const _lastEmit = new Map();

// Keys idle longer than this are pruned so the map can't grow unbounded as the
// number of distinct rooms/event-types seen over the process lifetime climbs.
// Far larger than any sane throttle window, so active throttling is untouched.
const THROTTLE_KEY_TTL_MS = 5 * 60 * 1000;

const _sweep = setInterval(() => {
  const cutoff = Date.now() - THROTTLE_KEY_TTL_MS;
  for (const [key, ts] of _lastEmit) {
    if (ts < cutoff) _lastEmit.delete(key);
  }
}, THROTTLE_KEY_TTL_MS);
if (_sweep.unref) _sweep.unref(); // never keep the process alive just for the sweep

function _throttled(key, ms) {
  if (!ms) return false;
  const now = Date.now();
  if (now - (_lastEmit.get(key) || 0) < ms) return true;
  _lastEmit.set(key, now);
  return false;
}

// Exposed for tests/observability only — current throttle-key count.
function _throttleKeyCount() {
  return _lastEmit.size;
}

function _emit(room, type, payload, throttleMs) {
  if (throttleMs && _throttled(`${room}:${type}`, throttleMs)) return;
  try {
    getIO().to(room).emit(CHANNEL, { type, ...payload });
  } catch (_) {
    /* socket not ready / not initialized — signals are best-effort */
  }
}

const realtime = {
  // user.* — only this user (points, profile, achievements, wardrobe)
  toUser(userId, type, payload = {}, opts = {}) {
    _emit(`user:${userId}`, type, payload, opts.throttleMs);
  },

  // explicit list of users (small fan-out, e.g. the two sides of a friendship)
  toUsers(userIds = [], type, payload = {}, opts = {}) {
    for (const id of new Set(userIds)) {
      _emit(`user:${id}`, type, payload, opts.throttleMs);
    }
  },

  // friend.* / story.* — all ONLINE friends of userId via the friendOf room
  toFriends(userId, type, payload = {}, opts = {}) {
    _emit(`friendOf:${userId}`, type, payload, opts.throttleMs);
  },

  // community.* — all ONLINE members of a community
  toCommunity(communityId, type, payload = {}, opts = {}) {
    _emit(`community:${communityId}`, type, payload, opts.throttleMs);
  },

  // group.* — all members of a group/community chat
  toGroup(chatId, type, payload = {}, opts = {}) {
    _emit(`chat_${chatId}`, type, payload, opts.throttleMs);
  },
};

// Test/observability hooks (not used by app code).
realtime._throttleKeyCount = _throttleKeyCount;
realtime._sweepThrottleKeys = (maxAgeMs = THROTTLE_KEY_TTL_MS) => {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, ts] of _lastEmit) {
    if (ts < cutoff) _lastEmit.delete(key);
  }
};
realtime._THROTTLE_KEY_TTL_MS = THROTTLE_KEY_TTL_MS;

module.exports = realtime;
