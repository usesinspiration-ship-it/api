const { error: logError } = require('../utils/logger');

class AppError extends Error {
  constructor(message, { status = 500, code = 'SERVER_ERROR', details, expose = false } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Invalid input', details) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details, expose: true });
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details) {
    super(message, { status: 404, code: 'NOT_FOUND_ERROR', details, expose: true });
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Not authenticated', details) {
    super(message, { status: 401, code: 'UNAUTHORIZED_ERROR', details, expose: true });
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'No permission', details) {
    super(message, { status: 403, code: 'FORBIDDEN_ERROR', details, expose: true });
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource conflict', details) {
    super(message, { status: 409, code: 'CONFLICT_ERROR', details, expose: true });
  }
}

class DatabaseError extends AppError {
  constructor(message = 'Database operation failed', details) {
    super(message, { status: 500, code: 'DATABASE_ERROR', details, expose: false });
  }
}

class FileUploadError extends AppError {
  constructor(message = 'File upload failed', details, status = 400) {
    super(message, { status, code: 'FILE_UPLOAD_ERROR', details, expose: true });
  }
}

class TimeoutError extends AppError {
  constructor(message = 'Request timed out', details) {
    super(message, { status: 504, code: 'TIMEOUT_ERROR', details, expose: true });
  }
}

class ServerError extends AppError {
  constructor(message = 'Internal server error', details) {
    super(message, { status: 500, code: 'SERVER_ERROR', details, expose: false });
  }
}

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function normalizeError(err) {
  if (err instanceof AppError) {
    return err;
  }

  const status = Number(err?.status || err?.statusCode || 500);

  if (err?.name === 'ValidationError' || status === 400) {
    return new ValidationError(err.message || 'Invalid input', err.details);
  }

  if (status === 404 || err?.name === 'NotFoundError') {
    return new NotFoundError(err.message || 'Resource not found', err.details);
  }

  if (status === 401 || err?.name === 'UnauthorizedError' || err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
    return new UnauthorizedError(err.message || 'Not authenticated', err.details);
  }

  if (status === 403 || err?.name === 'ForbiddenError') {
    return new ForbiddenError(err.message || 'No permission', err.details);
  }

  if (status === 409 || err?.name === 'ConflictError' || err?.code === 'ER_DUP_ENTRY') {
    return new ConflictError(err.message || 'Resource conflict', err.details);
  }

  if (
    err?.isUploadError ||
    err?.name === 'MulterError' ||
    err?.code === 'LIMIT_FILE_SIZE'
  ) {
    return new FileUploadError('File upload failed', err.reason || err.details || err.message, status >= 400 ? status : 400);
  }

  if (status === 504 || err?.code === 'ETIMEDOUT' || err?.name === 'TimeoutError') {
    return new TimeoutError(err.message || 'Request timed out', err.details);
  }

  if (err?.name === 'DatabaseError' || String(err?.code || '').startsWith('ER_')) {
    return new DatabaseError('Database operation failed', err.details || err.message);
  }

  return new ServerError(err?.message || 'Internal server error', err?.details);
}

function buildErrorResponse(normalized, req) {
  const timestamp = new Date().toISOString();
  const response = {
    error: normalized.expose || !isProduction() ? normalized.message : 'Internal server error',
    code: normalized.code,
    status: normalized.status,
    details: normalized.details || undefined,
    timestamp,
  };

  if (req?.requestId) {
    response.requestId = req.requestId;
  }

  if (!isProduction() && normalized.stack) {
    response.stack = normalized.stack;
  }

  if (isProduction() && normalized.status >= 500) {
    delete response.details;
    delete response.stack;
  }

  return response;
}

function errorHandler(err, req, res, next) {
  const normalized = normalizeError(err);

  res.locals.errorContext = {
    code: normalized.code,
    message: normalized.message,
    status: normalized.status,
  };

  logError('Request failed', normalized, {
    requestId: req?.requestId,
    path: req?.originalUrl,
    method: req?.method,
    userId: req?.user?.id,
    ip: req?.ip,
  });

  const payload = buildErrorResponse(normalized, req);
  return res.status(normalized.status).json(payload);
}

module.exports = errorHandler;
module.exports.AppError = AppError;
module.exports.ValidationError = ValidationError;
module.exports.NotFoundError = NotFoundError;
module.exports.UnauthorizedError = UnauthorizedError;
module.exports.ForbiddenError = ForbiddenError;
module.exports.ConflictError = ConflictError;
module.exports.DatabaseError = DatabaseError;
module.exports.FileUploadError = FileUploadError;
module.exports.TimeoutError = TimeoutError;
module.exports.ServerError = ServerError;
module.exports.normalizeError = normalizeError;
