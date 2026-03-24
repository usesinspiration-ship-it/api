const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '1h';
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
const RESET_TOKEN_EXPIRES_MINUTES = Number(process.env.RESET_TOKEN_EXPIRES_MINUTES || 60);

function createAuthError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details) err.details = details;
  return err;
}

function parseExpiresToSeconds(value) {
  if (typeof value === 'number') return value;
  const str = String(value).trim().toLowerCase();

  const direct = Number(str);
  if (Number.isFinite(direct)) return direct;

  const match = str.match(/^(\d+)\s*([smhd])$/);
  if (!match) return 3600;

  const amount = Number(match[1]);
  const unit = match[2];

  if (unit === 's') return amount;
  if (unit === 'm') return amount * 60;
  if (unit === 'h') return amount * 60 * 60;
  if (unit === 'd') return amount * 24 * 60 * 60;
  return 3600;
}

function ensureSecrets() {
  if (!process.env.JWT_SECRET) {
    throw createAuthError(500, 'Server Error', 'JWT_SECRET is not configured');
  }

  if (!process.env.JWT_REFRESH_SECRET) {
    process.env.JWT_REFRESH_SECRET = process.env.JWT_SECRET;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function generateRandomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function buildAccessPayload(user) {
  return {
    sub: user.id,
    userId: user.id,
    email: user.email,
    role: user.role,
    type: 'access',
    jti: generateRandomToken(12),
  };
}

function buildRefreshPayload(user) {
  return {
    sub: user.id,
    userId: user.id,
    type: 'refresh',
    jti: generateRandomToken(12),
  };
}

function generateAccessToken(user) {
  ensureSecrets();
  return jwt.sign(buildAccessPayload(user), process.env.JWT_SECRET, {
    expiresIn: ACCESS_EXPIRES_IN,
  });
}

function generateRefreshToken(user) {
  ensureSecrets();
  return jwt.sign(buildRefreshPayload(user), process.env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_EXPIRES_IN,
  });
}

function verifyAccessToken(token) {
  ensureSecrets();
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (!payload || payload.type !== 'access') {
    throw createAuthError(401, 'Unauthorized', 'Invalid access token');
  }
  return payload;
}

function verifyRefreshToken(token) {
  ensureSecrets();
  const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  if (!payload || payload.type !== 'refresh') {
    throw createAuthError(401, 'Unauthorized', 'Invalid refresh token');
  }
  return payload;
}

function createPasswordResetToken() {
  const rawToken = generateRandomToken(24);
  const hashedToken = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRES_MINUTES * 60 * 1000);

  return {
    rawToken,
    hashedToken,
    expiresAt,
  };
}

function accessTokenExpiresInSeconds() {
  return parseExpiresToSeconds(ACCESS_EXPIRES_IN);
}

function refreshTokenExpiresInSeconds() {
  return parseExpiresToSeconds(REFRESH_EXPIRES_IN);
}

module.exports = {
  hashToken,
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  createPasswordResetToken,
  accessTokenExpiresInSeconds,
  refreshTokenExpiresInSeconds,
  __private: {
    parseExpiresToSeconds,
    createAuthError,
  },
};
