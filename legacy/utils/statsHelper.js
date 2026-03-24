const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = Number(process.env.STATS_CACHE_TTL_MS || 60 * 60 * 1000);

const statsCache = new Map();
let dbModule = null;

function getDb() {
  if (!dbModule) {
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

function createError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details) err.details = details;
  return err;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);

  if (value >= 1024 ** 3) {
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  }

  if (value >= 1024 ** 2) {
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }

  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${value} B`;
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

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function titleCase(value) {
  return normalizeText(value).replace(/\b\w/g, (char) => char.toUpperCase());
}

function percent(value, total) {
  if (!total) return 0;
  return Number(((value / total) * 100).toFixed(1));
}

function round1(value) {
  return Number(Number(value || 0).toFixed(1));
}

function toRankedList(counterMap, keyName, limit = 20) {
  return [...counterMap.entries()]
    .map(([name, count]) => ({ [keyName]: name, count }))
    .sort((a, b) => b.count - a.count || a[keyName].localeCompare(b[keyName]))
    .slice(0, limit);
}

function getCache(key) {
  const item = statsCache.get(key);
  if (!item) return null;

  if (item.expiresAt <= Date.now()) {
    statsCache.delete(key);
    return null;
  }

  return item.data;
}

function setCache(key, data) {
  statsCache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function withCacheKey(prefix, queryParams) {
  return `${prefix}:${JSON.stringify(queryParams || {})}`;
}

function invalidateStatsCache() {
  statsCache.clear();
}

async function withCache(prefix, queryParams, calcFn) {
  const cacheKey = withCacheKey(prefix, queryParams);
  const cached = getCache(cacheKey);
  if (cached) {
    return { ...cached, cache: 'hit' };
  }

  const data = await calcFn();
  setCache(cacheKey, data);
  return { ...data, cache: 'miss' };
}

function classifyEducation(raw) {
  const text = normalizeKey(raw);
  if (!text) return 'Unknown';

  if (/\b(ph\.?d|doctorate|doctoral)\b/.test(text)) return 'PhD';
  if (/\b(master|m\.?sc|mba|m\.tech|ms\b|ma\b)\b/.test(text)) return 'Master';
  if (/\b(bachelor|b\.?sc|bsc\b|b\.tech|bs\b|be\b|ba\b)\b/.test(text)) return 'Bachelor';
  if (/\bdiploma\b/.test(text)) return 'Diploma';
  if (/\bassociate\b/.test(text)) return 'Associate';
  if (/\b(high school|secondary|higher secondary)\b/.test(text)) return 'High School';

  return 'Other';
}

function buildTrendBuckets(rows, days) {
  const now = new Date();
  const map = new Map(rows.map((row) => [String(row.day), Number(row.count || 0)]));
  const labels = [];
  const data = [];

  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const label = d.toISOString().slice(0, 10);
    labels.push(label);
    data.push(map.get(label) || 0);
  }

  return { labels, data };
}

async function getOverallStats() {
  return withCache('overall', {}, async () => {
    const summary = await dbQueryOne(
      `
      SELECT
        COUNT(*) AS totalCVs,
        COALESCE(SUM(file_size), 0) AS totalBytes,
        COALESCE(AVG(file_size), 0) AS avgBytes,
        MAX(created_at) AS lastUpload
      FROM cvs
      `
    );

    const trend = await dbQueryOne(
      `
      SELECT
        SUM(CASE WHEN created_at >= UTC_DATE() THEN 1 ELSE 0 END) AS today,
        SUM(CASE WHEN created_at >= DATE_SUB(UTC_DATE(), INTERVAL WEEKDAY(UTC_DATE()) DAY) THEN 1 ELSE 0 END) AS thisWeek,
        SUM(CASE WHEN created_at >= DATE_FORMAT(UTC_DATE(), '%Y-%m-01') THEN 1 ELSE 0 END) AS thisMonth
      FROM cvs
      `
    );

    const dailyRows = await dbQuery(
      `
      SELECT DATE(created_at) AS day, COUNT(*) AS count
      FROM cvs
      WHERE created_at >= DATE_SUB(UTC_DATE(), INTERVAL 6 DAY)
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at)
      `
    );

    const trendChart = buildTrendBuckets(dailyRows, 7);

    return {
      totalCVs: Number(summary?.totalCVs || 0),
      totalSize: formatBytes(summary?.totalBytes || 0),
      averageFileSize: formatBytes(summary?.avgBytes || 0),
      lastUpload: summary?.lastUpload || null,
      uploadTrend: {
        today: Number(trend?.today || 0),
        thisWeek: Number(trend?.thisWeek || 0),
        thisMonth: Number(trend?.thisMonth || 0),
      },
      uploadTrendChart: {
        labels: trendChart.labels,
        data: trendChart.data,
        type: 'line',
      },
    };
  });
}

async function getSkillStats() {
  return withCache('skills', {}, async () => {
    const totalCVsRow = await dbQueryOne('SELECT COUNT(*) AS totalCVs FROM cvs');
    const totalCVs = Number(totalCVsRow?.totalCVs || 0);

    const rows = await dbQuery('SELECT CAST(skills AS CHAR) AS skills, created_at FROM cvs WHERE skills IS NOT NULL');

    const counter = new Map();
    const recentCounter = new Map();
    const previousCounter = new Map();
    const now = Date.now();
    const recentStart = now - 30 * DAY_MS;
    const previousStart = now - 60 * DAY_MS;

    for (const row of rows) {
      const createdAtMs = row.created_at ? new Date(row.created_at).getTime() : 0;
      const seenInCv = new Set();
      const skills = safeParseJsonArray(row.skills);

      for (const skillRaw of skills) {
        const skill = titleCase(skillRaw);
        const key = normalizeKey(skill);
        if (!key || seenInCv.has(key)) continue;
        seenInCv.add(key);

        counter.set(skill, (counter.get(skill) || 0) + 1);

        if (createdAtMs >= recentStart) {
          recentCounter.set(skill, (recentCounter.get(skill) || 0) + 1);
        } else if (createdAtMs >= previousStart) {
          previousCounter.set(skill, (previousCounter.get(skill) || 0) + 1);
        }
      }
    }

    const topSkills = toRankedList(counter, 'skill', 20).map((item) => ({
      skill: item.skill,
      count: item.count,
      percentage: percent(item.count, totalCVs),
    }));

    const trendingSkills = [...recentCounter.entries()]
      .map(([skill, recentCount]) => {
        const prevCount = previousCounter.get(skill) || 0;
        const growth = prevCount === 0 ? recentCount * 100 : Math.round(((recentCount - prevCount) / prevCount) * 100);
        return { skill, growth, recentCount };
      })
      .filter((item) => item.growth > 0 && item.recentCount > 0)
      .sort((a, b) => b.growth - a.growth || a.skill.localeCompare(b.skill))
      .slice(0, 10)
      .map(({ skill, growth }) => ({ skill, growth }));

    return {
      totalSkills: [...counter.values()].reduce((sum, count) => sum + count, 0),
      topSkills,
      trendingSkills,
      skillsChart: {
        labels: topSkills.slice(0, 10).map((s) => s.skill),
        data: topSkills.slice(0, 10).map((s) => s.count),
        type: 'bar',
      },
    };
  });
}

async function getJobTitleStats() {
  return withCache('jobTitles', {}, async () => {
    const rows = await dbQuery('SELECT CAST(job_titles AS CHAR) AS job_titles FROM cvs WHERE job_titles IS NOT NULL');

    const counter = new Map();
    for (const row of rows) {
      const seenInCv = new Set();
      const titles = safeParseJsonArray(row.job_titles);
      for (const titleRaw of titles) {
        const title = titleCase(titleRaw);
        const key = normalizeKey(title);
        if (!key || seenInCv.has(key)) continue;
        seenInCv.add(key);
        counter.set(title, (counter.get(title) || 0) + 1);
      }
    }

    const topTitles = toRankedList(counter, 'title', 20);

    return {
      totalTitles: counter.size,
      topTitles,
      jobTitlesChart: {
        labels: topTitles.slice(0, 10).map((t) => t.title),
        data: topTitles.slice(0, 10).map((t) => t.count),
        type: 'bar',
      },
    };
  });
}

async function getExperienceStats() {
  return withCache('experience', {}, async () => {
    const row = await dbQueryOne(
      `
      SELECT
        SUM(CASE WHEN experience_years >= 0 AND experience_years < 2 THEN 1 ELSE 0 END) AS bucket_0_2,
        SUM(CASE WHEN experience_years >= 2 AND experience_years < 5 THEN 1 ELSE 0 END) AS bucket_2_5,
        SUM(CASE WHEN experience_years >= 5 AND experience_years < 10 THEN 1 ELSE 0 END) AS bucket_5_10,
        SUM(CASE WHEN experience_years >= 10 THEN 1 ELSE 0 END) AS bucket_10_plus,
        AVG(CASE WHEN experience_years IS NOT NULL THEN experience_years END) AS average
      FROM cvs
      `
    );

    const distribution = {
      '0-2 years': Number(row?.bucket_0_2 || 0),
      '2-5 years': Number(row?.bucket_2_5 || 0),
      '5-10 years': Number(row?.bucket_5_10 || 0),
      '10+ years': Number(row?.bucket_10_plus || 0),
    };

    return {
      distribution,
      average: round1(row?.average || 0),
      experienceChart: {
        labels: ['0-2yr', '2-5yr', '5-10yr', '10+yr'],
        data: [distribution['0-2 years'], distribution['2-5 years'], distribution['5-10 years'], distribution['10+ years']],
        type: 'pie',
      },
    };
  });
}

async function getEducationStats() {
  return withCache('education', {}, async () => {
    const rows = await dbQuery('SELECT education FROM cvs WHERE education IS NOT NULL AND education <> ""');

    const distribution = {
      PhD: 0,
      Master: 0,
      Bachelor: 0,
      Diploma: 0,
      Associate: 0,
      'High School': 0,
      Other: 0,
    };

    for (const row of rows) {
      const category = classifyEducation(row.education);
      distribution[category] = (distribution[category] || 0) + 1;
    }

    return {
      distribution,
      educationChart: {
        labels: Object.keys(distribution),
        data: Object.values(distribution),
        type: 'pie',
      },
    };
  });
}

async function getLanguageStats() {
  return withCache('languages', {}, async () => {
    const rows = await dbQuery('SELECT CAST(languages AS CHAR) AS languages FROM cvs WHERE languages IS NOT NULL');

    const counter = new Map();

    for (const row of rows) {
      const seenInCv = new Set();
      const languages = safeParseJsonArray(row.languages);

      for (const langRaw of languages) {
        const language = titleCase(langRaw);
        const key = normalizeKey(language);
        if (!key || seenInCv.has(key)) continue;
        seenInCv.add(key);
        counter.set(language, (counter.get(language) || 0) + 1);
      }
    }

    const topLanguages = toRankedList(counter, 'language', 20);

    return {
      topLanguages,
      languagesChart: {
        labels: topLanguages.slice(0, 10).map((l) => l.language),
        data: topLanguages.slice(0, 10).map((l) => l.count),
        type: 'bar',
      },
    };
  });
}

function normalizeDateInput(value, fieldName) {
  if (!value) return null;
  const normalized = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw createError(400, 'Bad Request', `${fieldName} must be in YYYY-MM-DD format`);
  }

  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw createError(400, 'Bad Request', `${fieldName} is not a valid date`);
  }

  return date;
}

async function getUploadAnalytics(queryParams) {
  const fromDate = normalizeDateInput(queryParams.from, 'from') || new Date(Date.now() - 364 * DAY_MS);
  const toDate = normalizeDateInput(queryParams.to, 'to') || new Date();

  if (fromDate.getTime() > toDate.getTime()) {
    throw createError(400, 'Bad Request', 'from date cannot be after to date');
  }

  const granularity = String(queryParams.granularity || 'day').toLowerCase();
  if (!['day', 'week', 'month'].includes(granularity)) {
    throw createError(400, 'Bad Request', 'granularity must be one of: day, week, month');
  }

  return withCache('uploads', {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
    granularity,
  }, async () => {
    let bucketExpr = 'DATE(created_at)';
    if (granularity === 'week') {
      bucketExpr = "DATE_FORMAT(created_at, '%x-W%v')";
    } else if (granularity === 'month') {
      bucketExpr = "DATE_FORMAT(created_at, '%Y-%m')";
    }

    const rows = await dbQuery(
      `
      SELECT
        ${bucketExpr} AS bucket,
        COUNT(*) AS count,
        COALESCE(SUM(file_size), 0) AS totalBytes
      FROM cvs
      WHERE created_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)
      GROUP BY bucket
      ORDER BY bucket
      `,
      [fromDate.toISOString().slice(0, 10), toDate.toISOString().slice(0, 10)]
    );

    const uploads = rows.map((row) => ({
      date: String(row.bucket),
      count: Number(row.count || 0),
      totalSize: formatBytes(row.totalBytes || 0),
    }));

    return {
      uploads,
      chart: {
        labels: uploads.map((item) => item.date),
        data: uploads.map((item) => item.count),
        type: 'line',
      },
      granularity,
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
    };
  });
}

async function getUserStats() {
  return withCache('users', {}, async () => {
    const row = await dbQueryOne(
      `
      SELECT
        COUNT(*) AS totalUsers,
        SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS adminCount,
        SUM(CASE WHEN role = 'hr' THEN 1 ELSE 0 END) AS hrCount,
        SUM(CASE WHEN role = 'recruiter' THEN 1 ELSE 0 END) AS recruiterCount,
        SUM(CASE WHEN role = 'viewer' THEN 1 ELSE 0 END) AS viewerCount,
        SUM(CASE WHEN last_login_at >= UTC_DATE() THEN 1 ELSE 0 END) AS activeToday,
        SUM(CASE WHEN last_login_at >= DATE_SUB(UTC_DATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS activeThisWeek
      FROM users
      `
    );

    return {
      totalUsers: Number(row?.totalUsers || 0),
      byRole: {
        admin: Number(row?.adminCount || 0),
        hr: Number(row?.hrCount || 0),
        recruiter: Number(row?.recruiterCount || 0),
        viewer: Number(row?.viewerCount || 0),
      },
      activeToday: Number(row?.activeToday || 0),
      activeThisWeek: Number(row?.activeThisWeek || 0),
    };
  });
}

async function ensureStatsIndexes() {
  const statements = [
    'CREATE INDEX idx_cvs_created_at ON cvs(created_at)',
    'CREATE INDEX idx_cvs_file_size ON cvs(file_size)',
    'CREATE INDEX idx_cvs_experience_years ON cvs(experience_years)',
    'CREATE INDEX idx_users_role ON users(role)',
    'CREATE INDEX idx_users_last_login_at ON users(last_login_at)',
  ];

  for (const sql of statements) {
    try {
      await dbQuery(sql);
    } catch (error) {
      const ignorable = error?.code === 'ER_DUP_KEYNAME' || /Duplicate key name/i.test(error?.message || '');
      if (!ignorable) {
        throw error;
      }
    }
  }
}

module.exports = {
  getOverallStats,
  getSkillStats,
  getJobTitleStats,
  getExperienceStats,
  getEducationStats,
  getLanguageStats,
  getUploadAnalytics,
  getUserStats,
  invalidateStatsCache,
  ensureStatsIndexes,
  __private: {
    formatBytes,
    classifyEducation,
    safeParseJsonArray,
    buildTrendBuckets,
  },
};
