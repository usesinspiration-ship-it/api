# CV Vault Backend (Express + MySQL)

Production-ready REST API for CV management with Express.js and MySQL (Hostinger-compatible).

## Tech Stack
- Node.js + Express.js
- MySQL via `mysql2` pooling
- JWT authentication
- bcrypt password hashing
- dotenv configuration

## Project Structure
```text
cv-vault-backend/
├── server.js
├── package.json
├── .env
├── .env.example
├── config/
│   └── database.js
├── routes/
│   ├── cv.routes.js
│   └── auth.routes.js
├── controllers/
│   ├── cvController.js
│   └── authController.js
└── middleware/
    ├── auth.js
    ├── errorHandler.js
    └── requestLogger.js
```

## Environment Variables
Use `.env` (already included) or copy from `.env.example`:

```env
PORT=3000
NODE_ENV=development
DB_HOST=localhost
DB_PORT=3306
DB_USER=cv_vault_user
DB_PASS=password
DB_NAME=cv_vault_db
DB_POOL_SIZE=10
DB_SSL=false
JWT_SECRET=your_secret_key
JWT_EXPIRES_IN=7d
API_URL=http://localhost:3000
UPLOAD_MAX_MB=50
UPLOAD_MIN_KB=1
ENABLE_CLAMAV_SCAN=false
CLAMAV_COMMAND=clamscan
```

## Install and Run
```bash
npm install
npm run dev
```

Production:
```bash
npm start
```

Server starts on `PORT` (default `3000`).

## Database Behavior
- Uses pooled MySQL connections (`config/database.js`).
- Startup runs:
1. Connection test (`SELECT 1`)
2. Auto-create tables (`users`, `cvs`) if missing.

## Authentication
Send JWT in header for protected endpoints:
```text
Authorization: Bearer <token>
```

## API Endpoints

### Health
1. `GET /api/status`
- Response:
```json
{
  "status": "ok",
  "timestamp": "2026-03-05T10:30:00.000Z",
  "version": "1.0.0"
}
```

### Auth
1. `POST /api/auth/register`
- Body:
```json
{
  "name": "Alex",
  "email": "alex@example.com",
  "password": "StrongPass123!",
  "role": "hr"
}
```
- Password policy: minimum 8 chars with uppercase, lowercase, number, symbol
- Allowed roles: `admin`, `hr`, `recruiter`, `viewer`

2. `POST /api/auth/login`
- Body:
```json
{
  "email": "alex@example.com",
  "password": "StrongPass123!"
}
```
- Response includes `accessToken`, `refreshToken`, `expiresIn`, and user profile

3. `POST /api/auth/refresh`
```json
{
  "refreshToken": "eyJhbGc..."
}
```

4. `POST /api/auth/logout` (protected)
```json
{
  "refreshToken": "eyJhbGc..."
}
```

5. `GET /api/auth/me` (protected)

6. `POST /api/auth/password-reset`
```json
{
  "email": "alex@example.com"
}
```

7. `POST /api/auth/verify-reset-token`
```json
{
  "token": "reset_token_here"
}
```

8. `POST /api/auth/new-password`
```json
{
  "token": "reset_token_here",
  "newPassword": "NewPassword123!"
}
```

Auth response examples:

Register:
```json
{
  "success": true,
  "message": "User registered successfully",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "role": "hr"
  }
}
```

Login:
```json
{
  "success": true,
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc...",
  "expiresIn": 3600,
  "user": {
    "id": 1,
    "email": "user@example.com",
    "role": "hr"
  }
}
```

Reset request:
```json
{
  "success": true,
  "message": "Reset link sent to email"
}
```

### CV CRUD
1. `GET /api/cvs?limit=100&skip=0` (protected)
- Defaults: `limit=100`, `skip=0`
- Max `limit=1000`

2. `GET /api/cvs/:id` (protected)

3. `POST /api/cvs` (protected)
- JSON body:
```json
{
  "filename": "john_doe_cv.pdf",
  "email": "john@example.com",
  "phone": "+1 555-123-4567",
  "skills": ["Node.js", "MySQL"],
  "jobTitles": ["Backend Engineer"],
  "rawContent": "Full resume text"
}
```
- Multipart upload (`cv` field, recommended for files):
- Multipart upload (`file` field recommended, `cv` also supported):
```bash
curl -X POST 'http://localhost:3000/api/cvs' \
  -H 'Authorization: Bearer <token>' \
  -F 'file=@/path/to/resume.pdf' \
  -F 'education=Bachelor in Computer Science' \
  -F 'experienceYears=5'
```
- Accepted extensions: `.txt`, `.pdf`, `.doc`, `.docx`
- Size limits: min `1KB`, max `50MB`
- Validation includes extension, MIME, corruption checks, hidden/executable rejection, and optional ClamAV scan.
- Storage mode: extracted text is stored in MySQL `cvs.raw_content` (`LONGTEXT`) and parsed metadata in structured columns.
- Success response:
```json
{
  "success": true,
  "message": "CV uploaded successfully",
  "cv": {
    "id": 123,
    "name": "john_resume.txt",
    "size": "45.2 KB",
    "uploadDate": "2024-03-05",
    "fields": {
      "email": "john@example.com",
      "jobTitles": ["Senior Developer"],
      "skills": ["JavaScript", "React"]
    }
  }
}
```
- Validation error response:
```json
{
  "error": "File validation failed",
  "reason": "File size exceeds 50MB limit"
}
```

4. `PUT /api/cvs/:id` (protected)
- Body can include any of:
`filename`, `email`, `phone`, `skills`, `jobTitles`, `rawContent`

5. `DELETE /api/cvs/:id` (protected)

### Search
1. `GET /api/search?q=keyword&limit=20&skip=0` (protected)
- Searches `filename`, `email`, `phone`, `job_titles`, `skills`, `languages`, `raw_content`
- Default `limit=20`, max `100`
- Supports `page` as alternative to `skip`
- Field filters:
`skill`, `title`, `experience`, `minExperience`, `maxExperience`, `education`, `languages`
- Boolean query support in `q`:
`AND`, `OR`, `NOT` (example: `Python AND React NOT Java`)
- Sorting:
`sort=relevance|date|filesize|name`, `order=asc|desc`

2. `GET /api/search/analytics?top=10` (protected)
- Returns popular search terms tracked in memory.

Search ranking weights:
- Exact filename match: `10`
- Email/phone match: `8`
- Job title match: `7`
- Skill match: `6`
- Language match: `4`
- Content match: `3`

Example:
```bash
curl -G 'http://localhost:3000/api/search' \
  -H 'Authorization: Bearer <token>' \
  --data-urlencode 'q=React Developer' \
  --data-urlencode 'skill=JavaScript' \
  --data-urlencode 'skill=React' \
  --data-urlencode 'minExperience=3' \
  --data-urlencode 'education=Bachelor,Master' \
  --data-urlencode 'languages=English,Spanish' \
  --data-urlencode 'sort=relevance' \
  --data-urlencode 'order=desc' \
  --data-urlencode 'limit=20' \
  --data-urlencode 'page=1'
```

Response format:
```json
{
  "query": "React Developer",
  "results": [
    {
      "id": 123,
      "name": "john_resume.txt",
      "relevance": 0.95,
      "email": "john@example.com",
      "jobTitles": ["Senior React Developer"],
      "skills": ["React", "JavaScript", "Node.js"],
      "uploadDate": "2024-03-05T00:00:00.000Z"
    }
  ],
  "total": 45,
  "page": 1,
  "pages": 3,
  "hasMore": true,
  "executedIn": "145ms"
}
```

### Stats
1. `GET /api/stats` (protected)
- Overall stats response:
```json
{
  "totalCVs": 180,
  "totalSize": "6.2 GB",
  "averageFileSize": "42.5 KB",
  "lastUpload": "2026-03-05T10:20:30.000Z",
  "uploadTrend": {
    "today": 5,
    "thisWeek": 25,
    "thisMonth": 87
  },
  "uploadTrendChart": {
    "labels": ["2026-03-01", "2026-03-02"],
    "data": [8, 5],
    "type": "line"
  }
}
```

2. `GET /api/stats/skills`
3. `GET /api/stats/job-titles`
4. `GET /api/stats/experience`
5. `GET /api/stats/education`
6. `GET /api/stats/languages`
7. `GET /api/stats/uploads?from=2026-02-01&to=2026-03-05&granularity=day|week|month`
8. `GET /api/stats/users` (admin only)

All stats endpoints return chart-friendly payloads (`labels`, `data`, `type`) where applicable.

## Error Format
All errors return:
```json
{
  "error": "Invalid input",
  "code": "VALIDATION_ERROR",
  "status": 400,
  "details": "filename is required",
  "timestamp": "2026-03-05T10:30:00.000Z"
}
```

Status codes:
- `400` Bad Request
- `401` Unauthorized
- `404` Not Found
- `500` Server Error

Error classes implemented:
- `ValidationError`
- `NotFoundError`
- `UnauthorizedError`
- `ForbiddenError`
- `ConflictError`
- `DatabaseError`
- `FileUploadError`
- `TimeoutError`
- `ServerError`

## Auth Security Notes
- Access token: JWT, default expiry `1h`, claims: `userId`, `email`, `role`, `jti`.
- Refresh token: JWT, default expiry `7d`, stored hashed in `user_refresh_tokens`.
- Logout revokes refresh token and blacklists access-token `jti`.
- Password reset tokens are random, hashed in DB, and expire in `1h` by default.
- Auth routes include in-memory rate limiting (global + sensitive endpoint limits).

## Role Permissions
- `admin`: full access, user management, all CV operations.
- `hr`: upload/search/download CVs, manage own CVs, filtered stats.
- `recruiter`: search/view/download CVs, stats.
- `viewer`: read-only search/view/stats.

Use middleware:
```js
const { verifyToken, requireRole } = require('./middleware/auth');
app.get('/api/admin/users', verifyToken, requireRole('admin'), handler);
```

## CORS
Configured to allow:
- Origins: `*` (development default)
- Methods: `GET, POST, DELETE, PUT, OPTIONS`
- Headers: `Content-Type, Authorization`

## Request Logging
Request logging includes:
- request ID
- method + URL + query
- status code
- response time
- user ID (if authenticated)
- error context for failed requests

Log example:
```text
[2026-03-05 10:30:45] GET /api/cvs - 200 - 145ms - user:123 - req:8e8f...
```

Logging backends:
- Console (development)
- Daily rotating files with gzip compression (`LOG_DIR`)
- Optional external webhook forwarding for warn/error logs (`LOG_EXTERNAL_WEBHOOK`)

Logger utility helpers:
- `getErrorMetrics()` for monitoring dashboards
- `readLogFile(date)` and `readLogTail(lines, date)` for simple log viewer tooling

Sensitive data masking:
- Passwords/tokens/api keys
- Partial email masking
- Credit-card-like number masking

## Graceful Shutdown
Handles `SIGINT`, `SIGTERM`, and unhandled promise rejections.
- Stops accepting new requests
- Closes MySQL pool
- Exits cleanly

## Hostinger Notes
- Set Hostinger DB credentials in `.env`
- Keep `DB_SSL=true` if your Hostinger database requires SSL
- Use `npm start` in production

## Search Optimization Notes
- Startup creates search indexes including FULLTEXT on `cvs.raw_content`.
- Search results are cached in-memory for 15 minutes.
- Cache is invalidated when CVs are created/updated/deleted.
- Fuzzy aliases cover common typos/synonyms (example: `pythno -> python`, `aws -> amazon web services`).

## Local Test Commands
```bash
npm run test:search
npm run test:extractor
npm run bench:extractor
```
