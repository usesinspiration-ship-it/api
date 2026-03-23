require('dotenv').config();
const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');

const accountId = (process.env.R2_ACCOUNT_ID || '').trim();
const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
const secretAccessKey = 'fail' + (process.env.R2_SECRET_ACCESS_KEY || '').trim();

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

async function list() {
  try {
    const data = await s3Client.send(new ListBucketsCommand({}));
    console.log('Buckets:', data.Buckets.map(b => b.Name));
  } catch (err) {
    console.error('ListBuckets error:', err);
  }
}
list();
