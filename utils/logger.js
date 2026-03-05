const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const winston = require('winston');
const { createStream } = require('rotating-file-stream');

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_DIR = path.resolve(process.cwd(), process.env.LOG_DIR || './logs');
const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE || '10M';
const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES || 30);
const DEBUG_MODE = String(process.env.DEBUG || process.env.NODE_ENV === 'development').toLowerCase() === 'true';
const LOG_EXTERNAL_WEBHOOK = process.env.LOG_EXTERNAL_WEBHOOK || '';

const errorMetrics = {
  total: 0,
  byCode: new Map(),
  byType: new Map(),
  recent: [],
};

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function maskEmail(value) {
  return String(value).replace(/\b([a-zA-Z0-9._%+-]{1,2})[a-zA-Z0-9._%+-]*(@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g, '$1***$2');
}

function maskCardLike(value) {
  return String(value).replace(/\b(?:\d[ -]*?){13,19}\b/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) {
      return match;
    }
    const suffix = digits.slice(-4);
    return `**** **** **** ${suffix}`;
  });
}

function maskSecrets(value) {
  return String(value)
    .replace(/(password\s*[:=]\s*)([^\s,;]+)/gi, '$1******')
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s,;]+)/gi, '$1******')
    .replace(/(authorization\s*[:=]\s*bearer\s+)([^\s,;]+)/gi, '$1******')
    .replace(/(token\s*[:=]\s*)([^\s,;]+)/gi, '$1******');
}

function sanitizeString(value) {
  return maskCardLike(maskEmail(maskSecrets(value)));
}

function sanitizeData(data, depth = 0, seen = new WeakSet()) {
  if (data === null || data === undefined) {
    return data;
  }

  if (depth > 5) {
    return '[truncated]';
  }

  if (typeof data === 'string') {
    return sanitizeString(data);
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return data;
  }

  if (data instanceof Date) {
    return data.toISOString();
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeData(item, depth + 1, seen));
  }

  if (typeof data === 'object') {
    if (seen.has(data)) {
      return '[circular]';
    }
    seen.add(data);

    const out = {};
    for (const [key, value] of Object.entries(data)) {
      const lowered = key.toLowerCase();
      if (['password', 'pass', 'secret', 'token', 'authorization', 'api_key', 'apikey'].includes(lowered)) {
        out[key] = '******';
        continue;
      }

      if (lowered === 'email' && typeof value === 'string') {
        out[key] = maskEmail(value);
        continue;
      }

      out[key] = sanitizeData(value, depth + 1, seen);
    }

    return out;
  }

  return String(data);
}

function getCurrentDate() {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentLogFilePath() {
  return path.join(LOG_DIR, `${getCurrentDate()}.log`);
}

function formatLine({ timestamp, level, message, ...meta }) {
  const payload = sanitizeData(meta);
  const extras = Object.keys(payload || {}).length > 0 ? ` ${JSON.stringify(payload)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${sanitizeString(String(message))}${extras}`;
}

ensureLogDir();

const rotatingStream = createStream((time) => {
  if (!time) return `${getCurrentDate()}.log`;
  return `${time.toISOString().slice(0, 10)}.log`;
}, {
  interval: '1d',
  path: LOG_DIR,
  size: LOG_MAX_SIZE,
  maxFiles: `${LOG_MAX_FILES}d`,
  compress: 'gzip',
});

const logger = winston.createLogger({
  level: LOG_LEVEL,
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
  },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true })
  ),
  transports: [
    new winston.transports.Stream({
      stream: rotatingStream,
      level: LOG_LEVEL,
      format: winston.format.printf((info) => formatLine(info)),
    }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      level: DEBUG_MODE ? 'debug' : LOG_LEVEL,
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf((info) => formatLine(info))
      ),
    })
  );
}

async function pushExternalLog(level, message, meta) {
  if (!LOG_EXTERNAL_WEBHOOK || typeof fetch !== 'function') return;

  if (!['error', 'warn'].includes(level)) return;

  const payload = sanitizeData({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  });

  fetch(LOG_EXTERNAL_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Best-effort; avoid breaking app flow due to telemetry failure.
  });
}

function addErrorMetric(entry) {
  errorMetrics.total += 1;

  const code = entry.code || 'UNKNOWN_ERROR';
  const type = entry.type || 'UnknownError';

  errorMetrics.byCode.set(code, (errorMetrics.byCode.get(code) || 0) + 1);
  errorMetrics.byType.set(type, (errorMetrics.byType.get(type) || 0) + 1);

  errorMetrics.recent.unshift(entry);
  if (errorMetrics.recent.length > 200) {
    errorMetrics.recent.pop();
  }
}

function log(level, message, meta = {}) {
  const payload = sanitizeData(meta);
  logger.log(level, message, payload);
  pushExternalLog(level, message, payload);
}

function error(message, err = {}, meta = {}) {
  const payload = {
    ...meta,
    errorName: err.name,
    code: err.code,
    status: err.status,
    details: err.details,
    stack: DEBUG_MODE ? err.stack : undefined,
  };

  addErrorMetric({
    timestamp: new Date().toISOString(),
    message,
    type: err.name,
    code: err.code,
    status: err.status,
    requestId: meta.requestId,
    path: meta.path,
    method: meta.method,
    userId: meta.userId,
  });

  log('error', message, payload);
}

function warn(message, meta = {}) {
  log('warn', message, meta);
}

function info(message, meta = {}) {
  log('info', message, meta);
}

function http(message, meta = {}) {
  log('http', message, meta);
}

function debug(message, meta = {}) {
  if (!DEBUG_MODE) return;
  log('debug', message, meta);
}

function child(baseMeta = {}) {
  return {
    error: (message, err, meta) => error(message, err, { ...baseMeta, ...(meta || {}) }),
    warn: (message, meta) => warn(message, { ...baseMeta, ...(meta || {}) }),
    info: (message, meta) => info(message, { ...baseMeta, ...(meta || {}) }),
    http: (message, meta) => http(message, { ...baseMeta, ...(meta || {}) }),
    debug: (message, meta) => debug(message, { ...baseMeta, ...(meta || {}) }),
  };
}

function generateRequestId() {
  return randomUUID();
}

function getErrorMetrics() {
  return {
    total: errorMetrics.total,
    byCode: Object.fromEntries(errorMetrics.byCode.entries()),
    byType: Object.fromEntries(errorMetrics.byType.entries()),
    recent: [...errorMetrics.recent],
  };
}

function readLogFile(date = getCurrentDate()) {
  const filePath = path.join(LOG_DIR, `${date}.log`);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function readLogTail(lines = 100, date = getCurrentDate()) {
  const content = readLogFile(date);
  if (!content) return '';
  return content.split('\n').slice(-Math.max(1, lines)).join('\n');
}

module.exports = {
  logger,
  error,
  warn,
  info,
  http,
  debug,
  child,
  sanitizeData,
  getErrorMetrics,
  generateRequestId,
  readLogFile,
  readLogTail,
};
