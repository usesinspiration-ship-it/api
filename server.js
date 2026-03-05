const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const cvRoutes = require('./routes/cv.routes');
const authRoutes = require('./routes/auth.routes');
const errorHandler = require('./middleware/errorHandler');
const { NotFoundError } = require('./middleware/errorHandler');
const requestLogger = require('./middleware/requestLogger');
const logger = require('./utils/logger');
const { testConnection, initializeDatabase, closePool } = require('./config/database');
const { ensureSearchIndexes } = require('./utils/searchHelper');
const { ensureStatsIndexes } = require('./utils/statsHelper');

const app = express();
const pkg = require('./package.json');

app.disable('x-powered-by');

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

/**
 * GET /api/status
 * Example response:
 * {
 *   "status": "ok",
 *   "timestamp": "2026-03-05T07:00:00.000Z",
 *   "version": "1.0.0"
 * }
 */
app.get('/api/status', async (req, res, next) => {
  try {
    await testConnection();
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: pkg.version,
    });
  } catch (error) {
    return next({
      status: 500,
      message: 'Server Error',
      details: `database check failed: ${error.message}`,
    });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api', cvRoutes);

app.use((req, res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} does not exist`));
});

app.use(errorHandler);

const PORT = Number(process.env.PORT || 3000);
let server;
let shuttingDown = false;

async function start() {
  await testConnection();
  await initializeDatabase();
  await ensureSearchIndexes();
  await ensureStatsIndexes();

  server = app.listen(PORT, () => {
    logger.info(`API server listening on port ${PORT}`, {
      env: process.env.NODE_ENV || 'development',
    });
  });
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.warn(`${signal} received. Starting graceful shutdown...`);

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await closePool();
    logger.info('Shutdown complete.');
    process.exit(0);
  } catch (error) {
    logger.error('Shutdown error', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection', error);
  shutdown('unhandledRejection');
});

start().catch((error) => {
  logger.error('Startup failed', error);
  process.exit(1);
});

module.exports = app;
