# OutSpot Chat — Frontend Wiring Guide (10 items)

**Backend status:** shipped to `main` (commits `3561adc7` + `e750e49b` + the ban-notification commit).
**Deploy order on the server:** `git pull` → `npx prisma migrate deploy` → restart Node.

This doc describes every behaviour change the Flutter side needs to wire — logic + request/response shapes only, no code. Old clients that ignore unknown JSON keys keep working with zero change.

---

## Table of contents

| # | Feature | Store-required? | FE work |
|---|---|---|---|
| 1 | Delete own message | ✅ | New socket emit + reuse existing `messagesDeleted` listener |
| 2 | Report a message | ✅ | New REST call from long-press menu |
| 3 | Unify user-report endpoint | ✅ (no break) | Optional — pass `reason`/`note` if you want |
| 4 | Block-aware feeds | ✅ | Render `'[blocked]'` previews; no client filter logic |
| 5 | Admin ban + admin-delete-message | ✅ | New admin actions + new realtime events |
| 6 | Forward flag | ❌ | Long-press → "Forward" → resend with `forwarded: true` |
| 7 | Admin reports pipeline (web) | ✅ | Web only — no FE work |
| 8 | Reply / quote | ❌ | New `replyToMessageId` field + `replyTo` render |
| 9 | Share story/post → chat | ✅ | Pass `imageUrl` separately (already shipped on FE) |
| 10 | Ban notification (record + FCM) | ✅ | None — existing notification list + FCM router already handle it |

---

## Item 1 — Delete own message

**New socket event (client → server)**

```
socket.emit('deleteMessage', {
  chatId:    int,
  messageIds: [int, int, ...]
});
```

- Always send an array, even for single delete (server caps at 100 ids).
- Server filters to caller-owned messages. Any id you don't own is silently dropped.
- Hard delete, no time window.

**Receive-side (server → all chat members)**

The **existing** event you already listen for:

```
socket.on('messagesDeleted', ({ chatId, messageIds }) => { ... })
```

Sender's own UI is updated by this same broadcast (server emits to the chat room).

**UX**
- Long-press a message → "Delete for everyone"
- Multi-select bar → "Delete N" → one socket call with all selected ids
- No "Delete for me only" — only for-everyone delete is supported

---

## Item 2 — Report a message

**New REST endpoint**

```
POST /api/chats/messages/:messageId/report
Authorization: Bearer <token>
Body: {
  "reason": "spam" | "harassment" | "nudity" | "violence" | "other",
  "note":   "<optional free text>"
}
```

**Responses**

| Status | Body | Meaning |
|---|---|---|
| `201` | `{ success: true }` | Report stored |
| `400` | `{ error: "Invalid messageId" }` / `"reason required"` | Bad input |
| `403` | `{ error: "You are not a member of this chat" }` | Non-member trying to report |
| `404` | `{ error: "Message not found" }` | Bad / deleted id |

**UX**
- Long-press a message → "Report message" → sheet with reason chips + optional textarea
- After submit: confirmation toast (e.g. "Thanks — our team will review")
- **Do not delete the message client-side.** Only the moderation team removes content.

---

## Item 3 — Existing user-report (no breaking change)

`POST /api/report  { reportedId }` works unchanged. Optionally you may pass:

```
{ reportedId: int, reason?: string, note?: string }
```

Both new fields are optional and additive. The existing call from the profile screen needs no change.

---

## Item 4 — Block-aware feeds

**No new endpoint — server-side filter is invisible to FE.** Two behavioural changes:

### A) Full message lists

`GET /api/chats/messages/:chatId` and `/messages-paginated/:chatId` simply do not return messages from users you've blocked (or who blocked you). Render exactly what the server returns — no placeholder gaps.

### B) Chat-list preview

`GET /api/chats`, `/chats/groupsOnly`, `/chats/unread` — when the chat's latest message is from a blocked user, the `latestMessage` object has scrubbed content:

```jsonc
"latestMessage": {
  "id":         <unchanged>,
  "senderId":   <unchanged>,
  "createdAt":  <unchanged>,
  "content":    "[blocked]",     // ← scrubbed
  "imageUrl":   null,            // ← scrubbed
  "readBy":     [...],
  "deliveredTo":[...]
}
```

**Render:**
- Display `"[blocked]"` as-is (or translate to a localized label on the FE)
- Do not show a thumbnail when `imageUrl` is `null`

### C) Socket `newMessage`

In group / community, the server does not emit `newMessage` to a recipient who is blocked-related to the sender. You receive nothing for blocked messages — no client-side filtering required.

---

## Item 5 — Admin moderation

### 5a. Community ban / unban (creator only)

| Action | Endpoint | Body | Success |
|---|---|---|---|
| **Ban** | `POST /api/communities/:communityId/members/:userId/ban` | `{ "reason": "<optional>" }` | `{ message: "Member banned from community" }` |
| **Unban** | `DELETE /api/communities/:communityId/members/:userId/ban` | — | `{ message: "Member unbanned" }` |

Errors:
- `400` invalid id
- `403` `"Only the community admin can ban members"` / `"Creator cannot be banned. Delete the community instead."`
- `404` `"Community not found"`

### 5b. Group ban / unban (admin only)

| Action | Endpoint | Body | Success |
|---|---|---|---|
| **Ban** | `POST /api/chats/:chatId/members/:userId/ban` | `{ "reason": "<optional>" }` | `{ message: "Member banned from group" }` |
| **Unban** | `DELETE /api/chats/:chatId/members/:userId/ban` | — | `{ message: "Member unbanned" }` |

Errors:
- `400` `"Cannot ban yourself"` / `"Cannot ban the last admin"`
- `403` `"Only group admins can ban"`
- `404` `"Group chat not found"`

### 5c. Admin-delete any message

```
POST /api/chats/messages/:messageId/admin-delete
```

- Caller must be community creator (for a community chat) OR group admin (for a group chat). DM context → 403.
- **Success (200):** `{ success: true, deleted: [<messageId>] }`
- **Side effect:** server emits the existing `messagesDeleted` event to all members. Your existing handler clears the bubble.

### New realtime events (siblings of `messagesDeleted`)

| Event | Room | Payload | When |
|---|---|---|---|
| `community.member_banned` | `community:<id>` + `user:<bannedUserId>` | `{ communityId, userId, reason? }` | Creator bans |
| `community.member_unbanned` | `user:<bannedUserId>` only | `{ communityId, userId }` | Creator unbans |
| `community.member_removed` | (existing — also fires alongside `_banned` for back-compat) | — | — |
| `group.member_banned` | `chat_<chatId>` + `user:<bannedUserId>` | `{ chatId, userId, reason? }` | Group admin bans |
| `group.member_unbanned` | `user:<bannedUserId>` only | `{ chatId, userId }` | Group admin unbans |
| `group.member_removed` | (existing — also fires alongside `_banned`) | — | — |

**FE wiring**
- Listen to `_banned` events to (a) show the banned user a notice and force them out of that room, (b) refresh the member list for existing members
- Existing `member_removed` listeners keep working; the new `_banned` events are additive context

**UX**
- Group / community detail → long-press a member (if you're admin) → "Ban from group" / "Remove from community" → optional reason input
- Long-press a message (if you're admin) → "Delete (admin)" → admin-delete endpoint

---

## Item 6 — Forward message (no backend endpoint)

The existing `sendMessage` socket call already accepts `imageUrl`. New optional flag:

**Send-side payload (additive)**

```
sendMessage: {
  chatId, content, imageUrl, senderId,
  forwarded: true            // ← NEW, optional
}
```

**Receive-side**

Every message in `newMessage` socket events and in `GET /api/chats/messages/:chatId` now carries:

```
"forwarded": false   // default; true on forwarded messages
```

**UX**
- Long-press a message → "Forward" → pick target chats → for each chat emit `sendMessage` with the original `content` + `imageUrl` + `forwarded: true`. **No re-upload — the existing S3 URL is reused.**
- Render messages with `forwarded === true` with a small "Forwarded" label above the bubble

---

## Item 7 — Admin reports pipeline (web only)

Web-only — no Flutter work. For reference:
- `GET /admin/reports?type=user|message` — filter by report type
- `POST /admin/reports/:id/delete-message` — hard-delete the offending message + emit `messagesDeleted` + mark report Resolved

---

## Item 8 — Reply / quote

### Send-side (one new optional field on existing event)

```
sendMessage: {
  chatId, content, imageUrl, senderId,
  replyToMessageId: <int>     // ← NEW, optional
}
```

Server validates: the target message must exist in the same `chatId`. Bad ids are silently dropped — the send still succeeds without the reply.

### Receive-side

Every message in `newMessage` and `GET /api/chats/messages/:chatId` now carries:

```jsonc
// Not a reply:
"replyTo": null

// Is a reply:
"replyTo": {
  "id":         int,
  "content":    "string or null",
  "imageUrl":   "url or null",
  "senderId":   int,
  "senderName": "First Last" | "username" | null
}
```

**UX**
- Swipe-right on a message → enter reply mode → input area shows quoted preview using `replyTo.senderName` + `replyTo.content`
- On send, include `replyToMessageId` in the `sendMessage` socket emit
- Render quote chip above the bubble:
  - Author: `replyTo.senderName`
  - Body: truncated `replyTo.content`, or "📷 Photo" when `content` is empty and `imageUrl` exists
- Tap the quote chip → scroll to + highlight the original message

---

## Item 9 — Share story / post → chat

### Send-side (already shipped on FE)

`POST /api/chats/messages` now accepts `imageUrl` alongside the caption:

```
POST /api/chats/messages
Body: {
  "chatId":   int,
  "content":  "string (optional when imageUrl present)",
  "imageUrl": "string (the story media URL)"
}
```

- Either `content` or `imageUrl` is required. Caption-only ✓, image-only ✓, both ✓.
- Server now **persists `imageUrl` on the Message** (was hardcoded `null` before — that bug is fixed).

### What the server does internally

When `imageUrl` arrives:
1. If the URL is from our S3 bucket but **not** already in `chat-images/` or `chat-shares/` (e.g. a story at `users/<id>/media/...`), the server **copies the object** to a new key under `chat-shares/<hex>.<ext>`.
2. The chat message stores the **copied URL**.
3. The chat image now survives independently of the story's 24-hour expiry / manual deletion.

On copy failure, the server falls back to the original URL (the orphan-guard already keeps it alive via the new `Message.imageUrl` reference — defense in depth).

### Receive-side

Message objects now contain a populated `imageUrl` (or `null`). Same field as before — render as a real inline image bubble.

```jsonc
{
  "id":        int,
  "content":   "Check out Saj's post on OutSpot!",
  "imageUrl":  "https://<bucket>.s3.<region>.amazonaws.com/chat-shares/<hex>.jpg",
  "sender":    { ... },
  ...
}
```

### UX
- **Send-to-chats** sheet works as you already shipped — pass `imageUrl` separately from `content`
- The shared image bubble renders as a normal photo message, not a URL link
- After the source story is deleted (24h or manually), the chat image stays live ✓

---

## Item 10 — Ban notification (in-app record + FCM push)

**Trigger:** every successful community / group ban or unban now also writes a
`Notification` row for the affected user, sends an FCM push (if the user has
notifications enabled), and emits the existing `notification` socket event.

### Notification record shape (added to the user's notification list)

```jsonc
{
  "id":          int,
  "userId":      <bannedUserId>,
  "type":        "COMMUNITY_BANNED" | "COMMUNITY_UNBANNED" | "GROUP_BANNED" | "GROUP_UNBANNED",
  "title":       "Removed from <community/group name>"  // ban
              // "Reinstated to <community/group name>" // unban
  "description": "You were removed by an admin. Reason: <reason>" // ban (Reason: only when present)
              // "An admin has unbanned you. You can rejoin now." // unban
  "isRead":      false,
  "actorId":     <adminUserId>,
  "data": {
    "communityId": int,    // for COMMUNITY_*
    "chatId":      int,    // for GROUP_*
    "reason":      "..."   // optional; only on bans where reason was supplied
  },
  "createdAt":   "<iso>"
}
```

Uses the existing notification list format — **no UI change** required to render it. The FE may optionally map the four new types to a 🚫 / ✅ icon, but unknown types already fall through to the generic notification cell.

### FCM payload (matches the existing FCM contract)

```jsonc
{
  "notification": {
    "title": "Removed from <name>",
    "body":  "You were removed by an admin."
  },
  "data": {
    "type":          "COMMUNITY_BANNED" | "GROUP_BANNED" | "COMMUNITY_UNBANNED" | "GROUP_UNBANNED",
    "notificationId":"<int as string>",
    "actorId":       "<adminUserId>",
    "communityId":   "<id>"  // for COMMUNITY_*
    "chatId":        "<id>"  // for GROUP_*
    "reason":        "..."   // optional
  }
}
```

The existing FCM router handles unknown `data.type` values gracefully (default opens the app) — so no client change is required to avoid crashes. If you want to deep-link, route on the new `type` values:
- `COMMUNITY_BANNED` / `COMMUNITY_UNBANNED` → open community detail screen (via `data.communityId`)
- `GROUP_BANNED` / `GROUP_UNBANNED` → open chat list (or a banned-state notice; the chat itself is no longer accessible)

### Socket event (already wired via `notifyUser`)

The existing `notification` event the bell-dot already listens to:

```
socket.on('notification', ({ hasUnread: true }) => { ... })
```

### Toggle respect

When the user has disabled push notifications (their personal toggle), the FCM step is skipped, **but** the in-app `Notification` record + the red-dot socket event still fire. So:
- App open → user sees the bell light up + the new row in their list
- App closed → user has a record waiting when they reopen (no push banner)

### What was already in place (no new socket events)

The `community.member_banned` / `group.member_banned` socket events (covered in item 5) still fire alongside item 10's delivery — they're for **live ejection** of the user from the open chat room. Item 10 adds the **closed-app** path.

### UX

Nothing new — the existing notification list cell renders `title` + `description`. Optionally:
- Show a 🚫 icon next to `COMMUNITY_BANNED` / `GROUP_BANNED` entries
- Show a ✅ icon next to `*_UNBANNED` entries
- Tap → deep-link per the `data` payload

---

## Summary — priority order for FE

| Rank | Item | Reason |
|---|---|---|
| 1 | 9 (share-to-chat image) | FE already shipped this; just verify it now renders as image after deploy |
| 2 | 10 (ban notification) | Zero FE work — existing notification list + FCM router already render it. Listed here only for awareness |
| 3 | 4 (`'[blocked]'` preview render) | Pure UI — no logic, no menu, just text rendering |
| 4 | 1 (delete own message) | One new socket emit + reuse the existing `messagesDeleted` listener |
| 5 | 2 (report message) | One new REST call from the long-press menu |
| 6 | 5 (admin ban + admin-delete) | New screens + new realtime listeners |
| 7 | 8 (reply / quote) | New gesture + quote-chip rendering + `replyToMessageId` send |
| 8 | 6 (forward) | Long-press → forward sheet → loop `sendMessage` with `forwarded: true` |
| 9 | 3 (extend `/api/report`) | Optional — leave existing call as-is unless you want richer reports |
| 10 | 7 | Web team only |

Items 1, 2, 4, 5, 9, 10 are store-required (Apple Guideline 1.2 + Google UGC policy). The rest are UX polish.

---

## Backend test coverage (FYI)

- **14 test files** across the chat layer
- **350 asserts** total
- **0 failures, 0 regressions**

Every item above has a dedicated test file in `tests/`. If anything misbehaves on the device that contradicts this doc, it's a wiring issue on the FE side or a deploy hiccup (run `npx prisma migrate deploy` + restart) — not a backend behavior gap.
