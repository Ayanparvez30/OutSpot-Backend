// Safe orphan-only S3 cleanup.
//
// Rule: an S3 object may be deleted ONLY when zero rows across ANY table
// still reference its URL. Any miss here = a live row pointing at a dead
// S3 object = broken image in the app. So we check every URL column that
// holds a user-uploaded asset, plus admin-managed tables, to be safe.
//
// Add a new check here whenever a new model gets a URL column.

const { PrismaClient } = require('@prisma/client');
const { deleteFromS3 } = require('./s3Upload');

const prisma = new PrismaClient();

// Count references across every model that stores a public URL we own.
// Skipping the row that triggered the deletion is the caller's job — they
// delete the DB row FIRST, then call us; with the row gone, count returns 0
// only when no other reference remains.
async function countReferences(url) {
  if (!url || typeof url !== 'string') return Infinity;            // unknown → treat as referenced (do not delete)
  if (!/^https?:\/\//i.test(url)) return Infinity;                  // local/invalid URL → never delete (also not in S3)

  const checks = await Promise.all([
    prisma.story.count({       where: { mediaUrl: url } }),
    prisma.locationPoint.count({ where: { mediaUrl: url } }),
    prisma.submission.count({  where: { mediaUrl: url } }),
    prisma.message.count({     where: { imageUrl: url } }),
    prisma.chat.count({        where: { imageUrl: url } }),
    prisma.chatImage.count({   where: { fileUrl: url } }),
    prisma.media.count({       where: { fileUrl: url } }),
    prisma.minime.count({      where: { OR: [{ avatarUrl: url }, { selfieUrl: url }] } }),
    prisma.user.count({        where: { OR: [{ bodyShapeUrl: url }, { selfieUrl: url }] } }),
    prisma.community.count({   where: { imageUrl: url } }),
    // Admin-managed assets — defensive, in case a user-uploaded URL ever overlaps.
    prisma.bodyShape.count({   where: { imageUrl: url } }),
    prisma.shopItem.count({    where: { imageUrl: url } }),
    prisma.premadeAvatar.count({ where: { imageUrl: url } }),
  ]);
  return checks.reduce((a, b) => a + b, 0);
}

// Delete an S3 object ONLY if no DB row anywhere still references its URL.
// Caller must already have removed any row that pointed at this URL.
// Returns { ok, deleted?, reason?, error? }.
async function deleteS3IfOrphan(url) {
  if (!url) return { ok: false, reason: 'no-url' };
  let refs;
  try {
    refs = await countReferences(url);
  } catch (e) {
    return { ok: false, reason: 'count-failed', error: e.message };
  }
  if (refs > 0) return { ok: false, reason: 'still-referenced', count: refs };
  try {
    await deleteFromS3(url);
    return { ok: true, deleted: url };
  } catch (e) {
    return { ok: false, reason: 'delete-failed', error: e.message };
  }
}

// Bulk variant — used by the story expiry cron. Fires checks in parallel
// but caps concurrency to keep prisma + S3 happy under load.
async function deleteS3IfOrphanBulk(urls, concurrency = 10) {
  const out = { deleted: 0, kept: 0, failed: 0 };
  const queue = [...urls];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      const r = await deleteS3IfOrphan(url);
      if (r.ok) out.deleted++;
      else if (r.reason === 'still-referenced') out.kept++;
      else out.failed++;
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { countReferences, deleteS3IfOrphan, deleteS3IfOrphanBulk };
