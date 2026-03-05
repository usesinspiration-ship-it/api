const mysql = require('mysql2/promise');

/**
 * MySQL connection pooling notes:
 * - A pool keeps a reusable set of open connections instead of creating one per request.
 * - This reduces latency and CPU overhead under load.
 * - `waitForConnections=true` + bounded `connectionLimit` prevents connection storms.
 * - Pool is process-local and safe for concurrent async usage in Node's event loop.
 *
 * Performance tips:
 * 1) Always use parameterized queries (`?`) to prevent SQL injection and improve plan reuse.
 * 2) Keep transactions short to avoid lock contention.
 * 3) Index columns used in WHERE/ORDER BY/JOIN.
 * 4) In production, monitor slow queries and tune `DB_SLOW_QUERY_MS`.
 */

let pool = null;
let initializingPromise = null;
let reconnectPromise = null;
let poolVerified = false;

const DEFAULT_RETRY_ATTEMPTS = Number(process.env.DB_RETRY_ATTEMPTS || 2);
const DEFAULT_RETRY_DELAY_MS = Number(process.env.DB_RETRY_DELAY_MS || 200);
const DEFAULT_SLOW_QUERY_MS = Number(process.env.DB_SLOW_QUERY_MS || 500);

class DatabaseError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DatabaseError';
    this.code = options.code;
    this.status = options.status || 500;
    this.details = options.details;
    this.originalError = options.originalError;
  }
}

function isProduction() {
  return String(process.env.NODE_ENV || 'development').toLowerCase() === 'production';
}

function readEnvVar(key) {
  const raw = process.env[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const value = String(raw).trim();
  return value === '' ? undefined : value;
}

function envValue(baseKey, fallback) {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  const envSpecific = readEnvVar(`${baseKey}_${env.toUpperCase()}`);
  const base = readEnvVar(baseKey);
  return envSpecific ?? base ?? fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

function parseNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function buildPoolConfig() {
  const host = firstDefined(envValue('DB_HOST'), readEnvVar('MYSQLHOST'), 'localhost');
  const port = parseNumber(firstDefined(envValue('DB_PORT'), readEnvVar('MYSQLPORT'), 3306), 3306);
  const user = firstDefined(envValue('DB_USER'), readEnvVar('MYSQLUSER'), 'root');
  const password = firstDefined(envValue('DB_PASS'), readEnvVar('MYSQLPASSWORD'), '');
  const database = firstDefined(envValue('DB_NAME'), readEnvVar('MYSQLDATABASE'), 'cv_vault_db');
  const enableSSL =
    String(firstDefined(envValue('DB_SSL'), readEnvVar('MYSQL_SSL'), 'false')).toLowerCase() === 'true';

  return {
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: Math.max(1, parseNumber(envValue('DB_POOL_SIZE', 10), 10)),
    queueLimit: parseNumber(envValue('DB_QUEUE_LIMIT', 0), 0),
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: parseNumber(envValue('DB_CONNECT_TIMEOUT_MS', 10000), 10000),
    dateStrings: false,
    timezone: 'Z',
    ssl: enableSSL ? { rejectUnauthorized: false } : undefined,
  };
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSqlPreview(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function logInfo(message, meta) {
  if (meta) {
    console.info(`[db] ${message}`, meta);
    return;
  }
  console.info(`[db] ${message}`);
}

function logWarn(message, meta) {
  if (meta) {
    console.warn(`[db] ${message}`, meta);
    return;
  }
  console.warn(`[db] ${message}`);
}

function logError(message, error, meta) {
  const payload = {
    ...(meta || {}),
    code: error?.code,
    errno: error?.errno,
    sqlState: error?.sqlState,
    message: error?.message,
    stack: error?.stack,
  };
  console.error(`[db] ${message}`, payload);
}

function getPoolStatus() {
  if (!pool?.pool) {
    return { initialized: false };
  }

  const internal = pool.pool;
  return {
    initialized: true,
    allConnections: internal._allConnections?.length ?? 0,
    freeConnections: internal._freeConnections?.length ?? 0,
    queuedRequests: internal._connectionQueue?.length ?? 0,
  };
}

function createPoolInstance() {
  const config = buildPoolConfig();
  const nextPool = mysql.createPool(config);

  // Hook into underlying driver events for visibility.
  if (nextPool.pool) {
    nextPool.pool.on('connection', () => {
      logInfo('new MySQL connection opened');
    });

    nextPool.pool.on('acquire', () => {
      if (!isProduction()) {
        logInfo('connection acquired', getPoolStatus());
      }
    });

    nextPool.pool.on('release', () => {
      if (!isProduction()) {
        logInfo('connection released', getPoolStatus());
      }
    });

    nextPool.pool.on('enqueue', () => {
      logWarn('connection queue is waiting', getPoolStatus());
    });
  }

  return nextPool;
}

async function pingPool(activePool) {
  const conn = await activePool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

function getPool() {
  if (!pool) {
    pool = createPoolInstance();
    poolVerified = false;
  }
  return pool;
}

async function ensurePool() {
  const activePool = getPool();
  if (poolVerified) {
    return activePool;
  }

  if (initializingPromise) {
    await initializingPromise;
    return activePool;
  }

  initializingPromise = (async () => {
    await pingPool(activePool);
    poolVerified = true;
    logInfo(
      `connected to MySQL (${buildPoolConfig().host}:${buildPoolConfig().port}/${buildPoolConfig().database})`,
      getPoolStatus()
    );
  })();

  try {
    await initializingPromise;
    return activePool;
  } catch (error) {
    pool = null;
    poolVerified = false;
    const config = buildPoolConfig();
    logError('initial connection failed', error, {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
    });
    throw normalizeDatabaseError(error, 'Database connection failed');
  } finally {
    initializingPromise = null;
  }
}

function isTransientError(error) {
  const transientCodes = new Set([
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ER_LOCK_DEADLOCK',
    'ER_LOCK_WAIT_TIMEOUT',
    'PROTOCOL_SEQUENCE_TIMEOUT',
  ]);
  return transientCodes.has(error?.code);
}

function isConnectionDrop(error) {
  const dropCodes = new Set([
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'ECONNRESET',
    'EPIPE',
  ]);
  return dropCodes.has(error?.code);
}

function normalizeDatabaseError(error, fallbackMessage = 'Database query failed') {
  if (error instanceof DatabaseError) {
    return error;
  }

  let message = fallbackMessage;
  let status = 500;

  switch (error?.code) {
    case 'ER_ACCESS_DENIED_ERROR':
      message = 'Database authentication failed';
      break;
    case 'ER_BAD_DB_ERROR':
      message = 'Database does not exist';
      break;
    case 'ER_DUP_ENTRY':
      message = 'Duplicate value violates a unique constraint';
      status = 409;
      break;
    case 'ER_LOCK_DEADLOCK':
    case 'ER_LOCK_WAIT_TIMEOUT':
      message = 'Database is busy, please retry';
      status = 503;
      break;
    case 'ETIMEDOUT':
    case 'PROTOCOL_SEQUENCE_TIMEOUT':
      message = 'Database request timed out';
      status = 504;
      break;
    case 'PROTOCOL_CONNECTION_LOST':
    case 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR':
    case 'ECONNRESET':
    case 'EPIPE':
      message = 'Database connection was interrupted';
      status = 503;
      break;
    default:
      break;
  }

  return new DatabaseError(message, {
    code: error?.code,
    status,
    details: isProduction() ? undefined : error?.message,
    originalError: error,
  });
}

async function reconnectPool(reason) {
  if (reconnectPromise) {
    return reconnectPromise;
  }

  reconnectPromise = (async () => {
    logWarn('reconnecting pool', { reason });

    const oldPool = pool;
    pool = null;
    poolVerified = false;

    if (oldPool) {
      try {
        await oldPool.end();
      } catch (closeError) {
        logError('error closing stale pool during reconnect', closeError);
      }
    }

    await ensurePool();
  })();

  try {
    await reconnectPromise;
  } finally {
    reconnectPromise = null;
  }
}

async function executeWithRetry(executor, context) {
  const maxAttempts = Math.max(1, DEFAULT_RETRY_ATTEMPTS + 1); // first try + retries
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const start = nowMs();
    try {
      const result = await executor();
      const duration = nowMs() - start;

      if (!isProduction() || duration >= DEFAULT_SLOW_QUERY_MS) {
        logInfo('query executed', {
          operation: context.operation,
          durationMs: duration,
          sql: context.sql,
          attempt,
        });
      }

      return result;
    } catch (error) {
      lastError = error;
      const duration = nowMs() - start;

      logError('query failed', error, {
        operation: context.operation,
        durationMs: duration,
        sql: context.sql,
        attempt,
      });

      const canRetry = isTransientError(error) && attempt < maxAttempts;
      if (!canRetry) {
        break;
      }

      if (isConnectionDrop(error)) {
        await reconnectPool(error.code);
      }

      const delay = DEFAULT_RETRY_DELAY_MS * attempt;
      logWarn('retrying query after transient error', {
        attempt,
        delayMs: delay,
        code: error.code,
      });
      await sleep(delay);
    }
  }

  throw normalizeDatabaseError(lastError);
}

function assertSql(sql) {
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    throw new DatabaseError('SQL query must be a non-empty string', {
      status: 400,
      code: 'DB_BAD_SQL',
    });
  }
}

/**
 * query(sql, params)
 * - Executes a parameterized SQL statement.
 * - Returns row array for SELECT or metadata object for write statements.
 */
async function query(sql, params = []) {
  assertSql(sql);

  const db = await ensurePool();
  const sqlPreview = toSqlPreview(sql);

  const [rows] = await executeWithRetry(
    () => db.execute(sql, params),
    { operation: 'query', sql: sqlPreview }
  );

  return rows;
}

/**
 * queryOne(sql, params)
 * - Returns first row or null.
 */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  return rows[0];
}

/**
 * queryCount(sql, params)
 * - Executes a count query and returns numeric count.
 * - Accepts aliases like `SELECT COUNT(*) AS total ...`.
 */
async function queryCount(sql, params = []) {
  const row = await queryOne(sql, params);
  if (!row) {
    return 0;
  }

  const firstValue = Object.values(row)[0];
  return Number(firstValue || 0);
}

async function queryUsingConnection(conn, sql, params = []) {
  assertSql(sql);
  const sqlPreview = toSqlPreview(sql);

  const [rows] = await executeWithRetry(
    () => conn.execute(sql, params),
    { operation: 'transaction.query', sql: sqlPreview }
  );

  return rows;
}

/**
 * transaction(callback)
 * - Runs callback in a DB transaction.
 * - Auto-commits on success.
 * - Rolls back on any error and rethrows normalized error.
 */
async function transaction(callback) {
  if (typeof callback !== 'function') {
    throw new DatabaseError('transaction callback must be a function', {
      status: 400,
      code: 'DB_BAD_TRANSACTION_CALLBACK',
    });
  }

  const db = await ensurePool();
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const tx = {
      query: (sql, params = []) => queryUsingConnection(conn, sql, params),
      queryOne: async (sql, params = []) => {
        const rows = await queryUsingConnection(conn, sql, params);
        if (!Array.isArray(rows) || rows.length === 0) {
          return null;
        }
        return rows[0];
      },
      queryCount: async (sql, params = []) => {
        const row = await tx.queryOne(sql, params);
        if (!row) return 0;
        const firstValue = Object.values(row)[0];
        return Number(firstValue || 0);
      },
    };

    const result = await callback(tx);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch (rollbackError) {
      logError('transaction rollback failed', rollbackError);
    }
    throw normalizeDatabaseError(error, 'Transaction failed');
  } finally {
    conn.release();
  }
}

/**
 * Explicit connection test that can be used on startup.
 */
async function testConnection() {
  try {
    const db = await ensurePool();
    const [rows] = await db.query('SELECT 1 AS ok');
    const ok = rows?.[0]?.ok === 1;

    logInfo(ok ? 'connection test succeeded' : 'connection test returned unexpected response');
    return ok;
  } catch (error) {
    logError('connection test failed', error);
    throw normalizeDatabaseError(error, 'Database health check failed');
  }
}

/**
 * Graceful connection closure, e.g. on SIGINT/SIGTERM.
 */
async function closePool() {
  if (!pool) {
    return;
  }

  const statusBeforeClose = getPoolStatus();

  try {
    await pool.end();
    pool = null;
    poolVerified = false;
    logInfo('pool closed gracefully', statusBeforeClose);
  } catch (error) {
    logError('failed to close pool', error, statusBeforeClose);
    throw normalizeDatabaseError(error, 'Failed to close database connections');
  }
}

/**
 * Optional schema bootstrap used by current API startup flow.
 */
async function initializeDatabase() {
  const ignoreSchemaErrorCodes = new Set(['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_PARSE_ERROR']);
  const runSchemaQuery = async (sql) => {
    try {
      await query(sql);
    } catch (error) {
      if (ignoreSchemaErrorCodes.has(error?.code)) {
        return;
      }
      if (/Duplicate column name|Duplicate key name|already exists/i.test(error?.message || '')) {
        return;
      }
      throw error;
    }
  };

  const runCreateWithForeignKeyFallback = async (sqlWithForeignKey, sqlWithoutForeignKey) => {
    try {
      await query(sqlWithForeignKey);
    } catch (error) {
      const isForeignKeyCreateError =
        error?.code === 'ER_CANT_CREATE_TABLE' &&
        /Foreign key constraint is incorrectly formed/i.test(error?.message || '');

      if (!isForeignKeyCreateError) {
        throw error;
      }

      logWarn('foreign key creation failed; retrying without foreign key', {
        code: error?.code,
        errno: error?.errno,
        message: error?.message,
      });

      await query(sqlWithoutForeignKey);
    }
  };

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin','hr','recruiter','viewer') NOT NULL DEFAULT 'viewer',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      last_login_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await runCreateWithForeignKeyFallback(
    `
    CREATE TABLE IF NOT EXISTS user_refresh_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      is_revoked TINYINT(1) NOT NULL DEFAULT 0,
      revoked_at DATETIME NULL,
      last_used_at DATETIME NULL,
      user_agent VARCHAR(500) NULL,
      ip_address VARCHAR(100) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_user_refresh_token_hash (token_hash),
      KEY idx_user_refresh_tokens_user_id (user_id),
      KEY idx_user_refresh_tokens_expires_at (expires_at),
      CONSTRAINT fk_user_refresh_tokens_user_id
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,
    `
    CREATE TABLE IF NOT EXISTS user_refresh_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      is_revoked TINYINT(1) NOT NULL DEFAULT 0,
      revoked_at DATETIME NULL,
      last_used_at DATETIME NULL,
      user_agent VARCHAR(500) NULL,
      ip_address VARCHAR(100) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_user_refresh_token_hash (token_hash),
      KEY idx_user_refresh_tokens_user_id (user_id),
      KEY idx_user_refresh_tokens_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `
  );

  await runCreateWithForeignKeyFallback(
    `
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      requested_ip VARCHAR(100) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_password_reset_token_hash (token_hash),
      KEY idx_password_reset_tokens_user_id (user_id),
      KEY idx_password_reset_tokens_expires_at (expires_at),
      CONSTRAINT fk_password_reset_tokens_user_id
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,
    `
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      requested_ip VARCHAR(100) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_password_reset_token_hash (token_hash),
      KEY idx_password_reset_tokens_user_id (user_id),
      KEY idx_password_reset_tokens_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `
  );

  await query(`
    CREATE TABLE IF NOT EXISTS auth_token_blacklist (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      token_hash VARCHAR(255) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_auth_token_blacklist_hash (token_hash),
      KEY idx_auth_token_blacklist_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await runCreateWithForeignKeyFallback(
    `
    CREATE TABLE IF NOT EXISTS cvs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      filename VARCHAR(255) NOT NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(50) NULL,
      skills JSON NULL,
      job_titles JSON NULL,
      languages JSON NULL,
      education VARCHAR(255) NULL,
      experience_years INT NULL,
      file_size BIGINT UNSIGNED NULL,
      raw_content LONGTEXT NULL,
      created_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_cvs_filename (filename),
      KEY idx_cvs_email (email),
      KEY idx_cvs_phone (phone),
      KEY idx_cvs_education (education),
      KEY idx_cvs_experience_years (experience_years),
      KEY idx_cvs_file_size (file_size),
      KEY idx_cvs_updated_at (updated_at),
      CONSTRAINT fk_cvs_created_by
        FOREIGN KEY (created_by) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,
    `
    CREATE TABLE IF NOT EXISTS cvs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      filename VARCHAR(255) NOT NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(50) NULL,
      skills JSON NULL,
      job_titles JSON NULL,
      languages JSON NULL,
      education VARCHAR(255) NULL,
      experience_years INT NULL,
      file_size BIGINT UNSIGNED NULL,
      raw_content LONGTEXT NULL,
      created_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_cvs_filename (filename),
      KEY idx_cvs_email (email),
      KEY idx_cvs_phone (phone),
      KEY idx_cvs_education (education),
      KEY idx_cvs_experience_years (experience_years),
      KEY idx_cvs_file_size (file_size),
      KEY idx_cvs_updated_at (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `
  );

  await runSchemaQuery('ALTER TABLE cvs ADD COLUMN languages JSON NULL');
  await runSchemaQuery('ALTER TABLE cvs ADD COLUMN education VARCHAR(255) NULL');
  await runSchemaQuery('ALTER TABLE cvs ADD COLUMN experience_years INT NULL');
  await runSchemaQuery('ALTER TABLE cvs ADD COLUMN file_size BIGINT UNSIGNED NULL');
  await runSchemaQuery('CREATE INDEX idx_cvs_education ON cvs(education)');
  await runSchemaQuery('CREATE INDEX idx_cvs_experience_years ON cvs(experience_years)');
  await runSchemaQuery('CREATE INDEX idx_cvs_file_size ON cvs(file_size)');

  await runSchemaQuery("ALTER TABLE users ADD COLUMN role ENUM('admin','hr','recruiter','viewer') NOT NULL DEFAULT 'viewer'");
  await runSchemaQuery('ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1');
  await runSchemaQuery('ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP NULL DEFAULT NULL');
}

/**
 * Usage examples:
 *
 * const { query, queryOne, queryCount, transaction } = require('./config/database');
 *
 * // 1) query
 * const users = await query('SELECT id, email FROM users WHERE email LIKE ?', ['%example.com%']);
 *
 * // 2) queryOne
 * const user = await queryOne('SELECT id, name FROM users WHERE id = ?', [1]);
 * if (!user) {
 *   // not found
 * }
 *
 * // 3) queryCount
 * const total = await queryCount('SELECT COUNT(*) AS total FROM cvs WHERE email IS NOT NULL');
 *
 * // 4) transaction
 * const result = await transaction(async (tx) => {
 *   const insert = await tx.query('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [
 *     'Jane',
 *     'jane@example.com',
 *     'hash',
 *   ]);
 *   await tx.query('INSERT INTO cvs (filename, created_by) VALUES (?, ?)', ['jane_cv.pdf', insert.insertId]);
 *   return { userId: insert.insertId };
 * });
 *
 * Error handling pattern:
 * try {
 *   await query('SELECT * FROM missing_table');
 * } catch (error) {
 *   // error.message is user-friendly
 *   // error.code can be used for programmatic checks
 * }
 */

module.exports = {
  DatabaseError,
  getPool,
  getPoolStatus,
  testConnection,
  query,
  queryOne,
  queryCount,
  transaction,
  initializeDatabase,
  closePool,
};

/**
 * Connection test script:
 * Run directly: `node config/database.js`
 */
if (require.main === module) {
  (async () => {
    try {
      const ok = await testConnection();
      if (!ok) {
        process.exitCode = 1;
      }
      await closePool();
    } catch (error) {
      logError('standalone database test failed', error);
      process.exitCode = 1;
      try {
        await closePool();
      } catch (_) {
        // ignore
      }
    }
  })();
}
