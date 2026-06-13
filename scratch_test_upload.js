require('dotenv').config();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

const bucket = process.env.AWS_S3_BUCKET;
const key = `test-${Date.now()}.txt`;
const body = 'Hello World';

console.log('Testing upload WITH ACL: public-read...');
s3.send(new PutObjectCommand({
  Bucket: bucket,
  Key: key,
  Body: body,
  ContentType: 'text/plain',
  ACL: 'public-read'
}))
.then(res => {
  console.log('SUCCESS with ACL: public-read! URL:', `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`);
})
.catch(err => {
  console.warn('FAILED with ACL: public-read. Error:', err.message);
  console.log('Testing upload WITHOUT ACL...');
  s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'text/plain'
  }))
  .then(res2 => {
    console.log('SUCCESS without ACL! URL:', `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`);
  })
  .catch(err2 => {
    console.error('FAILED without ACL too. Error:', err2.message);
  });
});
