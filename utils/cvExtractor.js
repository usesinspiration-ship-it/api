/**
 * CV Extraction Module
 *
 * Regex design notes:
 * - Email regex is intentionally strict and mirrors common RFC-compatible cases.
 * - Phone regex covers +country, parentheses, spaces, dashes and dots.
 * - URL regex supports http(s) and bare www domains.
 * - Experience regex targets explicit year-count statements first, then date-range fallback.
 *
 * Extension tips:
 * - Add skills/titles by extending `TECH_SKILLS`, `SOFT_SKILLS`, `JOB_TITLE_PATTERNS`.
 * - Add locale-specific phone/address regex in `PHONE_REGEX` and `ADDRESS_PATTERNS`.
 * - Keep canonical names stable so downstream analytics do not fragment.
 *
 * Optimization tips:
 * - Patterns are compiled once at module load.
 * - Single-pass alternation regex for skill/language scanning.
 * - No heavy NLP dependencies: pure regex + heuristics for speed and low memory.
 */

const EMAIL_REGEX = /[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;
const URL_REGEX = /(?:https?:\/\/|www\.)[\w.-]+(?:\.[\w.-]+)+(?:[/?#][^\s]*)?/gi;

const EXPERIENCE_REGEX = /(?:over\s+|more\s+than\s+)?(\d{1,2})(\+)?\s*(?:years?|yrs?)\s*(?:of\s+)?experience/gi;
const EXPERIENCE_SHORT_REGEX = /(\d{1,2})(\+)?\s*(?:years?|yrs?)\b/gi;
const DATE_RANGE_REGEX = /((?:19|20)\d{2})\s*(?:-|–|—|to)\s*(present|current|now|((?:19|20)\d{2}))/gi;
const GRAD_YEAR_REGEX = /(?:graduated|graduation|class\s+of)?\s*(19|20)\d{2}/gi;

const ADDRESS_PATTERNS = [
  /\b\d{1,6}\s+[A-Za-z0-9.'\-\s]+\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Circle|Cir)\b[^\n]*/i,
  /\bP\.?\s*O\.?\s*Box\s+\d+\b[^\n]*/i,
];

const JOB_TITLE_PATTERNS = [
  ['Software Engineer', /\b(?:senior|sr\.?|lead|principal)?\s*software engineer\b/gi],
  ['Developer', /\b(?:senior|sr\.?|lead|principal|full[-\s]?stack|frontend|front[-\s]?end|backend|back[-\s]?end)?\s*developer\b/gi],
  ['Programmer', /\bprogrammer\b/gi],
  ['Product Manager', /\b(?:senior|sr\.?|lead)?\s*product manager\b/gi],
  ['Program Manager', /\b(?:senior|sr\.?|lead)?\s*program manager\b/gi],
  ['Data Scientist', /\b(?:senior|sr\.?|lead)?\s*data scientist\b/gi],
  ['Data Analyst', /\b(?:senior|sr\.?|lead)?\s*data analyst\b/gi],
  ['Designer', /\b(?:graphic\s+)?designer\b/gi],
  ['UI/UX Designer', /\b(?:ui\s*\/\s*ux|ux\s*\/\s*ui|ui|ux)\s*designer\b/gi],
  ['HR Manager', /\b(?:senior|sr\.?|lead)?\s*hr manager\b/gi],
  ['HR Specialist', /\bhr specialist\b/gi],
  ['Sales Manager', /\b(?:senior|sr\.?|lead)?\s*sales manager\b/gi],
  ['Account Manager', /\b(?:senior|sr\.?|lead)?\s*account manager\b/gi],
  ['Video Editor', /\bvideo editor\b/gi],
  ['Motion Graphics', /\bmotion graphics?\b/gi],
  ['Manager', /\b(?:senior|sr\.?|lead)?\s*manager\b/gi],
  ['Senior Manager', /\b(?:senior|sr\.?)\s*manager\b/gi],
  ['Lead', /\blead\s+(?:engineer|developer|designer|consultant|architect)?\b/gi],
  ['Consultant', /\b(?:senior|sr\.?|principal)?\s*consultant\b/gi],
  ['Architect', /\b(?:solutions?\s+|software\s+|cloud\s+)?architect\b/gi],
  ['DevOps Engineer', /\b(?:senior|sr\.?|lead)?\s*devops engineer\b/gi],
  ['Systems Engineer', /\b(?:senior|sr\.?|lead)?\s*systems engineer\b/gi],
];

const TECH_SKILLS = [
  ['Python', /\bpython\b|\bpythn\b/gi],
  ['Java', /\bjava\b/gi],
  ['JavaScript', /\bjavascript\b|\bjs\b|\bjavascritp\b/gi],
  ['C++', /\bc\+\+\b/gi],
  ['Go', /\bgo\b|\bgolang\b/gi],
  ['Ruby', /\bruby\b/gi],
  ['PHP', /\bphp\b/gi],
  ['React', /\breact(?:\.js)?\b/gi],
  ['Vue', /\bvue(?:\.js)?\b/gi],
  ['Angular', /\bangular\b/gi],
  ['Node.js', /\bnode(?:\.js)?\b/gi],
  ['Express', /\bexpress(?:\.js)?\b/gi],
  ['Django', /\bdjango\b/gi],
  ['SQL', /\bsql\b/gi],
  ['MongoDB', /\bmongo(?:db)?\b/gi],
  ['PostgreSQL', /\bpostgres(?:ql)?\b/gi],
  ['MySQL', /\bmysql\b/gi],
  ['Docker', /\bdocker\b/gi],
  ['Kubernetes', /\bkubernetes\b|\bk8s\b/gi],
  ['AWS', /\baws\b|\bamazon web services\b/gi],
  ['Azure', /\bazure\b/gi],
  ['GCP', /\bgcp\b|\bgoogle cloud\b/gi],
  ['Git', /\bgit\b|\bgithub\b|\bgitlab\b/gi],
  ['REST API', /\brest(?:ful)?\s*api\b/gi],
  ['GraphQL', /\bgraphql\b/gi],
  ['Linux', /\blinux\b/gi],
];

const SOFT_SKILLS = [
  ['Leadership', /\bleadership\b/gi],
  ['Communication', /\bcommunication\b/gi],
  ['Problem-solving', /\bproblem[-\s]?solving\b|\bproblem solving\b/gi],
  ['Project Management', /\bproject management\b/gi],
  ['Team Management', /\bteam management\b/gi],
  ['Analytical Thinking', /\banalytical thinking\b/gi],
  ['Creativity', /\bcreativity\b/gi],
  ['Time Management', /\btime management\b/gi],
  ['Adaptability', /\badaptability\b/gi],
];

const LANGUAGE_PATTERNS = [
  ['English', /\benglish\b/gi],
  ['Spanish', /\bspanish\b|\bespanol\b/gi],
  ['French', /\bfrench\b/gi],
  ['German', /\bgerman\b|\bdeutsch\b/gi],
  ['Mandarin', /\bmandarin\b|\bchinese\b/gi],
  ['Japanese', /\bjapanese\b/gi],
  ['Korean', /\bkorean\b/gi],
  ['Hindi', /\bhindi\b/gi],
  ['Arabic', /\barabic\b/gi],
  ['Portuguese', /\bportuguese\b/gi],
  ['Russian', /\brussian\b/gi],
  ['Italian', /\bitalian\b/gi],
  ['Dutch', /\bdutch\b/gi],
  ['Swedish', /\bswedish\b/gi],
  ['Polish', /\bpolish\b/gi],
  ['Turkish', /\bturkish\b/gi],
];

const EDUCATION_LEVELS = [
  ['PhD / Doctorate', /\b(ph\.?d|doctorate|doctoral)\b/i],
  ["Master's", /\b(master'?s|m\.?sc|ms\b|mba|m\.tech|ma\b)\b/i],
  ["Bachelor's", /\b(bachelor'?s|b\.?sc|bsc\b|bs\b|be\b|b\.tech|ba\b)\b/i],
  ['Diploma', /\bdiploma\b/i],
  ['Associate', /\bassociate(?:\s+degree)?\b/i],
  ['High School / Secondary', /\b(high school|secondary school|senior secondary|higher secondary)\b/i],
];

const CERTIFICATION_PATTERNS = [
  /aws certified[^\n,.]*/gi,
  /google(?: cloud)? certified[^\n,.]*/gi,
  /microsoft certified[^\n,.]*/gi,
  /certified kubernetes[^\n,.]*/gi,
  /pmp\b[^\n,.]*/gi,
  /scrum master[^\n,.]*/gi,
];

const AWARD_PATTERN = /\b(award(?:ed)?|recognition|honou?r|winner|finalist)\b[^\n]*/gi;
const PUBLICATION_PATTERN = /\b(publication|published|journal|conference paper|research paper|thesis)\b[^\n]*/gi;
const GITHUB_PATTERN = /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+(?:\/[\w.-]+)?/gi;

const PROFICIENCY_PATTERN = /(fluent|native|intermediate|basic|professional working proficiency|limited working proficiency)/i;
const MAX_SCAN_CHARS = 3_000_000;

function uniqueNormalized(values) {
  const seen = new Set();
  const out = [];

  for (const value of values) {
    if (!value) continue;
    const clean = String(value).replace(/\s+/g, ' ').trim();
    if (!clean) continue;

    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }

  return out;
}

function normalizeTitle(raw) {
  if (!raw) return raw;

  return raw
    .replace(/\bsr\.?\b/gi, 'Senior')
    .replace(/\bjr\.?\b/gi, 'Junior')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function confidenceByCount(count, maxCount, floor = 0.5, ceiling = 0.99) {
  if (count <= 0) return 0;
  const ratio = Math.min(1, count / Math.max(1, maxCount));
  return Number((floor + ratio * (ceiling - floor)).toFixed(2));
}

function pickBestPhone(phones) {
  if (phones.length === 0) return null;

  const scored = phones.map((p) => {
    const digits = p.replace(/\D/g, '').length;
    let score = digits;
    if (/\+\d/.test(p)) score += 2;
    if (/\(\d+\)/.test(p)) score += 1;
    return { value: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].value;
}

function extractWithRegex(text, regex) {
  const matches = [];
  let match;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[0]);
  }
  return matches;
}

function countPatternHits(text, pattern) {
  const hits = extractWithRegex(text, pattern);
  return hits.length;
}

function detectSkills(text) {
  const skills = [];
  let hitCount = 0;

  for (const [name, pattern] of TECH_SKILLS) {
    const hits = countPatternHits(text, pattern);
    if (hits > 0) {
      skills.push(name);
      hitCount += hits;
    }
  }

  for (const [name, pattern] of SOFT_SKILLS) {
    const hits = countPatternHits(text, pattern);
    if (hits > 0) {
      skills.push(name);
      hitCount += hits;
    }
  }

  return {
    values: uniqueNormalized(skills),
    hitCount,
  };
}

function detectJobTitles(text) {
  const tally = [];

  for (const [canonical, pattern] of JOB_TITLE_PATTERNS) {
    const hits = countPatternHits(text, pattern);
    if (hits > 0) {
      tally.push({ title: canonical, hits });
    }
  }

  tally.sort((a, b) => b.hits - a.hits || a.title.localeCompare(b.title));

  const top = tally.slice(0, 5).map((t) => normalizeTitle(t.title));

  return {
    values: top,
    hitCount: tally.reduce((sum, t) => sum + t.hits, 0),
  };
}

function detectExperience(text) {
  let maxYears = 0;
  let explicitSignal = false;

  EXPERIENCE_REGEX.lastIndex = 0;
  let m;
  while ((m = EXPERIENCE_REGEX.exec(text)) !== null) {
    explicitSignal = true;
    const years = Number(m[1]);
    if (years > maxYears) maxYears = years;
  }

  EXPERIENCE_SHORT_REGEX.lastIndex = 0;
  while ((m = EXPERIENCE_SHORT_REGEX.exec(text)) !== null) {
    const years = Number(m[1]);
    if (years >= 2 && years > maxYears) {
      maxYears = years;
      explicitSignal = true;
    }
  }

  if (!explicitSignal) {
    let earliest = Number.POSITIVE_INFINITY;
    let latest = 0;

    DATE_RANGE_REGEX.lastIndex = 0;
    while ((m = DATE_RANGE_REGEX.exec(text)) !== null) {
      const start = Number(m[1]);
      const end = m[2] && /present|current|now/i.test(m[2]) ? new Date().getFullYear() : Number(m[2]);
      if (start >= 1900 && start <= 2100) earliest = Math.min(earliest, start);
      if (end >= 1900 && end <= 2100) latest = Math.max(latest, end);
    }

    if (earliest !== Number.POSITIVE_INFINITY && latest >= earliest) {
      maxYears = Math.max(maxYears, latest - earliest);
    }
  }

  if (!maxYears) {
    return { value: null, confidence: 0 };
  }

  return {
    value: `${maxYears}+ years`,
    confidence: explicitSignal ? 0.9 : 0.72,
  };
}

function detectEducation(text) {
  const lines = text.split(/\r?\n/).slice(0, 8000);

  let bestLevel = null;
  let bestRank = -1;

  for (let i = 0; i < EDUCATION_LEVELS.length; i += 1) {
    const [label, pattern] = EDUCATION_LEVELS[i];
    if (pattern.test(text)) {
      bestLevel = label;
      bestRank = EDUCATION_LEVELS.length - i;
      break;
    }
  }

  const schoolLine = lines.find((line) =>
    /university|college|institute|school|polytechnic|academy|universidad|ecole|instituto/i.test(line)
  );

  const fieldMatch = text.match(
    /\b(?:in|of)\s+(computer science|information technology|software engineering|data science|business administration|electrical engineering|mechanical engineering|design|marketing|finance|human resources)\b/i
  );

  GRAD_YEAR_REGEX.lastIndex = 0;
  let year;
  let m;
  while ((m = GRAD_YEAR_REGEX.exec(text)) !== null) {
    const y = Number(m[0].match(/(19|20)\d{2}/)?.[0]);
    if (y >= 1950 && y <= new Date().getFullYear() + 2) {
      year = y;
    }
  }

  const pieces = [];
  if (bestLevel) pieces.push(bestLevel);
  if (fieldMatch?.[1]) pieces.push(`in ${fieldMatch[1].replace(/\b\w/g, (c) => c.toUpperCase())}`);
  if (schoolLine) pieces.push(`- ${schoolLine.replace(/\s+/g, ' ').trim()}`);
  if (year) pieces.push(`(${year})`);

  return {
    value: pieces.length > 0 ? pieces.join(' ') : null,
    level: bestLevel,
    institution: schoolLine ? schoolLine.replace(/\s+/g, ' ').trim() : null,
    fieldOfStudy: fieldMatch?.[1] ? fieldMatch[1].replace(/\b\w/g, (c) => c.toUpperCase()) : null,
    graduationYear: year || null,
    confidence: bestRank > -1 ? 0.84 : 0,
  };
}

function detectLanguages(text) {
  const found = [];
  const proficiency = {};
  let hitCount = 0;

  const lines = text.split(/\r?\n/).slice(0, 8000);

  for (const [name, pattern] of LANGUAGE_PATTERNS) {
    const hits = countPatternHits(text, pattern);
    if (hits > 0) {
      found.push(name);
      hitCount += hits;

      const lineMatcher = new RegExp(pattern.source, 'i');
      const relatedLine = lines.find((line) => lineMatcher.test(line));
      if (relatedLine) {
        const prof = relatedLine.match(PROFICIENCY_PATTERN)?.[1];
        if (prof) proficiency[name] = prof.toLowerCase();
      }
    }
  }

  return {
    values: uniqueNormalized(found),
    proficiency,
    hitCount,
  };
}

function detectCertifications(text) {
  const certs = [];

  for (const pattern of CERTIFICATION_PATTERNS) {
    certs.push(...extractWithRegex(text, pattern));
  }

  return uniqueNormalized(
    certs.map((c) => c.replace(/\s+/g, ' ').replace(/[.,;:]+$/g, '').trim())
  );
}

function detectAdditionalInfo(text) {
  const awards = uniqueNormalized(
    extractWithRegex(text, AWARD_PATTERN).map((v) => v.replace(/\s+/g, ' ').trim())
  ).slice(0, 8);

  const publications = uniqueNormalized(
    extractWithRegex(text, PUBLICATION_PATTERN).map((v) => v.replace(/\s+/g, ' ').trim())
  ).slice(0, 8);

  const githubLinks = uniqueNormalized(extractWithRegex(text, GITHUB_PATTERN));

  return {
    awards,
    publications,
    githubLinks,
  };
}

function detectAddress(text) {
  for (const pattern of ADDRESS_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0]) {
      return match[0].replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

function safeText(rawContent) {
  if (typeof rawContent !== 'string') return '';
  if (!rawContent) return '';

  return rawContent
    .replace(/\u0000/g, ' ')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+$/gm, '')
    .trim();
}

function buildSearchText(text) {
  if (text.length <= MAX_SCAN_CHARS) {
    return text;
  }

  // Performance path for very large CV payloads: scan representative windows.
  const windowSize = Math.floor(MAX_SCAN_CHARS / 3);
  const head = text.slice(0, windowSize);
  const midStart = Math.max(0, Math.floor(text.length / 2) - Math.floor(windowSize / 2));
  const middle = text.slice(midStart, midStart + windowSize);
  const tail = text.slice(-windowSize);
  return `${head}\n${middle}\n${tail}`;
}

/**
 * Extracts structured CV fields from raw CV text.
 *
 * @param {string} rawContent
 * @returns {Promise<object>}
 */
async function extractCVFields(rawContent) {
  const text = safeText(rawContent);
  const searchText = buildSearchText(text);

  if (!searchText) {
    return {
      email: null,
      phone: null,
      linkedIn: null,
      websites: [],
      address: null,
      jobTitles: [],
      skills: [],
      experience: null,
      education: null,
      educationDetails: {
        level: null,
        institution: null,
        fieldOfStudy: null,
        graduationYear: null,
      },
      languages: [],
      languageProficiency: {},
      certifications: [],
      awards: [],
      publications: [],
      github: [],
      confidence: {
        email: 0,
        phone: 0,
        jobTitles: 0,
        skills: 0,
        experience: 0,
        education: 0,
        languages: 0,
        certifications: 0,
      },
      scored: {
        email: { value: null, confidence: 0 },
        phone: { value: null, confidence: 0 },
        jobTitles: { value: [], confidence: 0 },
        skills: { value: [], confidence: 0 },
        experience: { value: null, confidence: 0 },
        education: { value: null, confidence: 0 },
        languages: { value: [], confidence: 0 },
      },
    };
  }

  const emails = uniqueNormalized(extractWithRegex(searchText, EMAIL_REGEX).map((v) => v.toLowerCase()));
  const phones = uniqueNormalized(
    extractWithRegex(searchText, PHONE_REGEX)
      .map((v) => v.replace(/\s+/g, ' ').trim())
      .filter((v) => v.replace(/\D/g, '').length >= 7)
  );

  const urls = uniqueNormalized(extractWithRegex(searchText, URL_REGEX).map((u) => (u.startsWith('http') ? u : `https://${u}`)));
  const linkedIn = urls.find((u) => /linkedin\.com/i.test(u)) || null;
  const websiteLinks = urls.filter((u) => !/linkedin\.com|github\.com/i.test(u));

  const address = detectAddress(searchText);
  const jobTitleResult = detectJobTitles(searchText);
  const skillResult = detectSkills(searchText);
  const experienceResult = detectExperience(searchText);
  const educationResult = detectEducation(searchText);
  const languageResult = detectLanguages(searchText);
  const certifications = detectCertifications(searchText);
  const additional = detectAdditionalInfo(searchText);

  const response = {
    email: emails[0] || null,
    phone: pickBestPhone(phones),
    linkedIn,
    websites: websiteLinks.slice(0, 5),
    address,
    jobTitles: jobTitleResult.values.slice(0, 5),
    skills: skillResult.values,
    experience: experienceResult.value,
    education: educationResult.value,
    educationDetails: {
      level: educationResult.level,
      institution: educationResult.institution,
      fieldOfStudy: educationResult.fieldOfStudy,
      graduationYear: educationResult.graduationYear,
    },
    languages: languageResult.values,
    languageProficiency: languageResult.proficiency,
    certifications,
    awards: additional.awards,
    publications: additional.publications,
    github: additional.githubLinks,
    confidence: {
      email: emails.length > 0 ? confidenceByCount(emails.length, 2, 0.9, 0.99) : 0,
      phone: phones.length > 0 ? confidenceByCount(phones.length, 2, 0.78, 0.95) : 0,
      jobTitles: confidenceByCount(jobTitleResult.hitCount, 8, 0.62, 0.9),
      skills: confidenceByCount(skillResult.hitCount, 14, 0.65, 0.94),
      experience: experienceResult.confidence,
      education: educationResult.confidence,
      languages: confidenceByCount(languageResult.hitCount, 5, 0.62, 0.86),
      certifications: confidenceByCount(certifications.length, 3, 0.66, 0.9),
    },
  };

  response.scored = {
    email: { value: response.email, confidence: response.confidence.email },
    phone: { value: response.phone, confidence: response.confidence.phone },
    jobTitles: { value: response.jobTitles, confidence: response.confidence.jobTitles },
    skills: { value: response.skills, confidence: response.confidence.skills },
    experience: { value: response.experience, confidence: response.confidence.experience },
    education: { value: response.education, confidence: response.confidence.education },
    languages: { value: response.languages, confidence: response.confidence.languages },
  };

  return response;
}

module.exports = {
  extractCVFields,
};
