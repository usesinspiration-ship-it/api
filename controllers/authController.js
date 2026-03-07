const bcrypt = require('bcrypt');
const {
  query,
  queryOne,
  transaction,
} = require('../config/database');
const {
  hashToken,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  createPasswordResetToken,
  accessTokenExpiresInSeconds,
  refreshTokenExpiresInSeconds,
} = require('../utils/tokenHelper');
const { isValidEmail, isStrongPassword, normalizeRole } = require('../utils/authValidation');
const { invalidateStatsCache } = require('../utils/statsHelper');

function createError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details) {
    err.details = details;
  }
  return err;
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
}

function getUserAgent(req) {
  return String(req.headers['user-agent'] || '').slice(0, 500);
}

function createMailTransport() {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (error) {
    // Optional unless SMTP sending is configured.
    return null;
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendResetEmail(email, rawToken) {
  const resetUrl = `${process.env.API_URL || 'http://localhost:3000'}/reset-password?token=${encodeURIComponent(rawToken)}`;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@cv-vault.local';

  const transporter = createMailTransport();

  if (!transporter) {
    // eslint-disable-next-line no-console
    console.info(`[auth] password reset link for ${email}: ${resetUrl}`);
    return;
  }

  await transporter.sendMail({
    from,
    to: email,
    subject: 'Password reset request',
    text: `Use this link to reset your password: ${resetUrl}`,
    html: `<p>Use this link to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
  });
}

async function createUserSession(user, req) {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  const refreshTokenHash = hashToken(refreshToken);

  const expiresAt = new Date(Date.now() + refreshTokenExpiresInSeconds() * 1000);

  await query(
    `
      INSERT INTO user_refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
      VALUES (?, ?, ?, ?, ?)
    `,
    [user.id, refreshTokenHash, expiresAt, getUserAgent(req), getClientIp(req)]
  );

  await query('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);

  return {
    accessToken,
    refreshToken,
    expiresIn: accessTokenExpiresInSeconds(),
  };
}

/**
 * POST /api/auth/register
 */
async function register(req, res, next) {
  try {
    const { email, password, name, role } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw createError(400, 'Bad Request', 'name is required');
    }

    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      throw createError(400, 'Bad Request', 'valid email is required');
    }

    if (!isStrongPassword(password)) {
      throw createError(400, 'Bad Request', 'password must be 8+ chars and include uppercase, lowercase, number, symbol');
    }

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedRole = normalizeRole(role);

    const existing = await queryOne('SELECT id FROM users WHERE email = ? LIMIT 1', [normalizedEmail]);
    if (existing) {
      throw createError(409, 'Bad Request', 'email is already registered');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [name.trim(), normalizedEmail, passwordHash, normalizedRole]
    );

    invalidateStatsCache();

    return res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: {
        id: result.insertId,
        name: name.trim(),
        email: normalizedEmail,
        role: normalizedRole,
      },
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/auth/login
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      throw createError(400, 'Bad Request', 'valid email is required');
    }

    if (!password || typeof password !== 'string') {
      throw createError(400, 'Bad Request', 'password is required');
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await queryOne(
      'SELECT id, name, email, role, password_hash, is_active FROM users WHERE email = ? LIMIT 1',
      [normalizedEmail]
    );

    if (!user) {
      throw createError(401, 'Unauthorized', 'invalid credentials');
    }

    if (Number(user.is_active) === 0) {
      throw createError(403, 'Forbidden', 'account is inactive');
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      throw createError(401, 'Unauthorized', 'invalid credentials');
    }

    const tokens = await createUserSession(user, req);

    return res.status(200).json({
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/auth/refresh
 */
async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== 'string') {
      throw createError(400, 'Bad Request', 'refreshToken is required');
    }

    const payload = verifyRefreshToken(refreshToken);
    const tokenHash = hashToken(refreshToken);

    const session = await queryOne(
      `
        SELECT id, user_id, expires_at, is_revoked
        FROM user_refresh_tokens
        WHERE token_hash = ?
        LIMIT 1
      `,
      [tokenHash]
    );

    if (!session || Number(session.user_id) !== Number(payload.userId)) {
      throw createError(401, 'Unauthorized', 'invalid refresh token');
    }

    if (Number(session.is_revoked) === 1) {
      throw createError(401, 'Unauthorized', 'refresh token revoked');
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw createError(401, 'Unauthorized', 'refresh token expired');
    }

    const user = await queryOne('SELECT id, email, role, is_active FROM users WHERE id = ? LIMIT 1', [session.user_id]);
    if (!user || Number(user.is_active) === 0) {
      throw createError(401, 'Unauthorized', 'user unavailable');
    }

    const accessToken = generateAccessToken(user);

    await query('UPDATE user_refresh_tokens SET last_used_at = UTC_TIMESTAMP() WHERE id = ?', [session.id]);

    return res.status(200).json({
      accessToken,
      expiresIn: accessTokenExpiresInSeconds(),
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/auth/logout
 */
async function logout(req, res, next) {
  try {
    const refreshToken = req.body?.refreshToken;

    if (refreshToken && typeof refreshToken === 'string') {
      const tokenHash = hashToken(refreshToken);
      await query(
        'UPDATE user_refresh_tokens SET is_revoked = 1, revoked_at = UTC_TIMESTAMP() WHERE token_hash = ? AND is_revoked = 0',
        [tokenHash]
      );
    }

    if (req.user?.tokenJti) {
      const ttlSeconds = accessTokenExpiresInSeconds();
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

      await query('INSERT INTO auth_token_blacklist (token_hash, expires_at) VALUES (?, ?)', [
        req.user.tokenJti,
        expiresAt,
      ]).catch(() => {
        // Ignore duplicate blacklist entries.
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/auth/me
 */
async function getMe(req, res, next) {
  try {
    const user = await queryOne(
      'SELECT id, name, email, role, DATE(created_at) AS createdAt FROM users WHERE id = ? LIMIT 1',
      [req.user.id]
    );

    if (!user) {
      throw createError(404, 'Not Found', 'user not found');
    }

    return res.status(200).json({ user });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/auth/password-reset
 */
async function passwordReset(req, res, next) {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();

    if (!email || !isValidEmail(email)) {
      throw createError(400, 'Bad Request', 'valid email is required');
    }

    const user = await queryOne('SELECT id, email FROM users WHERE email = ? LIMIT 1', [email]);

    if (user) {
      const reset = createPasswordResetToken();

      await transaction(async (tx) => {
        await tx.query('UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL', [
          user.id,
        ]);

        await tx.query(
          `
          INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
          VALUES (?, ?, ?, ?)
          `,
          [user.id, reset.hashedToken, reset.expiresAt, getClientIp(req)]
        );
      });

      await sendResetEmail(user.email, reset.rawToken);
    }

    return res.status(200).json({
      success: true,
      message: 'Reset link sent to email',
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/auth/verify-reset-token
 */
async function verifyResetToken(req, res, next) {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      throw createError(400, 'Bad Request', 'token is required');
    }

    const hashedToken = hashToken(token);

    const row = await queryOne(
      `
        SELECT id
        FROM password_reset_tokens
        WHERE token_hash = ?
          AND used_at IS NULL
          AND expires_at > UTC_TIMESTAMP()
        LIMIT 1
      `,
      [hashedToken]
    );

    return res.status(200).json({
      valid: Boolean(row),
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/auth/new-password
 */
async function setNewPassword(req, res, next) {
  try {
    const token = String(req.body?.token || '').trim();
    const newPassword = req.body?.newPassword;

    if (!token) {
      throw createError(400, 'Bad Request', 'token is required');
    }

    if (!isStrongPassword(newPassword)) {
      throw createError(400, 'Bad Request', 'newPassword must be 8+ chars and include uppercase, lowercase, number, symbol');
    }

    const hashedToken = hashToken(token);

    const resetRow = await queryOne(
      `
        SELECT id, user_id
        FROM password_reset_tokens
        WHERE token_hash = ?
          AND used_at IS NULL
          AND expires_at > UTC_TIMESTAMP()
        LIMIT 1
      `,
      [hashedToken]
    );

    if (!resetRow) {
      throw createError(400, 'Bad Request', 'invalid or expired reset token');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await transaction(async (tx) => {
      await tx.query('UPDATE users SET password_hash = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [
        passwordHash,
        resetRow.user_id,
      ]);

      await tx.query('UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?', [resetRow.id]);

      await tx.query(
        'UPDATE user_refresh_tokens SET is_revoked = 1, revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND is_revoked = 0',
        [resetRow.user_id]
      );
    });

    return res.status(200).json({
      success: true,
      message: 'Password updated successfully',
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  getMe,
  passwordReset,
  verifyResetToken,
  setNewPassword,
  __private: {
    isStrongPassword,
    normalizeRole,
    isValidEmail,
  },
};
