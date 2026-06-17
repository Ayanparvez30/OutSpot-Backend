# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OutSpot backend: an Express 5 + Prisma (MySQL) API server with a Socket.IO realtime layer and a server-rendered (EJS) admin panel. It powers a Flutter social/fitness app — location check-ins for points, daily/weekly challenges with AI photo verification, chat (DM/group/community/global) with disappearing messages, stories, friends, a points shop, and "minime" AI-generated avatars.

There is **no `start` script**. Run the server directly:

```bash
node server.js                       # production-style run
npx nodemon server.js                # dev (nodemon is a devDependency)
```

`server.js` sets `process.env.TZ = 'America/New_York'` before any other require — all cron windows and `new Date()` math assume Boston time unless `TZ` is overridden.

## Commands

```bash
# Prisma (MySQL — set DATABASE_URL in .env)
npx prisma migrate dev --name <desc>   # create + apply a migration in dev
npx prisma migrate deploy              # apply pending migrations (prod)
npx prisma generate                    # regenerate the client after schema edits
npx prisma studio                      # browse the DB

# Seeds / one-off scripts (plain node scripts in scripts/)
npm run seed:challenges                # = node scripts/seedChallenges.js
node scripts/seedAdmin.js              # create the admin panel login
node scripts/seedShop.js               # seed shop items
node scripts/backup-db.js              # manual mysqldump backup (also runs daily via cron)

# Tests — each file is a standalone node script, NOT a runner (jest/mocha absent).
node tests/<name>.test.js              # run one test; exits 1 on failure
```

Tests stub `prisma`, `googlePlaces`, S3, etc. via `require.cache` manipulation and assert with a local `assert()`/`eq()` helper, printing `Result: N passed, M failed` and calling `process.exit(FAIL > 0 ? 1 : 0)`. There is no aggregate "run all tests" command — run files individually, or loop over `tests/*.test.js` in a shell.

## Architecture

**Request flow:** `server.js` mounts every feature router under `/api` (all in `routes/*.js`, re-exported to controllers in `controllers/*.js`). The admin panel is a separate tree mounted under `/admin` with its own session middleware, EJS views (`views/`), and routers (`routes/admin/*` → `controllers/admin/*`), gated by `middlewares/adminAuth.js`.

**Two auth systems — do not mix them:**
- **App API** (`middlewares/authMiddleware.js` `checkAuth`): expects `Authorization: Bearer <token>` where the token is the user's `authorization` column (an opaque DB-stored token, *not* a JWT). Sets `req.authData = { id, email, ... }`. Most `/api` routes use this.
- **Admin panel** (`middlewares/adminAuth.js`): cookie session via `express-session` against the `AdminUser` table.
- `middlewares/authMiddleware.js` also exports `securityKey` (checks a `security_key` header against `process.env.SECURITY_KEY`).

**Response envelope:** `functions/response.js` is the standard for `/api` responses — `true_status(res, data, msg)` / `false_status(res, msg)` / `response_with_code(res, code, msg)`, all shaped `{ status, message, data? }`. Use these rather than raw `res.json` for consistency.

**Realtime — two distinct channels, keep them separate:**
- **Chat** uses named Socket.IO events (`sendMessage`, `newMessage`, `messageDelivered`, `messageRead`, `typing`, `messagesDeleted`, …), all handled inside `utils/socket.js`. This file is large and holds the *entire* chat protocol plus presence, delivery/read receipts, disappearing-message logic, and location updates.
- **Everything else** ("something changed, refetch" signals) goes through `utils/realtime.js`, which emits one `'realtime'` event with `{ type: "namespace.action", ...payload }`. Controllers call `realtime.toUser/toUsers/toFriends/toCommunity/toGroup(...)` instead of touching `io` directly. Rooms (`user:{id}`, `friendOf:{id}`, `community:{id}`, `chat_{id}`) are joined on socket connect. See `docs/REALTIME_FRONTEND.md` for the Flutter contract.

On connect, a socket auto-joins its `user:` room, all `friendOf:` rooms of its friends, every chat it belongs to, and every community it's a member of. `isUserOnline()` drives the push-vs-socket decision: a chat message goes over the socket to online recipients and an FCM push (via `firebaseAdmin`) only to offline ones.

**Disappearing messages** are subtle and span `utils/socket.js` + the cron in `server.js`:
- `disappearingSeconds === 1` = "disappear immediately" — cleared per-user on chat *exit* (`exitChat`/disconnect → `clearChatOnExit`), receiver-driven. A message is hard-deleted only once *every other member* has cleared past it.
- Timed modes (5m–6h) are **receiver-view-triggered**: `expiresAt` stays null at send and is stamped when the recipient reads; a per-minute cron in `server.js` deletes expired rows.
- Global chat = 12h TTL from send; group/community = 24h TTL from send.

**S3 cleanup is orphan-guarded.** Never blind-delete an S3 object: the same uploaded URL can be referenced by a chat message *and* a story *and* a saved story. Always go through `utils/s3Cleanup.js` `deleteS3IfOrphanBulk(urls)`, which counts references across **every** URL column in **every** table and deletes only when the count is zero. The DB row must be deleted *first*, then cleanup called. When you add a new model with a URL column, add a corresponding `.count()` check in `countReferences()` (`utils/s3Cleanup.js`) or it will leave orphans / delete live assets.

**Points** flow exclusively through `utils/points.js` `addPointsWithMultiplier(userId, base, reason, refId, tx)`, which applies the user's active multiplier, writes a `PointsLedger` row, and increments `User.totalPoints`. It is **tx-aware**: pass a transaction client to compose it inside `prisma.$transaction(...)`. When called with a real tx it does **not** emit the `user.points_changed` realtime signal (rows aren't committed yet) — the caller must emit after commit. Place check-in point values come from `utils/pointsForPlace.js` (price-level / ratings tiers).

**Challenges:** `Challenge` rows are scheduled (daily/weekly windows) by `schedulers/midnightChallengeScheduler.js` and notified via the cron block in `server.js`. Photo submissions are verified by `utils/challengeVerification.js` using OpenAI vision against per-challenge `VERIFICATION_HINTS`. Minime avatars are generated in `utils/minimeGen.js` (OpenAI image API + `sharp` compression + S3 upload).

**Cron jobs** all live in `server.js` (story expiry, disappearing-message cleanup, 02:00 UTC DB backup, daily/weekly challenge reminders, leaderboard prize reminders). Times are Boston-relative because of the `TZ` setting; the backup cron explicitly pins `timezone: 'UTC'`.

## Conventions

- Each module instantiates its own `new PrismaClient()` (no shared singleton). Follow the existing pattern in a file rather than introducing a global.
- Controllers are grouped by feature; routes are thin and delegate. Admin mirrors this under `controllers/admin/` and `routes/admin/`.
- Schema is a single `prisma/schema.prisma` (~50 models). After editing it, create a migration **and** run `prisma generate`. Migrations are timestamped dirs under `prisma/migrations/`.
- Realtime signal types are dotted `namespace.action` strings; reuse the existing room helpers in `utils/realtime.js` instead of calling `getIO().emit` directly from controllers.
