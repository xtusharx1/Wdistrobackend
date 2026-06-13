require('dotenv').config();
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? 'LOADED' : 'NOT LOADED');
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'LOADED' : 'NOT LOADED');
console.log('AWS_REGION:', process.env.AWS_REGION);
console.log('AWS_S3_BUCKET:', process.env.AWS_S3_BUCKET);

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-west-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  }
});

s3.send(new ListObjectsV2Command({ Bucket: process.env.AWS_S3_BUCKET || 'wdistro', MaxKeys: 1 }))
  .then(data => {
    console.log('SUCCESS: S3 connection works!', data.$metadata);
  })
  .catch(err => {
    console.error('ERROR connecting to S3:', err.message);
  });
