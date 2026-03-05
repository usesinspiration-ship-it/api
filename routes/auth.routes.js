const express = require('express');
const {
  register,
  login,
  refresh,
  logout,
  getMe,
  passwordReset,
  verifyResetToken,
  setNewPassword,
} = require('../controllers/authController');
const { verifyToken, optionalVerifyToken } = require('../middleware/auth');

const router = express.Router();

function createRateLimiter({ windowMs, max }) {
  const store = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown').toString().split(',')[0].trim();
    const key = `${req.path}:${ip}`;

    const item = store.get(key);

    if (!item || item.expiresAt <= now) {
      store.set(key, { count: 1, expiresAt: now + windowMs });
      next();
      return;
    }

    item.count += 1;
    if (item.count > max) {
      res.status(429).json({
        error: 'Too Many Requests',
        details: `Rate limit exceeded. Try again in ${Math.ceil((item.expiresAt - now) / 1000)}s`,
      });
      return;
    }

    next();
  };
}

const authLimiter = createRateLimiter({
  windowMs: Number(process.env.AUTH_RATE_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.AUTH_RATE_MAX || 100),
});

const sensitiveLimiter = createRateLimiter({
  windowMs: Number(process.env.AUTH_SENSITIVE_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.AUTH_SENSITIVE_MAX || 15),
});

router.post('/register', sensitiveLimiter, register);
router.post('/login', sensitiveLimiter, login);
router.post('/refresh', sensitiveLimiter, refresh);
router.post('/logout', authLimiter, optionalVerifyToken, logout);
router.get('/me', authLimiter, verifyToken, getMe);
router.post('/password-reset', sensitiveLimiter, passwordReset);
router.post('/verify-reset-token', sensitiveLimiter, verifyResetToken);
router.post('/new-password', sensitiveLimiter, setNewPassword);

module.exports = router;
