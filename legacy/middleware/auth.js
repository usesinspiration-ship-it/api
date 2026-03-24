const { queryOne } = require('../config/database');
const { verifyAccessToken } = require('../utils/tokenHelper');

function createError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details) err.details = details;
  return err;
}

/**
 * JWT auth middleware.
 * Requires Authorization header: Bearer <access_token>
 */
async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      throw createError(401, 'Unauthorized', 'Missing or invalid Authorization header');
    }

    const payload = verifyAccessToken(token);

    const user = await queryOne(
      'SELECT id, name, email, role, created_at, updated_at FROM users WHERE id = ? LIMIT 1',
      [payload.userId]
    );

    if (!user) {
      throw createError(401, 'Unauthorized', 'User no longer exists');
    }

    const blacklisted = await queryOne(
      'SELECT id FROM auth_token_blacklist WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1',
      [payload.jti]
    );

    if (blacklisted) {
      throw createError(401, 'Unauthorized', 'Token has been revoked');
    }

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      tokenJti: payload.jti,
    };

    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return next(createError(401, 'Unauthorized', error.message));
    }

    return next(error);
  }
}

async function optionalVerifyToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader) {
    return next();
  }

  return verifyToken(req, res, (error) => {
    if (error) {
      // Ignore auth parsing errors for optional mode.
      req.user = undefined;
    }
    next();
  });
}

function requireRole(...allowedRoles) {
  const normalized = allowedRoles.map((role) => String(role || '').toLowerCase());

  return (req, res, next) => {
    if (!req.user) {
      return next(createError(401, 'Unauthorized', 'Authentication required'));
    }

    if (normalized.length === 0 || normalized.includes(String(req.user.role || '').toLowerCase())) {
      return next();
    }

    return next(createError(403, 'Forbidden', 'Insufficient role permissions'));
  };
}

module.exports = {
  verifyToken,
  optionalVerifyToken,
  requireRole,
};
