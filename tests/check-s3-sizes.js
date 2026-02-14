const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
require('dotenv').config();

const s3 = new S3Client({ region: process.env.AWS_REGION });

async function main() {
  const list = await s3.send(new ListObjectsV2Command({
    Bucket: process.env.S3_BUCKET_NAME,
    Prefix: 'minimes/',
    MaxKeys: 10
  }));

  if (!list.Contents || list.Contents.length === 0) {
    console.log('No minime images found in S3');
    return;
  }

  console.log('MiniMe images on S3:');
  for (const obj of list.Contents) {
    const sizeKB = (obj.Size / 1024).toFixed(0);
    const sizeMB = (obj.Size / (1024 * 1024)).toFixed(2);
    console.log(`  ${obj.Key} -> ${sizeKB} KB (${sizeMB} MB)`);
  }

  // Also check body-shapes and avatars
  for (const prefix of ['body-shapes/', 'avatars/']) {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: prefix,
      MaxKeys: 5
    }));
    if (res.Contents && res.Contents.length > 0) {
      console.log(`\n${prefix} images:`);
      for (const obj of res.Contents) {
        const sizeKB = (obj.Size / 1024).toFixed(0);
        console.log(`  ${obj.Key} -> ${sizeKB} KB`);
      }
    }
  }
}

main().catch(console.error);
