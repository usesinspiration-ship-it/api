const assert = require('node:assert/strict');
const { isValidEmail, isStrongPassword, normalizeRole } = require('../utils/authValidation');

function run() {
  assert.equal(isValidEmail('john@example.com'), true);
  assert.equal(isValidEmail('bad-email'), false);

  assert.equal(isStrongPassword('SecurePassword123!'), true);
  assert.equal(isStrongPassword('weakpass'), false);

  assert.equal(normalizeRole('HR'), 'hr');
  assert.equal(normalizeRole('viewer'), 'viewer');

  assert.throws(() => {
    normalizeRole('owner');
  });

  console.log('All auth validation tests passed.');
}

try {
  run();
} catch (error) {
  console.error('auth validation tests failed:', error);
  process.exit(1);
}
