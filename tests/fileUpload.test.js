const assert = require('node:assert/strict');
const { __private, formatFileSize } = require('../utils/fileUpload');

function makeFile(overrides = {}) {
  return {
    originalname: 'resume.txt',
    mimetype: 'text/plain',
    size: 2048,
    buffer: Buffer.from('John Doe\nExperience\nSkills\nEducation\nemail@example.com\n+1 555 123 4567\n'),
    ...overrides,
  };
}

async function run() {
  assert.equal(__private.extensionOf('resume.PDF'), '.pdf');
  assert.equal(__private.isHiddenFile('.secret.pdf'), true);
  assert.equal(__private.sanitizeFilename('../unsafe/../resume?.pdf'), 'resume_.pdf');
  assert.equal(__private.detectTextEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), 'utf8-bom');
  assert.equal(formatFileSize(46284), '45.2 KB');

  const cleaned = __private.cleanExtractedText('  Hello\t\tWorld\n\n\nTest  ');
  assert.equal(cleaned, 'Hello World\n\nTest');

  assert.equal(
    __private.isProbablyCVContent(
      'Resume summary: Experience in software engineering. Skills include React and Node.js. Education at University. Projects, certifications, and employment history. Contact: john@example.com +1 555 123 4567'
    ),
    true
  );

  await assert.rejects(() => __private.validateUploadMeta(makeFile({ originalname: '.hidden.txt' })));
  await assert.rejects(() => __private.validateUploadMeta(makeFile({ originalname: 'malware.exe' })));
  await assert.rejects(() => __private.validateUploadMeta(makeFile({ size: 0, buffer: Buffer.alloc(0) })));

  const ok = await __private.validateUploadMeta(makeFile());
  assert.equal(ok.extension, '.txt');

  console.log('All fileUpload tests passed.');
}

run().catch((error) => {
  console.error('fileUpload tests failed:', error);
  process.exit(1);
});
