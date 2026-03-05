const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_access_secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_secret';
process.env.JWT_ACCESS_EXPIRES_IN = '1h';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';

const {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  createPasswordResetToken,
  accessTokenExpiresInSeconds,
  refreshTokenExpiresInSeconds,
  __private,
} = require('../utils/tokenHelper');

function run() {
  const user = { id: 1, email: 'user@example.com', role: 'hr' };

  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  const accessPayload = verifyAccessToken(accessToken);
  const refreshPayload = verifyRefreshToken(refreshToken);

  assert.equal(accessPayload.userId, 1);
  assert.equal(accessPayload.email, 'user@example.com');
  assert.equal(accessPayload.role, 'hr');
  assert.equal(accessPayload.type, 'access');

  assert.equal(refreshPayload.userId, 1);
  assert.equal(refreshPayload.type, 'refresh');

  assert.equal(typeof hashToken('abc123'), 'string');
  assert.equal(hashToken('abc123').length, 64);

  const reset = createPasswordResetToken();
  assert.equal(typeof reset.rawToken, 'string');
  assert.equal(typeof reset.hashedToken, 'string');
  assert.ok(reset.expiresAt instanceof Date);

  assert.equal(accessTokenExpiresInSeconds(), 3600);
  assert.equal(refreshTokenExpiresInSeconds(), 604800);
  assert.equal(__private.parseExpiresToSeconds('30m'), 1800);
  assert.equal(__private.parseExpiresToSeconds('2d'), 172800);

  console.log('All tokenHelper tests passed.');
}

try {
  run();
} catch (error) {
  console.error('tokenHelper tests failed:', error);
  process.exit(1);
}
