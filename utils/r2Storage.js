const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const accountId = (process.env.R2_ACCOUNT_ID || '').trim();
const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const bucketName = (process.env.R2_BUCKET_NAME || '').trim();

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

async function uploadToR2(fileBuffer, originalName, mimeType) {
  if (!fileBuffer) return null;
  
  const ext = originalName.includes('.') ? `.${originalName.split('.').pop()}` : '';
  const uniqueId = crypto.randomBytes(16).toString('hex');
  const objectKey = `cvs/${Date.now()}-${uniqueId}${ext}`;

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
    Body: fileBuffer,
    ContentType: mimeType || 'application/octet-stream',
  });

  await s3Client.send(command);
  return objectKey;
}

async function deleteFromR2(objectKey) {
  if (!objectKey) return;
  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
  });
  try {
    await s3Client.send(command);
  } catch (error) {
    console.error(`[r2] error deleting object ${objectKey}`, error);
  }
}

async function getR2SignedUrl(objectKey) {
  if (!objectKey) return null;
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
  });
  // URL expires in 1 hour
  return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

module.exports = {
  uploadToR2,
  deleteFromR2,
  getR2SignedUrl
};
