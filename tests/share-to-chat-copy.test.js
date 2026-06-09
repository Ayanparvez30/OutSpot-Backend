/**
 * Item 9 — share-to-chat persists imageUrl + copies story media to a chat-owned key.
 *
 *  • parseOwnS3Url: matches own bucket, rejects foreign hosts
 *  • materializeChatMedia:
 *      - foreign URL → pass through (best-effort, can't copy)
 *      - already chat-shares/ → pass through
 *      - already chat-images/ → pass through
 *      - users/<id>/media/ (story source) → COPY to chat-shares/<hex>.<ext>
 *      - copy failure → fall back to source URL (never blocks the send)
 *  • REST sendTextMessage: extracts imageUrl from body + persists on Message.imageUrl
 *  • REST sendTextMessage: text-only send (no imageUrl) still works (legacy regression)
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// Set env BEFORE any module load so the bucket/region are populated.
process.env.S3_BUCKET_NAME = 'outspot-test-bucket';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIA_TEST';
process.env.AWS_SECRET_ACCESS_KEY = 'secret_test';

// Stub @aws-sdk/client-s3 BEFORE s3Upload requires it. CopyObjectCommand stays
// inert; we record calls instead of hitting AWS.
const s3SdkPath = require.resolve('@aws-sdk/client-s3');
const copyCalls = [];
let copyShouldFail = false;
class FakeS3Client {
  async send(cmd) {
    if (cmd?.__kind === 'copy') {
      if (copyShouldFail) throw new Error('simulated S3 copy failure');
      copyCalls.push(cmd.input);
      return {};
    }
    if (cmd?.__kind === 'put' || cmd?.__kind === 'delete') return {};
    return {};
  }
}
const mkCmd = (kind) => function (input) { this.__kind = kind; this.input = input; };
require.cache[s3SdkPath] = {
  id: s3SdkPath, filename: s3SdkPath, loaded: true,
  exports: {
    S3Client: FakeS3Client,
    PutObjectCommand: mkCmd('put'),
    DeleteObjectCommand: mkCmd('delete'),
    CopyObjectCommand: mkCmd('copy'),
  },
};

const { parseOwnS3Url, materializeChatMedia, copyS3Object } = require('../utils/s3Upload');

(async () => {
  // ---------- 1. parseOwnS3Url ----------
  console.log('\n[1] parseOwnS3Url — bucket detection');

  eq('own bucket regional URL parses', parseOwnS3Url('https://outspot-test-bucket.s3.us-east-1.amazonaws.com/users/42/media/abc.jpg')?.key, 'users/42/media/abc.jpg');
  eq('own bucket short URL parses',    parseOwnS3Url('https://outspot-test-bucket.s3.amazonaws.com/chat-images/x.jpg')?.key, 'chat-images/x.jpg');
  eq('foreign bucket rejected',        parseOwnS3Url('https://other-bucket.s3.amazonaws.com/users/42/media/abc.jpg'), null);
  eq('non-S3 URL rejected',            parseOwnS3Url('https://example.com/photo.jpg'), null);
  eq('null safe',                      parseOwnS3Url(null), null);
  eq('empty string safe',              parseOwnS3Url(''), null);
  eq('non-string safe',                parseOwnS3Url(123), null);

  // ---------- 2. materializeChatMedia ----------
  console.log('\n[2] materializeChatMedia — pass-through + copy paths');

  copyCalls.length = 0;
  // foreign URL → pass through
  eq('foreign URL passes through unchanged',
    await materializeChatMedia('https://example.com/photo.jpg'),
    'https://example.com/photo.jpg');
  eq('no S3 copy attempted for foreign', copyCalls.length, 0);

  // already chat-shares
  copyCalls.length = 0;
  const alreadyShared = 'https://outspot-test-bucket.s3.us-east-1.amazonaws.com/chat-shares/abc.jpg';
  eq('chat-shares URL passes through', await materializeChatMedia(alreadyShared), alreadyShared);
  eq('no copy for chat-shares', copyCalls.length, 0);

  // already chat-images
  copyCalls.length = 0;
  const chatImage = 'https://outspot-test-bucket.s3.us-east-1.amazonaws.com/chat-images/abc.jpg';
  eq('chat-images URL passes through', await materializeChatMedia(chatImage), chatImage);
  eq('no copy for chat-images', copyCalls.length, 0);

  // null / empty → null
  eq('null in → null',   await materializeChatMedia(null), null);
  eq('empty in → null',  await materializeChatMedia(''), null);

  // ---------- 3. Story share triggers copy ----------
  console.log('\n[3] Story media URL → copied to chat-shares/');

  copyCalls.length = 0;
  const storyUrl = 'https://outspot-test-bucket.s3.us-east-1.amazonaws.com/users/42/media/story-hex.jpg';
  const copiedUrl = await materializeChatMedia(storyUrl);

  eq('one copy issued',                 copyCalls.length, 1);
  eq('copy source bucket',              copyCalls[0]?.Bucket, 'outspot-test-bucket');
  eq('copy source path',                copyCalls[0]?.CopySource, 'outspot-test-bucket/users/42/media/story-hex.jpg');
  ok('dest key under chat-shares/',     copyCalls[0]?.Key?.startsWith('chat-shares/'));
  ok('dest preserves .jpg extension',   copyCalls[0]?.Key?.endsWith('.jpg'));
  ok('returned URL is the new key',     copiedUrl.startsWith('https://outspot-test-bucket.s3.us-east-1.amazonaws.com/chat-shares/'));
  ok('returned URL is NOT the source',  copiedUrl !== storyUrl);

  // ---------- 4. Copy failure → fallback to source URL (never blocks) ----------
  console.log('\n[4] Copy failure → fallback to source URL');

  copyCalls.length = 0;
  copyShouldFail = true;
  const fallback = await materializeChatMedia(storyUrl);
  eq('fallback equals source', fallback, storyUrl);
  copyShouldFail = false;

  // ---------- 5. copyS3Object directly: throws on foreign URL ----------
  console.log('\n[5] copyS3Object rejects foreign sources');

  let threw = false;
  try {
    await copyS3Object('https://example.com/photo.jpg');
  } catch (e) {
    threw = true;
  }
  eq('copy on foreign URL throws', threw, true);

  // ---------- 6. REST sendTextMessage — extracts + persists imageUrl ----------
  console.log('\n[6] sendTextMessage REST — extracts imageUrl + persists');

  // Stub prisma minimal for sendTextMessage
  const prismaPath = require.resolve('@prisma/client');
  const created = [];
  const fakePrisma = {
    chat: {
      findUnique: async () => ({
        id: 7, isGroup: true, isCommunity: false, isLocked: false,
        communityId: null, name: 'A group', disappearingSeconds: null,
        users: [{ userId: 42, role: 'MEMBER', lastSeenMessageId: 0 }],
      }),
      update: async () => ({}),
      findMany: async () => [],
    },
    userOnChat: {
      upsert: async () => ({}),
      findFirst: async () => ({ role: 'MEMBER' }),
      updateMany: async () => ({}),
    },
    message: {
      create: async ({ data, include }) => {
        const row = { id: created.length + 1, isSystem: false, createdAt: new Date(), expiresAt: null, ...data, sender: { id: data.senderId, username: 'me', firstName: 'M', lastName: 'E', minime: [] } };
        created.push(row);
        return row;
      },
    },
    block: { findMany: async () => [] },
  };
  require.cache[prismaPath] = {
    id: prismaPath, filename: prismaPath, loaded: true,
    exports: { PrismaClient: function () { return fakePrisma; } },
  };

  // Stubs the controller pulls
  const chatHelpersPath = require.resolve('../utils/chatHelpers');
  require.cache[chatHelpersPath] = { id: chatHelpersPath, filename: chatHelpersPath, loaded: true, exports: { getBulkUnreadCounts: async () => new Map(), markChatAsRead: async () => {}, getChatReadStatus: async () => ({}) } };
  const weeklyPath = require.resolve('../utils/weeklyPoints');
  require.cache[weeklyPath] = { id: weeklyPath, filename: weeklyPath, loaded: true, exports: { getWeeklyPointsForUsers: async () => new Map(), getWeeklyPointsForUser: async () => 0 } };
  const socketPath = require.resolve('../utils/socket');
  require.cache[socketPath] = {
    id: socketPath, filename: socketPath, loaded: true,
    exports: { getIO: () => ({ to: () => ({ emit: () => {} }) }), deleteOwnMessages: async () => [] },
  };
  const realtimePath = require.resolve('../utils/realtime');
  require.cache[realtimePath] = { id: realtimePath, filename: realtimePath, loaded: true, exports: { toUser: () => {}, toUsers: () => {}, toGroup: () => {}, toCommunity: () => {}, toFriends: () => {} } };

  const chat = require('../controllers/chatController');

  function req(body) { return { authData: { id: 42 }, body }; }
  function res() {
    return { statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
  }

  // Send with imageUrl pointing at a story → message stored with copied URL
  copyCalls.length = 0;
  created.length = 0;
  const r1 = res();
  await chat.sendTextMessage(req({
    chatId: 7,
    content: 'Check out my story',
    imageUrl: 'https://outspot-test-bucket.s3.us-east-1.amazonaws.com/users/42/media/x.jpg',
  }), r1);
  eq('status 200',                    r1.statusCode, 200);
  eq('copy was made',                 copyCalls.length, 1);
  ok('persisted URL is chat-shares/', created[0]?.imageUrl?.includes('/chat-shares/'));
  eq('content preserved',             created[0]?.content, 'Check out my story');

  // Send WITHOUT imageUrl → text-only, unchanged behavior
  copyCalls.length = 0;
  created.length = 0;
  const r2 = res();
  await chat.sendTextMessage(req({ chatId: 7, content: 'just text' }), r2);
  eq('text-only 200',                 r2.statusCode, 200);
  eq('no copy attempted',             copyCalls.length, 0);
  eq('imageUrl null in DB',           created[0]?.imageUrl, null);

  // Empty content + imageUrl → still accepted (image-only caption-less share)
  copyCalls.length = 0;
  created.length = 0;
  const r3 = res();
  await chat.sendTextMessage(req({
    chatId: 7,
    content: '',
    imageUrl: 'https://outspot-test-bucket.s3.us-east-1.amazonaws.com/users/42/media/y.jpg',
  }), r3);
  eq('image-only 200',                r3.statusCode, 200);
  eq('content stored as null',        created[0]?.content, null);
  ok('persisted URL is chat-shares/', created[0]?.imageUrl?.includes('/chat-shares/'));

  // Neither content nor imageUrl → 400 (was 400 before too)
  const r4 = res();
  await chat.sendTextMessage(req({ chatId: 7 }), r4);
  eq('empty-empty 400', r4.statusCode, 400);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
