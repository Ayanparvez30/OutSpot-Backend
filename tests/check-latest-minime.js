const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
require('dotenv').config();

const s3 = new S3Client({ region: process.env.AWS_REGION });

async function main() {
  const list = await s3.send(new ListObjectsV2Command({
    Bucket: process.env.S3_BUCKET_NAME,
    Prefix: 'minimes/',
  }));

  if (!list.Contents || list.Contents.length === 0) {
    console.log('No minime images found');
    return;
  }

  // Sort by last modified (newest first)
  const sorted = list.Contents.sort((a, b) => b.LastModified - a.LastModified);

  console.log('Latest 5 MiniMe images:\n');
  for (const obj of sorted.slice(0, 5)) {
    const sizeKB = (obj.Size / 1024).toFixed(0);
    const url = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${obj.Key}`;
    console.log(`  ${sizeKB} KB  ${obj.LastModified.toISOString()}`);
    console.log(`  ${url}\n`);
  }
}

main().catch(console.error);
