require('dotenv').config();
const AWS = require('aws-sdk');

const accountId = (process.env.R2_ACCOUNT_ID || '').trim();
const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
const bucketName = (process.env.R2_BUCKET_NAME || '').trim();

const endpoint = new AWS.Endpoint(`https://${accountId}.r2.cloudflarestorage.com`);

const s3 = new AWS.S3({
    endpoint: endpoint,
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
    region: "auto",
    signatureVersion: "v4",
    s3ForcePathStyle: true,
});

async function testV2() {
    try {
        await s3.putObject({
            Bucket: bucketName,
            Key: 'test-v2.txt',
            Body: Buffer.from('Testing v2 upload'),
            ContentType: 'text/plain'
        }).promise();
        console.log("Success!")
    } catch (err) {
        console.error("V2 Error:", err);
    }
}
testV2();
