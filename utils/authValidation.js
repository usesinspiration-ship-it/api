const ALLOWED_ROLES = new Set(['admin', 'hr', 'recruiter', 'viewer']);

function createError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details) err.details = details;
  return err;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongPassword(password) {
  if (typeof password !== 'string') return false;
  if (password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[^A-Za-z0-9]/.test(password)) return false;
  return true;
}

function normalizeRole(role) {
  const normalized = String(role || 'viewer').toLowerCase().trim();
  if (!ALLOWED_ROLES.has(normalized)) {
    throw createError(400, 'Bad Request', 'role must be one of: admin, hr, recruiter, viewer');
  }
  return normalized;
}

module.exports = {
  isValidEmail,
  isStrongPassword,
  normalizeRole,
  ALLOWED_ROLES,
};
