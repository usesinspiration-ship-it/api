require('dotenv').config();
const { uploadToR2 } = require('./utils/r2Storage');

async function test() {
  try {
    console.log('Account ID:', process.env.R2_ACCOUNT_ID);
    console.log('Access Key:', process.env.R2_ACCESS_KEY_ID);
    console.log('Secret Key:', process.env.R2_SECRET_ACCESS_KEY);
    
    const buffer = Buffer.from('hello world from test');
    const result = await uploadToR2(buffer, 'test.txt', 'text/plain');
    console.log('Success!', result);
  } catch (err) {
    console.error('Failed!', err);
  }
}
test();
