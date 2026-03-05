const { getPool } = require('../config/database');
const { runAdvancedSearch, clearSearchCache, getSearchAnalytics } = require('../utils/searchHelper');
const { extractCVFields } = require('../utils/cvExtractor');
const { formatFileSize } = require('../utils/fileUpload');
const {
  getOverallStats,
  getSkillStats,
  getJobTitleStats,
  getExperienceStats,
  getEducationStats,
  getLanguageStats,
  getUploadAnalytics,
  getUserStats,
  invalidateStatsCache,
} = require('../utils/statsHelper');

function createError(status, error, details) {
  const err = new Error(error);
  err.status = status;
  if (details) {
    err.details = details;
  }
  return err;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return NaN;
  }

  return parsed;
}

function parsePagination(query, defaultLimit) {
  const rawLimit = parsePositiveInt(query.limit, defaultLimit);
  const rawSkip = parsePositiveInt(query.skip, 0);

  if (Number.isNaN(rawLimit) || Number.isNaN(rawSkip)) {
    throw createError(400, 'Bad Request', 'limit and skip must be non-negative integers');
  }

  const limit = Math.min(rawLimit, 1000);

  return { limit, skip: rawSkip };
}

function parseArrayField(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }

  let items;

  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
          throw new Error('not-array');
        }
        items = parsed;
      } catch (error) {
        throw createError(400, 'Bad Request', `${fieldName} must be a string array or comma-separated string`);
      }
    } else {
      items = trimmed.split(',');
    }
  } else {
    throw createError(400, 'Bad Request', `${fieldName} must be a string array or comma-separated string`);
  }

  return items
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 100);
}

function parseCvId(idParam) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    throw createError(400, 'Bad Request', 'id must be a positive integer');
  }

  return id;
}

function validateEmail(email) {
  if (email === undefined || email === null || email === '') {
    return null;
  }

  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createError(400, 'Bad Request', 'email must be valid');
  }

  return email.toLowerCase();
}

function validatePhone(phone) {
  if (phone === undefined || phone === null || phone === '') {
    return null;
  }

  if (typeof phone !== 'string' || !/^[0-9+()\-\s]{7,25}$/.test(phone)) {
    throw createError(400, 'Bad Request', 'phone must be 7-25 chars and contain valid symbols');
  }

  return phone.trim();
}

function parseOptionalNonNegativeInt(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw createError(400, 'Bad Request', `${fieldName} must be a non-negative integer`);
  }

  return num;
}

function validateOptionalShortText(value, fieldName, maxLen) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw createError(400, 'Bad Request', `${fieldName} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > maxLen) {
    throw createError(400, 'Bad Request', `${fieldName} must be <= ${maxLen} characters`);
  }

  return normalized;
}

function parseExperienceYearsFromText(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const match = value.match(/(\d{1,2})/);
  if (!match) return null;

  const years = Number(match[1]);
  if (!Number.isInteger(years) || years < 0) return null;
  return years;
}

function toUploadDate(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch (error) {
    return null;
  }
}

function safeParseArray(jsonText) {
  try {
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function mapCvRow(row) {
  return {
    id: row.id,
    filename: row.filename,
    email: row.email,
    phone: row.phone,
    skills: row.skills ? safeParseArray(row.skills) : [],
    jobTitles: row.job_titles ? safeParseArray(row.job_titles) : [],
    languages: row.languages ? safeParseArray(row.languages) : [],
    education: row.education || null,
    experienceYears: row.experience_years ?? null,
    fileSize: row.file_size ?? null,
    rawContent: row.raw_content,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * GET /api/cvs
 * Returns CV list with pagination support.
 *
 * Example response:
 * {
 *   "data": [ ... ],
 *   "pagination": { "limit": 100, "skip": 0, "count": 20, "total": 321 }
 * }
 */
async function getAllCVs(req, res, next) {
  try {
    const { limit, skip } = parsePagination(req.query, 100);
    const pool = getPool();

    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM cvs');
    const total = countRows[0].total;

    const [rows] = await pool.query(
      `
      SELECT id, filename, email, phone,
             CAST(skills AS CHAR) AS skills,
             CAST(job_titles AS CHAR) AS job_titles,
             CAST(languages AS CHAR) AS languages,
             education, experience_years, file_size,
             raw_content, created_by, created_at, updated_at
      FROM cvs
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
      `,
      [limit, skip]
    );

    return res.status(200).json({
      data: rows.map(mapCvRow),
      pagination: {
        limit,
        skip,
        count: rows.length,
        total,
      },
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/cvs/:id
 * Returns one CV by ID.
 */
async function getCVById(req, res, next) {
  try {
    const id = parseCvId(req.params.id);
    const pool = getPool();

    const [rows] = await pool.query(
      `
      SELECT id, filename, email, phone,
             CAST(skills AS CHAR) AS skills,
             CAST(job_titles AS CHAR) AS job_titles,
             CAST(languages AS CHAR) AS languages,
             education, experience_years, file_size,
             raw_content, created_by, created_at, updated_at
      FROM cvs
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (rows.length === 0) {
      throw createError(404, 'Not Found', 'CV not found');
    }

    return res.status(200).json({ data: mapCvRow(rows[0]) });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/cvs
 * Creates a CV record.
 *
 * Example request body:
 * {
 *   "filename": "john_doe_cv.pdf",
 *   "email": "john@example.com",
 *   "phone": "+1 555-123-4567",
 *   "skills": ["Node.js", "MySQL"],
 *   "jobTitles": ["Backend Engineer"],
 *   "rawContent": "..."
 * }
 */
async function createCV(req, res, next) {
  try {
    const hasUpload = Boolean(req.uploadData);
    const uploadFields = req.uploadData?.extractedFields || null;
    const filename = hasUpload ? req.uploadData.originalName : req.body.filename;
    const rawContent = hasUpload ? req.uploadData.rawContent : req.body.rawContent;

    if (!filename || typeof filename !== 'string' || !filename.trim()) {
      throw createError(400, 'Bad Request', 'filename is required');
    }

    if (rawContent !== undefined && rawContent !== null && typeof rawContent !== 'string') {
      throw createError(400, 'Bad Request', 'rawContent must be a string');
    }

    const derivedFields = rawContent && !uploadFields ? await extractCVFields(rawContent) : uploadFields;

    const email = validateEmail(req.body.email ?? derivedFields?.email ?? null);
    const phone = validatePhone(req.body.phone ?? derivedFields?.phone ?? null);
    const skills = parseArrayField(req.body.skills, 'skills') || derivedFields?.skills || [];
    const jobTitles = parseArrayField(req.body.jobTitles, 'jobTitles') || derivedFields?.jobTitles || [];
    const languages = parseArrayField(req.body.languages, 'languages') || derivedFields?.languages || [];
    const education = validateOptionalShortText(req.body.education ?? derivedFields?.education ?? null, 'education', 255);
    const experienceYears =
      parseOptionalNonNegativeInt(req.body.experienceYears, 'experienceYears') ??
      parseExperienceYearsFromText(derivedFields?.experience);
    const fileSize = parseOptionalNonNegativeInt(req.body.fileSize, 'fileSize') ?? req.uploadData?.fileSize ?? null;
    const normalizedRawContent = rawContent || null;

    const pool = getPool();
    const [result] = await pool.query(
      `
      INSERT INTO cvs (filename, email, phone, skills, job_titles, languages, education, experience_years, file_size, raw_content, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        filename.trim(),
        email,
        phone,
        JSON.stringify(skills),
        JSON.stringify(jobTitles),
        JSON.stringify(languages),
        education,
        experienceYears,
        fileSize,
        normalizedRawContent,
        req.user.id,
      ]
    );

    const [rows] = await pool.query(
      `
      SELECT id, filename, email, phone,
             CAST(skills AS CHAR) AS skills,
             CAST(job_titles AS CHAR) AS job_titles,
             CAST(languages AS CHAR) AS languages,
             education, experience_years, file_size,
             raw_content, created_by, created_at, updated_at
      FROM cvs
      WHERE id = ?
      LIMIT 1
      `,
      [result.insertId]
    );

    clearSearchCache();
    invalidateStatsCache();
    const created = mapCvRow(rows[0]);
    return res.status(201).json({
      success: true,
      message: 'CV uploaded successfully',
      cv: {
        id: created.id,
        name: created.filename,
        size: formatFileSize(created.fileSize || 0),
        uploadDate: toUploadDate(created.createdAt),
        fields: {
          email: created.email,
          phone: created.phone,
          jobTitles: created.jobTitles,
          skills: created.skills,
          languages: created.languages,
          education: created.education,
          experienceYears: created.experienceYears,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * PUT /api/cvs/:id
 * Updates an existing CV by ID.
 */
async function updateCV(req, res, next) {
  try {
    const id = parseCvId(req.params.id);
    const allowedFields = ['filename', 'email', 'phone', 'skills', 'jobTitles', 'languages', 'education', 'experienceYears', 'fileSize', 'rawContent'];

    const requestedFields = Object.keys(req.body);
    if (requestedFields.length === 0) {
      throw createError(400, 'Bad Request', 'request body cannot be empty');
    }

    const invalidFields = requestedFields.filter((field) => !allowedFields.includes(field));
    if (invalidFields.length > 0) {
      throw createError(400, 'Bad Request', `unsupported fields: ${invalidFields.join(', ')}`);
    }

    const pool = getPool();
    const [existingRows] = await pool.query('SELECT id, created_by FROM cvs WHERE id = ? LIMIT 1', [id]);
    if (existingRows.length === 0) {
      throw createError(404, 'Not Found', 'CV not found');
    }

    if (req.user.role !== 'admin' && Number(existingRows[0].created_by || 0) !== Number(req.user.id)) {
      throw createError(403, 'Forbidden', 'You can update only your own CVs');
    }

    const updates = [];
    const params = [];

    if (req.body.filename !== undefined) {
      if (typeof req.body.filename !== 'string' || !req.body.filename.trim()) {
        throw createError(400, 'Bad Request', 'filename must be a non-empty string');
      }
      updates.push('filename = ?');
      params.push(req.body.filename.trim());
    }

    if (req.body.email !== undefined) {
      updates.push('email = ?');
      params.push(validateEmail(req.body.email));
    }

    if (req.body.phone !== undefined) {
      updates.push('phone = ?');
      params.push(validatePhone(req.body.phone));
    }

    if (req.body.skills !== undefined) {
      updates.push('skills = ?');
      params.push(JSON.stringify(parseArrayField(req.body.skills, 'skills')));
    }

    if (req.body.jobTitles !== undefined) {
      updates.push('job_titles = ?');
      params.push(JSON.stringify(parseArrayField(req.body.jobTitles, 'jobTitles')));
    }

    if (req.body.languages !== undefined) {
      updates.push('languages = ?');
      params.push(JSON.stringify(parseArrayField(req.body.languages, 'languages')));
    }

    if (req.body.education !== undefined) {
      updates.push('education = ?');
      params.push(validateOptionalShortText(req.body.education, 'education', 255));
    }

    if (req.body.experienceYears !== undefined) {
      updates.push('experience_years = ?');
      params.push(parseOptionalNonNegativeInt(req.body.experienceYears, 'experienceYears'));
    }

    if (req.body.fileSize !== undefined) {
      updates.push('file_size = ?');
      params.push(parseOptionalNonNegativeInt(req.body.fileSize, 'fileSize'));
    }

    if (req.body.rawContent !== undefined) {
      if (req.body.rawContent !== null && typeof req.body.rawContent !== 'string') {
        throw createError(400, 'Bad Request', 'rawContent must be a string or null');
      }
      updates.push('raw_content = ?');
      params.push(req.body.rawContent);
    }

    if (updates.length === 0) {
      throw createError(400, 'Bad Request', 'no valid fields to update');
    }

    params.push(id);

    await pool.query(`UPDATE cvs SET ${updates.join(', ')} WHERE id = ?`, params);

    const [rows] = await pool.query(
      `
      SELECT id, filename, email, phone,
             CAST(skills AS CHAR) AS skills,
             CAST(job_titles AS CHAR) AS job_titles,
             CAST(languages AS CHAR) AS languages,
             education, experience_years, file_size,
             raw_content, created_by, created_at, updated_at
      FROM cvs
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    clearSearchCache();
    invalidateStatsCache();
    return res.status(200).json({ data: mapCvRow(rows[0]) });
  } catch (error) {
    return next(error);
  }
}

/**
 * DELETE /api/cvs/:id
 * Deletes a CV record.
 */
async function deleteCV(req, res, next) {
  try {
    const id = parseCvId(req.params.id);
    const pool = getPool();

    if (req.user.role !== 'admin') {
      const [ownershipRows] = await pool.query('SELECT created_by FROM cvs WHERE id = ? LIMIT 1', [id]);
      if (ownershipRows.length === 0) {
        throw createError(404, 'Not Found', 'CV not found');
      }
      if (Number(ownershipRows[0].created_by || 0) !== Number(req.user.id)) {
        throw createError(403, 'Forbidden', 'You can delete only your own CVs');
      }
    }

    let result;
    if (req.user.role === 'admin') {
      [result] = await pool.query('DELETE FROM cvs WHERE id = ?', [id]);
    } else {
      [result] = await pool.query('DELETE FROM cvs WHERE id = ? AND created_by = ?', [id, req.user.id]);
    }
    if (result.affectedRows === 0) {
      throw createError(404, 'Not Found', 'CV not found');
    }

    clearSearchCache();
    invalidateStatsCache();
    return res.status(200).json({
      message: 'CV deleted successfully',
      id,
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/search?q=keyword&limit=20
 * Searches across filename, email, phone, skills, job titles and raw content.
 */
async function searchCVs(req, res, next) {
  try {
    const payload = await runAdvancedSearch(req.query);
    return res.status(200).json(payload);
  } catch (error) {
    return next(error);
  }
}

async function getSearchInsights(req, res, next) {
  try {
    const top = Number(req.query.top || 10);
    return res.status(200).json({
      popularSearches: getSearchAnalytics(top),
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * GET /api/stats
 * Returns CV aggregate statistics.
 *
 * Example response:
 * {
 *   "totalCVs": 180,
 *   "topSkills": [{ "name": "JavaScript", "count": 57 }],
 *   "topJobTitles": [{ "name": "Backend Engineer", "count": 31 }],
 *   "lastUpdated": "2026-03-05T10:20:30.000Z"
 * }
 */
async function getStats(req, res, next) {
  try {
    const payload = await getOverallStats();
    return res.status(200).json(payload);
  } catch (error) {
    return next(error);
  }
}

async function getSkillsStats(req, res, next) {
  try {
    const payload = await getSkillStats();
    return res.status(200).json(payload);
  } catch (error) {
    return next(error);
  }
}

async function getJobTitlesStats(req, res, next) {
  try {
    const payload = await getJobTitleStats();
    return res.status(200).json(payload);
  } catch (error) {
    return next(error);
  }
}

async function getExperienceStatsController(req, res, next) {
  try {
    const payload = await getExperienceStats();
    return res.status(200).json(payload);
  } catch (error) {
    return next(error);
  }
}

async function getEducationStatsController(req, res, next) {
  try {
    const payload = await getEducationStats();
    return res.status(200).json(payload);
  } catch (error) {
    return next(error);
  }
}

async function getLanguagesStats(req, res, next) {
  try {
    const payload = await getLanguageStats();
    return res.status(200).json(payload);
  } catch (error) {
    return next(error);
  }
}

async function getUploadsStats(req, res, next) {
  try {
    const payload = await getUploadAnalytics(req.query);
    return res.status(200).json(payload);
  } catch (error) {
    return next(error);
  }
}

async function getUsersStats(req, res, next) {
  try {
    const payload = await getUserStats();
    return res.status(200).json(payload);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getAllCVs,
  getCVById,
  createCV,
  updateCV,
  deleteCV,
  searchCVs,
  getSearchInsights,
  getStats,
  getSkillsStats,
  getJobTitlesStats,
  getExperienceStatsController,
  getEducationStatsController,
  getLanguagesStats,
  getUploadsStats,
  getUsersStats,
};
