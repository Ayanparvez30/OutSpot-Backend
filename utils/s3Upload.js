const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
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

module.exports = uploadToS3;
module.exports.deleteFromS3 = deleteFromS3;
