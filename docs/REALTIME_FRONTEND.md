# Realtime — Flutter Integration Guide

How the backend pushes "something changed, refresh" signals, and exactly what
the Flutter app should do with them.

---

## 1. The model (read this first)

- **REST stays the source of truth.** Realtime does NOT carry the new data.
- A realtime signal only says *"X changed — refetch the relevant REST endpoint."*
- The app calls the same REST APIs it already uses, just triggered by a signal
  instead of a manual pull-to-refresh.

```
backend mutation ──emit──▶ socket 'realtime' event { type, ...ids }
                                      │
                          RealtimeDispatcher (app singleton)
                                      │  route by `type`
                                      ▼
                       controller.requestFetchX()  (debounced, SILENT)
                                      ▼
                          existing REST call → UI updates in place
```

---

## 2. Transport

- **One socket** (the existing messages socket): `ws://<host>:<port>?userId=<id>`.
- All non-chat signals arrive on a **single event channel: `'realtime'`**.
- Payload shape is always: `{ "type": "namespace.action", ...extraIds }`.
  - `type` is the router key (e.g. `friend.request_accepted`).
  - extra fields are flat (e.g. `userId`, `communityId`, `chatId`, `storyId`).
- Chat messaging keeps its **own existing named events** (`newMessage`,
  `messageRead`, `chatRead`, `messageDelivered`, `newChat`, `messagesDeleted`) —
  those are unchanged. `'realtime'` is only for the non-chat signals below.

Listen ONCE, globally:

```dart
socket.on('realtime', (data) => RealtimeDispatcher.instance.dispatch(data));
```

---

## 3. Event catalogue

| `type` | Who receives it | Flutter action (refetch) |
|--------|-----------------|--------------------------|
| `friend.request_received`   | the receiver        | pending-requests badge + list |
| `friend.request_accepted`   | both users          | friend list, chat list (new DM), profile counts, map |
| `friend.request_declined`   | the other party     | requests / sent list |
| `friend.removed`            | both users          | friend list, counts, chat list (DM gone), map |
| `friend.location_updated`   | friends (throttled 5s) | map markers / distance |
| `community.member_added`    | community members + joiner | community detail member list, NoCommunity/joined-status |
| `community.member_removed`  | community members + removed user | same |
| `community.details_updated` | community members   | name / image wherever shown |
| `community.deleted`         | community members   | remove from lists |
| `group.member_added`        | group chat members + added users | group member list, participant count |
| `group.member_removed`      | group chat members + removed user | same |
| `group.member_left`         | group chat members  | same |
| `story.posted`              | friends             | Explore feed, map story markers |
| `story.removed`             | friends + owner     | remove from feed/map, owner story count |
| `story.expired`             | friends + owner     | same |
| `user.points_changed`       | the user (throttled 1.5s) | coins/diamonds, leaderboard rank, header pills |
| `user.avatar_updated`       | friends             | avatar everywhere (chat list, friend list, map) |
| `wardrobe.outfit_equipped`  | the user            | my avatar, wardrobe |
| `wardrobe.item_purchased`   | the user            | shop "owned", wardrobe |
| `challenge.submitted`       | the user            | challenge card state |

> Add/remove are symmetric: every "added/accepted" has a matching "removed/declined/expired",
> so screens that fill in realtime also empty out in realtime.

---

## 4. The technique (build this once, reuse everywhere)

### 4.1 RealtimeDispatcher — single app-level singleton
- Subscribes to the socket `'realtime'` event **once**, lives above all screens.
- It receives signals **even when the target screen is not visible**, because it
  is global — this is what kills the "controller thought it had fresh data" bug.
- Routes by `type` to the matching controller's `requestFetchX()`.

### 4.2 Debounce per fetcher (our chosen dedup strategy)
- Both the socket signal AND the FCM fallback (section 4.5) call the **same**
  `requestFetchX()` — never `fetchX()` directly.
- `requestFetchX()` is debounced ~800ms: rapid/duplicate signals (socket + FCM,
  or a burst of tile updates) collapse into **one** actual fetch.
- No backend event-id needed. (If we ever move to payload-carrying events, switch
  to id-dedup; for signal+refetch, debounce is enough.)

```dart
Timer? _d;
void requestFetchChats() {
  _d?.cancel();
  _d = Timer(const Duration(milliseconds: 800), () => fetchChats(silent: true));
}
```

### 4.3 SILENT fetch — never show a loading indicator on realtime
- `fetchX({bool silent = false})`. Realtime always passes `silent: true`.
- `silent: true` ⇒ do **not** toggle `isLoading`, do **not** clear the list first.
- Update the reactive state **in place** (Obx/GetX), ideally diff-merge so only
  changed tiles move — no flicker, no scroll jump. The user must not see a reload.
- Spinner is for **user-initiated** loads only (first open, pull-to-refresh).

### 4.4 Dirty-flag for off-screen controllers
- If a controller is alive in the back stack but its screen is not visible:
  on signal, set `_dirty = true` — do **not** fetch.
- On screen resume / becoming visible: `if (_dirty) { fetchX(silent: true); _dirty = false; }`.
- Result: no wasted background fetch while away, but guaranteed fresh on return.
  The dispatcher (being global) is what sets `_dirty` even while off-screen.

### 4.5 Reconnect-refetch (mandatory safety net)
- Socket disconnects WILL happen; signals during a disconnect are lost.
- On socket **reconnect**, silently refetch the currently-visible screen(s).
  This heals any missed signals. Without this, realtime is best-effort only.

### 4.6 FCM background fallback
- When the app is backgrounded the socket is suspended.
- An FCM data message wakes the app; in `onMessage`, call the same
  `requestFetchX()` (debounced) — it dedups against any socket signal.
- Foreground: socket wins (faster); the later FCM is debounced away.

---

## 5. Profile screens (stats stay fresh)

- **My own profile**: most stat changes already signal my `user:` room
  (`friend.request_accepted/removed`, `community.member_*`, `user.points_changed`,
  `challenge.submitted`, `story.removed/expired`). Route these to the profile
  controller too → silent refetch → friend count / points / story count auto-correct,
  whether I or someone else triggered the change.
- **Viewing someone else's profile**: signals that reach `friendOf` (their
  `story.*`, `user.avatar_updated`, `friend.location_updated`) update live. Deeper
  stat changes (e.g. they friended a third person) do NOT live-update — but the
  profile refetches on open/resume (dirty-flag), so it is always fresh when opened.

---

## 6. Per-controller checklist (apply to every screen)

1. `fetchX({silent})` exists; realtime passes `silent: true`.
2. A debounced `requestFetchX()` wrapper; socket + FCM both call it.
3. Register the relevant `type`s with the dispatcher → `requestFetchX()`.
4. In-place reactive update (no clear, no spinner) on silent fetch.
5. `_dirty` set when off-screen; consumed on resume.
6. Refetch on socket reconnect.
7. After a user action (Add Friend / Accept / Leave …) update the affected item's
   state immediately too (optimistic), so the badge flips without waiting.

---

## 7. Notes / not-yet

- Multi-instance scaling (Redis socket.io adapter) is deferred to the server
  scaling work. Until then the backend runs as a **single instance** — realtime
  is correct as-is. Do not assume multi-region until that lands.
- `friend.request_declined` carries no notification (silent by design).
- Removed group/community members keep their socket-room membership until the
  next reconnect; the `*_removed` signal to their `user:` room tells them to
  refresh and leave the screen, so this is not user-visible.
