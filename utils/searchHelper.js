const { performance } = require('node:perf_hooks');

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 300;

const searchCache = new Map();
const searchAnalytics = new Map();
let dbModule = null;

function getDb() {
  if (!dbModule) {
    // Lazy load to keep parser/unit tests runnable without DB driver installed.
    dbModule = require('../config/database');
  }
  return dbModule;
}

async function dbQuery(sql, params = []) {
  return getDb().query(sql, params);
}

async function dbQueryOne(sql, params = []) {
  return getDb().queryOne(sql, params);
}

const FUZZY_CANONICAL = {
  python: ['pythno', 'pyhton'],
  javascript: ['js', 'javascritp', 'java script'],
  'node.js': ['nodejs', 'node js'],
  aws: ['amazon web services', 'amazn web services'],
  react: ['reactjs', 'react js'],
  kubernetes: ['k8s'],
};

const FUZZY_REVERSE = Object.entries(FUZZY_CANONICAL).reduce((acc, [canonical, variants]) => {
  acc[canonical] = canonical;
  for (const variant of variants) {
    acc[variant] = canonical;
  }
  return acc;
}, {});

function createError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details) {
    err.details = details;
  }
  return err;
}

function normalizeTerm(value) {
  if (!value) return '';
  return String(value).toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();
}

function splitTerms(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .flatMap((item) => String(item).split(','))
      .map((item) => normalizeTerm(item))
      .filter(Boolean);
  }

  return String(value)
    .split(',')
    .map((item) => normalizeTerm(item))
    .filter(Boolean);
}

function toUnique(values) {
  const seen = new Set();
  const out = [];

  for (const value of values) {
    const key = normalizeTerm(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }

  return out;
}

function canonicalizeTerm(term) {
  const normalized = normalizeTerm(term);
  return FUZZY_REVERSE[normalized] || normalized;
}

function expandFuzzyTerms(term) {
  const canonical = canonicalizeTerm(term);
  const variants = FUZZY_CANONICAL[canonical] || [];
  return toUnique([canonical, ...variants]);
}

function parseBooleanQuery(rawQuery) {
  const tokens = String(rawQuery || '').match(/"[^"]+"|\S+/g) || [];
  const requiredTerms = [];
  const optionalTerms = [];
  const excludedTerms = [];

  let operator = 'OR';
  let previousBucket = null;

  for (const rawToken of tokens) {
    const upper = rawToken.toUpperCase();

    if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
      operator = upper;
      continue;
    }

    const cleanTerm = canonicalizeTerm(rawToken.replace(/^"|"$/g, ''));
    if (!cleanTerm) continue;

    if (operator === 'NOT') {
      excludedTerms.push(cleanTerm);
      previousBucket = 'excluded';
      operator = 'OR';
      continue;
    }

    if (operator === 'AND') {
      if (previousBucket === 'optional' && optionalTerms.length > 0) {
        const lastOptional = optionalTerms.pop();
        requiredTerms.push(lastOptional);
      }
      requiredTerms.push(cleanTerm);
      previousBucket = 'required';
      operator = 'OR';
      continue;
    }

    optionalTerms.push(cleanTerm);
    previousBucket = 'optional';
  }

  const allPositiveTerms = toUnique([...requiredTerms, ...optionalTerms]);
  const fullTextBoolean = [
    ...requiredTerms.map((term) => `+${term}`),
    ...optionalTerms,
    ...excludedTerms.map((term) => `-${term}`),
  ].join(' ');

  return {
    requiredTerms: toUnique(requiredTerms),
    optionalTerms: toUnique(optionalTerms),
    excludedTerms: toUnique(excludedTerms),
    allPositiveTerms,
    fullTextBoolean,
  };
}

function parseInteger(value, fieldName, { min = 0, allowNull = true } = {}) {
  if (value === undefined || value === null || value === '') {
    return allowNull ? null : NaN;
  }

  const num = Number(value);
  if (!Number.isInteger(num) || num < min) {
    throw createError(400, 'Bad Request', `${fieldName} must be an integer >= ${min}`);
  }

  return num;
}

function parsePagination(queryParams) {
  const limit = Math.min(parseInteger(queryParams.limit, 'limit', { min: 1, allowNull: true }) ?? 20, 100);
  let skip = parseInteger(queryParams.skip, 'skip', { min: 0, allowNull: true }) ?? 0;
  const pageParam = parseInteger(queryParams.page, 'page', { min: 1, allowNull: true });

  if (pageParam && (queryParams.skip === undefined || queryParams.skip === null || queryParams.skip === '')) {
    skip = (pageParam - 1) * limit;
  }

  const page = Math.floor(skip / limit) + 1;

  return { limit, skip, page };
}

function parseSort(queryParams, hasSearchTerms) {
  const sortRaw = normalizeTerm(queryParams.sort || 'relevance');
  const orderRaw = normalizeTerm(queryParams.order || 'desc');

  const allowedSort = new Set(['relevance', 'date', 'filesize', 'name']);
  const allowedOrder = new Set(['asc', 'desc']);

  const sort = allowedSort.has(sortRaw) ? sortRaw : 'relevance';
  const order = allowedOrder.has(orderRaw) ? orderRaw : 'desc';

  if (sort === 'relevance' && !hasSearchTerms) {
    return { sort: 'date', order: 'desc' };
  }

  return { sort, order };
}

function parseSearchRequest(queryParams) {
  const q = String(queryParams.q || '').trim();
  const booleanParts = parseBooleanQuery(q);

  const skillFilters = toUnique(splitTerms(queryParams.skill).map(canonicalizeTerm));
  const titleFilters = toUnique(splitTerms(queryParams.title).map(canonicalizeTerm));
  const languageFilters = toUnique(splitTerms(queryParams.languages).map(canonicalizeTerm));
  const educationFilters = toUnique(splitTerms(queryParams.education).map(canonicalizeTerm));

  const exactExperience = parseInteger(queryParams.experience, 'experience', { min: 0, allowNull: true });
  const minExperience = parseInteger(queryParams.minExperience, 'minExperience', { min: 0, allowNull: true });
  const maxExperience = parseInteger(queryParams.maxExperience, 'maxExperience', { min: 0, allowNull: true });

  if (minExperience !== null && maxExperience !== null && minExperience > maxExperience) {
    throw createError(400, 'Bad Request', 'minExperience cannot be greater than maxExperience');
  }

  const expandedSearchTerms = toUnique(
    booleanParts.allPositiveTerms.flatMap((term) => expandFuzzyTerms(term)).slice(0, 12)
  );

  const hasQuerySignal = expandedSearchTerms.length > 0 || booleanParts.excludedTerms.length > 0;
  const hasFieldFilters =
    skillFilters.length > 0 ||
    titleFilters.length > 0 ||
    languageFilters.length > 0 ||
    educationFilters.length > 0 ||
    exactExperience !== null ||
    minExperience !== null ||
    maxExperience !== null;

  if (!hasQuerySignal && !hasFieldFilters) {
    throw createError(
      400,
      'Bad Request',
      'Provide at least one search input: q, skill, title, experience, minExperience, maxExperience, education, or languages'
    );
  }

  const pagination = parsePagination(queryParams);
  const sort = parseSort(queryParams, expandedSearchTerms.length > 0);

  return {
    q,
    requiredTerms: booleanParts.requiredTerms,
    optionalTerms: booleanParts.optionalTerms,
    excludedTerms: booleanParts.excludedTerms,
    fullTextBoolean: booleanParts.fullTextBoolean,
    searchTerms: expandedSearchTerms,
    skillFilters,
    titleFilters,
    languageFilters,
    educationFilters,
    exactExperience,
    minExperience,
    maxExperience,
    ...pagination,
    ...sort,
  };
}

function safeParseJsonArray(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function buildWhereClause(parsed, useFullText) {
  const whereParts = [];
  const params = [];

  const searchableExpr =
    "LOWER(CONCAT_WS(' ', filename, COALESCE(email,''), COALESCE(phone,''), COALESCE(CAST(job_titles AS CHAR),''), COALESCE(CAST(skills AS CHAR),''), COALESCE(CAST(languages AS CHAR),''), COALESCE(education,''), COALESCE(raw_content,'')))";

  for (const term of parsed.requiredTerms) {
    whereParts.push(`${searchableExpr} LIKE ?`);
    params.push(`%${term}%`);
  }

  if (parsed.optionalTerms.length > 0 || (useFullText && parsed.fullTextBoolean)) {
    const optionalChecks = [];

    for (const term of parsed.searchTerms) {
      optionalChecks.push(`${searchableExpr} LIKE ?`);
      params.push(`%${term}%`);
    }

    if (useFullText && parsed.fullTextBoolean) {
      optionalChecks.push('MATCH(raw_content) AGAINST (? IN BOOLEAN MODE) > 0');
      params.push(parsed.fullTextBoolean);
    }

    if (optionalChecks.length > 0) {
      whereParts.push(`(${optionalChecks.join(' OR ')})`);
    }
  }

  for (const term of parsed.excludedTerms) {
    whereParts.push(`${searchableExpr} NOT LIKE ?`);
    params.push(`%${term}%`);
  }

  for (const skill of parsed.skillFilters) {
    whereParts.push("LOWER(COALESCE(CAST(skills AS CHAR), '')) LIKE ?");
    params.push(`%${skill}%`);
  }

  for (const title of parsed.titleFilters) {
    whereParts.push("LOWER(COALESCE(CAST(job_titles AS CHAR), '')) LIKE ?");
    params.push(`%${title}%`);
  }

  for (const lang of parsed.languageFilters) {
    whereParts.push("LOWER(COALESCE(CAST(languages AS CHAR), '')) LIKE ?");
    params.push(`%${lang}%`);
  }

  if (parsed.educationFilters.length > 0) {
    whereParts.push(`(${parsed.educationFilters.map(() => 'LOWER(COALESCE(education, "")) LIKE ?').join(' OR ')})`);
    for (const edu of parsed.educationFilters) {
      params.push(`%${edu}%`);
    }
  }

  if (parsed.exactExperience !== null) {
    whereParts.push('COALESCE(experience_years, -1) = ?');
    params.push(parsed.exactExperience);
  }

  if (parsed.minExperience !== null) {
    whereParts.push('COALESCE(experience_years, 0) >= ?');
    params.push(parsed.minExperience);
  }

  if (parsed.maxExperience !== null) {
    whereParts.push('COALESCE(experience_years, 0) <= ?');
    params.push(parsed.maxExperience);
  }

  if (whereParts.length === 0) {
    return { whereSql: '', params };
  }

  return {
    whereSql: `WHERE ${whereParts.join(' AND ')}`,
    params,
  };
}

function buildRelevanceExpr(parsed, useFullText) {
  if (parsed.searchTerms.length === 0) {
    return { exprSql: '0', params: [], maxScore: 1 };
  }

  const pieces = [];
  const params = [];

  for (const term of parsed.searchTerms) {
    const like = `%${term}%`;

    pieces.push(`(
      CASE WHEN LOWER(filename) = ? THEN 10 WHEN LOWER(filename) LIKE ? THEN 5 ELSE 0 END +
      CASE WHEN LOWER(COALESCE(email, '')) LIKE ? OR LOWER(COALESCE(phone, '')) LIKE ? THEN 8 ELSE 0 END +
      CASE WHEN LOWER(COALESCE(CAST(job_titles AS CHAR), '')) LIKE ? THEN 7 ELSE 0 END +
      CASE WHEN LOWER(COALESCE(CAST(skills AS CHAR), '')) LIKE ? THEN 6 ELSE 0 END +
      CASE WHEN LOWER(COALESCE(CAST(languages AS CHAR), '')) LIKE ? THEN 4 ELSE 0 END +
      CASE WHEN LOWER(COALESCE(raw_content, '')) LIKE ? THEN 3 ELSE 0 END
    )`);

    params.push(term, like, like, like, like, like, like);
  }

  if (useFullText && parsed.fullTextBoolean) {
    pieces.push('CASE WHEN MATCH(raw_content) AGAINST (? IN BOOLEAN MODE) > 0 THEN 3 ELSE 0 END');
    params.push(parsed.fullTextBoolean);
  }

  const perTermMax = 38;
  const maxScore = parsed.searchTerms.length * perTermMax + (useFullText && parsed.fullTextBoolean ? 3 : 0);

  return {
    exprSql: pieces.join(' + '),
    params,
    maxScore: Math.max(maxScore, 1),
  };
}

function sortSql(sort, order) {
  const direction = order === 'asc' ? 'ASC' : 'DESC';

  if (sort === 'date') {
    return `ORDER BY created_at ${direction}, id DESC`;
  }

  if (sort === 'filesize') {
    return `ORDER BY COALESCE(file_size, 0) ${direction}, id DESC`;
  }

  if (sort === 'name') {
    return `ORDER BY filename ${direction}, id DESC`;
  }

  return `ORDER BY relevance_score ${direction}, created_at DESC`;
}

function makeCacheKey(parsed) {
  return JSON.stringify({
    q: parsed.q,
    requiredTerms: parsed.requiredTerms,
    optionalTerms: parsed.optionalTerms,
    excludedTerms: parsed.excludedTerms,
    searchTerms: parsed.searchTerms,
    skillFilters: parsed.skillFilters,
    titleFilters: parsed.titleFilters,
    languageFilters: parsed.languageFilters,
    educationFilters: parsed.educationFilters,
    exactExperience: parsed.exactExperience,
    minExperience: parsed.minExperience,
    maxExperience: parsed.maxExperience,
    limit: parsed.limit,
    skip: parsed.skip,
    sort: parsed.sort,
    order: parsed.order,
  });
}

function getCachedResult(cacheKey) {
  const cacheEntry = searchCache.get(cacheKey);
  if (!cacheEntry) return null;

  if (cacheEntry.expiresAt < Date.now()) {
    searchCache.delete(cacheKey);
    return null;
  }

  return cacheEntry.data;
}

function setCachedResult(cacheKey, result) {
  if (searchCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = searchCache.keys().next().value;
    if (firstKey) searchCache.delete(firstKey);
  }

  searchCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    data: result,
  });
}

function clearSearchCache() {
  searchCache.clear();
}

function recordSearchAnalytics(queryText, total, executedMs) {
  const key = normalizeTerm(queryText) || '__filters_only__';
  const entry = searchAnalytics.get(key) || {
    query: key,
    count: 0,
    totalResults: 0,
    avgMs: 0,
    lastSearchedAt: null,
  };

  entry.count += 1;
  entry.totalResults += Number(total || 0);
  entry.avgMs = Number(((entry.avgMs * (entry.count - 1) + executedMs) / entry.count).toFixed(2));
  entry.lastSearchedAt = new Date().toISOString();

  searchAnalytics.set(key, entry);
}

function getSearchAnalytics(limit = 10) {
  return [...searchAnalytics.values()]
    .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query))
    .slice(0, Math.max(1, Number(limit) || 10));
}

function mapRow(row, maxScore) {
  const relevanceScore = Number(row.relevance_score || 0);
  const relevance = Number(Math.min(1, relevanceScore / maxScore).toFixed(2));

  return {
    id: row.id,
    name: row.filename,
    relevance,
    relevanceScore,
    email: row.email,
    phone: row.phone,
    jobTitles: safeParseJsonArray(row.job_titles),
    skills: safeParseJsonArray(row.skills),
    languages: safeParseJsonArray(row.languages),
    education: row.education,
    experienceYears: row.experience_years,
    fileSize: row.file_size,
    uploadDate: row.created_at,
  };
}

async function executeSearch(parsed, useFullText) {
  const where = buildWhereClause(parsed, useFullText);
  const relevance = buildRelevanceExpr(parsed, useFullText);

  const countSql = `SELECT COUNT(*) AS total FROM cvs ${where.whereSql}`;
  const dataSql = `
    SELECT
      id,
      filename,
      email,
      phone,
      CAST(job_titles AS CHAR) AS job_titles,
      CAST(skills AS CHAR) AS skills,
      CAST(languages AS CHAR) AS languages,
      education,
      experience_years,
      file_size,
      created_at,
      (${relevance.exprSql}) AS relevance_score
    FROM cvs
    ${where.whereSql}
    ${sortSql(parsed.sort, parsed.order)}
    LIMIT ? OFFSET ?
  `;

  const countRow = await dbQueryOne(countSql, where.params);
  const total = Number(countRow?.total || 0);

  const rows = await dbQuery(dataSql, [...relevance.params, ...where.params, parsed.limit, parsed.skip]);

  const results = rows.map((row) => mapRow(row, relevance.maxScore));
  const pages = total > 0 ? Math.ceil(total / parsed.limit) : 0;

  return {
    results,
    total,
    page: parsed.page,
    pages,
    hasMore: parsed.skip + results.length < total,
    maxScore: relevance.maxScore,
  };
}

async function runAdvancedSearch(queryParams) {
  const start = performance.now();
  const parsed = parseSearchRequest(queryParams);
  const cacheKey = makeCacheKey(parsed);

  const cached = getCachedResult(cacheKey);
  if (cached) {
    return {
      ...cached,
      executedIn: '1ms',
      cache: 'hit',
    };
  }

  let payload;

  try {
    payload = await executeSearch(parsed, true);
  } catch (error) {
    if (error?.code === 'ER_FT_MATCHING_KEY_NOT_FOUND' || /FULLTEXT/i.test(error?.message || '')) {
      payload = await executeSearch(parsed, false);
    } else {
      throw error;
    }
  }

  const elapsed = Number((performance.now() - start).toFixed(2));
  const response = {
    query: parsed.q || null,
    filters: {
      skill: parsed.skillFilters,
      title: parsed.titleFilters,
      education: parsed.educationFilters,
      languages: parsed.languageFilters,
      experience: parsed.exactExperience,
      minExperience: parsed.minExperience,
      maxExperience: parsed.maxExperience,
    },
    sort: parsed.sort,
    order: parsed.order,
    limit: parsed.limit,
    skip: parsed.skip,
    results: payload.results,
    total: payload.total,
    page: payload.page,
    pages: payload.pages,
    hasMore: payload.hasMore,
    executedIn: `${elapsed}ms`,
    cache: 'miss',
  };

  setCachedResult(cacheKey, response);
  recordSearchAnalytics(parsed.q || 'filters_only', payload.total, elapsed);

  return response;
}

async function ensureSearchIndexes() {
  const ddlStatements = [
    'CREATE FULLTEXT INDEX ft_cvs_raw_content ON cvs(raw_content)',
    'CREATE INDEX idx_cvs_filename ON cvs(filename)',
    'CREATE INDEX idx_cvs_created_at ON cvs(created_at)',
    'CREATE INDEX idx_cvs_file_size ON cvs(file_size)',
    'CREATE INDEX idx_cvs_experience_years ON cvs(experience_years)',
    'CREATE INDEX idx_cvs_education ON cvs(education)',
    'CREATE INDEX idx_cvs_skills_json ON cvs((CAST(skills AS CHAR(255))))',
  ];

  for (const statement of ddlStatements) {
    try {
      // DDL is idempotent via duplicate-key handling.
      await dbQuery(statement);
    } catch (error) {
      const ignorable =
        error?.code === 'ER_DUP_KEYNAME' ||
        error?.code === 'ER_FT_MATCHING_KEY_NOT_FOUND' ||
        error?.code === 'ER_PARSE_ERROR' ||
        /Duplicate key name/i.test(error?.message || '');

      if (!ignorable) {
        throw error;
      }
    }
  }
}

module.exports = {
  runAdvancedSearch,
  clearSearchCache,
  getSearchAnalytics,
  ensureSearchIndexes,
  __private: {
    parseBooleanQuery,
    parsePagination,
    parseSearchRequest,
    canonicalizeTerm,
    expandFuzzyTerms,
  },
};
