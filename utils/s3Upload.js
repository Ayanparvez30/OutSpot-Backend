const { S3Client, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");
const path = require("path");

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const uploadToS3 = async (file, folder = "uploads") => {
  const fileExt = path.extname(file.originalname);
  const fileName = `${folder}/${crypto.randomBytes(16).toString("hex")}${fileExt}`;

  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: fileName,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: 'public, max-age=31536000, immutable',
  };

  await s3.send(new PutObjectCommand(params));

  // Return public URL
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
};

/**
 * Delete a file from S3 by its full URL.
 * Silently ignores errors (best-effort cleanup).
 */
const deleteFromS3 = async (fileUrl) => {
  try {
    if (!fileUrl) return;
    const bucket = process.env.S3_BUCKET_NAME;

    // Handle BOTH URL shapes we generate:
    //   https://{bucket}.s3.{region}.amazonaws.com/{key}   (uploadToS3)
    //   https://{bucket}.s3.amazonaws.com/{key}             (uploadFileToS3, chat images)
    // Key = everything after the first ".amazonaws.com/".
    const marker = '.amazonaws.com/';
    const idx = fileUrl.indexOf(marker);
    if (idx === -1) return;
    const key = decodeURIComponent(fileUrl.slice(idx + marker.length));
    if (!key) return;

    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (_) { /* best-effort */ }
};

// Parse our own S3 URL → { bucket, key }. Returns null for non-matching hosts
// (external URLs) or anything we can't parse.
const parseOwnS3Url = (url) => {
  if (!url || typeof url !== 'string') return null;
  const marker = '.amazonaws.com/';
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const before = url.slice(0, idx);                 // https://<bucket>.s3 OR https://<bucket>.s3.<region>
  const m = before.match(/^https?:\/\/([^.]+)\.s3/i);
  if (!m) return null;
  const bucket = m[1];
  if (bucket !== process.env.S3_BUCKET_NAME) return null; // foreign URL
  const key = decodeURIComponent(url.slice(idx + marker.length));
  if (!key) return null;
  return { bucket, key };
};

// Copy an S3 object we own to a NEW key under the given folder and return the
// public URL of the copy. Used when a story / other user-owned media is shared
// to chat — the chat message gets its own object so it survives story expiry.
// Throws if the source isn't an object we own, so caller can fall back.
const copyS3Object = async (sourceUrl, destFolder = 'chat-shares') => {
  const src = parseOwnS3Url(sourceUrl);
  if (!src) throw new Error('Source URL is not an own-bucket object');

  const ext = path.extname(src.key) || '';
  const destKey = `${destFolder}/${crypto.randomBytes(16).toString('hex')}${ext}`;

  await s3.send(new CopyObjectCommand({
    Bucket: src.bucket,
    CopySource: `${src.bucket}/${encodeURIComponent(src.key).replace(/%2F/g, '/')}`,
    Key: destKey,
    MetadataDirective: 'COPY',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return `https://${src.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${destKey}`;
};

// "Share-to-chat" media materializer. Given a URL the FE wants to attach to a
// chat message, return the URL the message should actually persist:
//   • empty / non-string                  → null (no media)
//   • foreign URL (not our bucket)        → pass through (best-effort; we can't copy what we don't own)
//   • already chat-owned (chat-images/chat-shares/) → pass through
//   • otherwise (story / explore / etc.)  → copy to chat-shares/ and return new URL
// On copy failure, falls back to returning the original URL (logs the error) so
// the send NEVER blocks. The orphan-guard already keeps original alive, so this
// is defense in depth.
const materializeChatMedia = async (sourceUrl) => {
  if (!sourceUrl || typeof sourceUrl !== 'string') return null;
  const parsed = parseOwnS3Url(sourceUrl);
  if (!parsed) return sourceUrl; // foreign — leave as-is
  if (parsed.key.startsWith('chat-images/') || parsed.key.startsWith('chat-shares/')) {
    return sourceUrl;            // already message-owned
  }
  try {
    return await copyS3Object(sourceUrl, 'chat-shares');
  } catch (e) {
    console.error('materializeChatMedia: copy failed, falling back to source URL', e?.message);
    return sourceUrl;
  }
};

module.exports = uploadToS3;
module.exports.deleteFromS3 = deleteFromS3;
module.exports.copyS3Object = copyS3Object;
module.exports.materializeChatMedia = materializeChatMedia;
module.exports.parseOwnS3Url = parseOwnS3Url;
