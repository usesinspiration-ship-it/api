const morgan = require('morgan');
const { http, warn, generateRequestId, sanitizeData } = require('../utils/logger');

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function sanitizeQuery(query) {
  const entries = Object.entries(query || {});
  if (entries.length === 0) return '';

  const safe = sanitizeData(Object.fromEntries(entries));
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(safe)) {
    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, String(item)));
    } else if (value !== undefined && value !== null) {
      params.append(key, String(value));
    }
  }

  const str = params.toString();
  return str ? `?${str}` : '';
}

morgan.token('requestId', (req) => req.requestId || '-');
morgan.token('userId', (req) => req.user?.id || 'anonymous');
morgan.token('queryPart', (req) => sanitizeQuery(req.query));

const morganMiddleware = morgan((tokens, req, res) => {
  const method = tokens.method(req, res);
  const rawUrl = tokens.url(req, res) || req.path || '';
  const url = String(rawUrl).split('?')[0];
  const status = tokens.status(req, res);
  const responseTime = tokens['response-time'](req, res);
  const userId = tokens.userId(req, res);
  const requestId = tokens.requestId(req, res);

  return `[${formatTimestamp()}] ${method} ${url}${tokens.queryPart(req, res)} - ${status} - ${responseTime}ms - user:${userId} - req:${requestId}`;
}, {
  stream: {
    write: (line) => {
      http(line.trim());
    },
  },
});

function requestLogger(req, res, next) {
  req.requestId = req.headers['x-request-id'] || generateRequestId();
  req.requestStartTime = Date.now();

  res.setHeader('x-request-id', req.requestId);

  res.on('finish', () => {
    if (res.statusCode >= 400) {
      warn('Request completed with error status', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        userId: req.user?.id,
        error: res.locals.errorContext,
      });
    }
  });

  return morganMiddleware(req, res, next);
}

module.exports = requestLogger;
