const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { extractCVFields } = require('./cvExtractor');

const MAX_FILE_SIZE_BYTES = Number(process.env.UPLOAD_MAX_MB || 50) * 1024 * 1024;
const MIN_FILE_SIZE_BYTES = Number(process.env.UPLOAD_MIN_KB || 1) * 1024;
const UPLOAD_PROCESS_TIMEOUT_MS = Number(process.env.UPLOAD_PROCESS_TIMEOUT_MS || 30000);

const ALLOWED_EXTENSIONS = new Set(['.txt', '.pdf', '.doc', '.docx']);

const ALLOWED_MIME_BY_EXTENSION = {
  '.txt': ['text/plain', 'application/octet-stream'],
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword', 'application/octet-stream'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream',
  ],
};

const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.msi',
  '.bat',
  '.cmd',
  '.com',
  '.sh',
  '.dmg',
  '.apk',
  '.jar',
  '.dll',
  '.scr',
]);

function createUploadError(status, reason, message = 'File validation failed') {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  err.isUploadError = true;
  return err;
}

function extensionOf(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function isHiddenFile(filename) {
  return path.basename(String(filename || '')).startsWith('.');
}

function sanitizeFilename(filename) {
  const base = path.basename(String(filename || '')).replace(/[\u0000-\u001F\u007F]/g, '');
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_{2,}/g, '_').trim();
  if (!safe) {
    return `upload_${Date.now()}.txt`;
  }
  return safe.slice(0, 200);
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function detectTextEncoding(buffer) {
  if (!buffer || buffer.length === 0) return 'utf8';

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf8-bom';
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return 'utf16le';
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return 'utf16be';
  }

  return 'utf8';
}

function decodeTextBuffer(buffer, encoding) {
  const iconv = () => loadOptionalDependency('iconv-lite');

  if (encoding === 'utf8-bom') {
    return buffer.toString('utf8').replace(/^\uFEFF/, '');
  }

  if (encoding === 'utf16be') {
    return iconv().decode(buffer, 'utf16-be');
  }

  if (encoding === 'utf16le') {
    return iconv().decode(buffer, 'utf16le');
  }

  return buffer.toString('utf8');
}

function cleanExtractedText(text) {
  return String(text || '')
    .replace(/\u0000/g, ' ')
    .replace(/[\t\r\f\v]+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\x00-\x08\x0E-\x1F]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
}

function isProbablyCVContent(text) {
  if (!text || text.length < 120) {
    return false;
  }

  const lower = text.toLowerCase();

  const cvKeywords = [
    'resume',
    'curriculum vitae',
    'experience',
    'work history',
    'employment',
    'education',
    'skills',
    'profile',
    'summary',
    'projects',
    'certifications',
  ];

  const keywordHits = cvKeywords.reduce((count, keyword) => (lower.includes(keyword) ? count + 1 : count), 0);
  const hasEmail = /[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text);
  const hasPhone = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/.test(text);

  return keywordHits >= 2 || (keywordHits >= 1 && hasEmail && hasPhone);
}

function loadOptionalDependency(packageName) {
  try {
    return require(packageName);
  } catch (error) {
    throw createUploadError(500, `Missing dependency "${packageName}". Run npm install.`, 'Server Error');
  }
}

async function detectFileSignature(buffer) {
  const fileType = loadOptionalDependency('file-type');
  return fileType.fileTypeFromBuffer(buffer);
}

function matchesDocHeader(buffer) {
  if (!buffer || buffer.length < 8) return false;
  const sig = buffer.slice(0, 8);
  return (
    sig[0] === 0xd0 &&
    sig[1] === 0xcf &&
    sig[2] === 0x11 &&
    sig[3] === 0xe0 &&
    sig[4] === 0xa1 &&
    sig[5] === 0xb1 &&
    sig[6] === 0x1a &&
    sig[7] === 0xe1
  );
}

async function detectFormat(file) {
  const ext = extensionOf(file.originalname);
  let signature;

  try {
    signature = await detectFileSignature(file.buffer);
  } catch (error) {
    // Keep upload usable even if signature detection fails at runtime.
    signature = null;
  }

  if (signature) {
    return { ext: `.${signature.ext.toLowerCase()}`, mime: signature.mime, source: 'signature' };
  }

  if (ext === '.pdf' && file.buffer.slice(0, 4).toString('latin1') === '%PDF') {
    return { ext: '.pdf', mime: 'application/pdf', source: 'header' };
  }

  if (ext === '.docx' && file.buffer.slice(0, 2).toString('latin1') === 'PK') {
    return { ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', source: 'header' };
  }

  if (ext === '.doc' && matchesDocHeader(file.buffer)) {
    return { ext: '.doc', mime: 'application/msword', source: 'header' };
  }

  if (ext === '.txt') {
    return { ext: '.txt', mime: file.mimetype || 'text/plain', source: 'extension' };
  }

  return { ext, mime: file.mimetype || 'application/octet-stream', source: 'extension' };
}

async function validateUploadMeta(file) {
  if (!file) {
    throw createUploadError(400, 'Missing file in field "file" or "cv"');
  }

  if (!file.buffer || file.size === 0) {
    throw createUploadError(400, 'Uploaded file is empty or corrupted');
  }

  if (file.size < MIN_FILE_SIZE_BYTES) {
    throw createUploadError(400, `File size must be at least ${formatFileSize(MIN_FILE_SIZE_BYTES)}`);
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw createUploadError(400, `File size exceeds ${formatFileSize(MAX_FILE_SIZE_BYTES)} limit`);
  }

  const safeName = sanitizeFilename(file.originalname);
  const ext = extensionOf(safeName);

  if (isHiddenFile(file.originalname)) {
    throw createUploadError(400, 'Hidden files are not allowed');
  }

  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw createUploadError(400, 'Executable files are not allowed');
  }

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw createUploadError(400, `Unsupported file extension: ${ext || 'unknown'}`);
  }

  const format = await detectFormat({ ...file, originalname: safeName });
  const allowedMimes = ALLOWED_MIME_BY_EXTENSION[ext] || [];

  if (allowedMimes.length > 0 && file.mimetype && !allowedMimes.includes(file.mimetype)) {
    throw createUploadError(400, `Invalid MIME type ${file.mimetype} for ${ext} file`);
  }

  if (format.ext && ext !== format.ext && !(ext === '.txt' && format.ext === '.bin')) {
    throw createUploadError(400, `File extension/content mismatch (${ext} vs ${format.ext})`);
  }

  return {
    extension: ext,
    safeName,
    detectedFormat: format,
  };
}

async function extractTextFromPdf(fileBuffer) {
  const pdfParse = loadOptionalDependency('pdf-parse');
  const data = await pdfParse(fileBuffer);
  return data?.text || '';
}

async function extractTextFromDocx(fileBuffer) {
  const mammoth = loadOptionalDependency('mammoth');
  const data = await mammoth.extractRawText({ buffer: fileBuffer });
  return data?.value || '';
}

async function extractTextFromDoc(fileBuffer) {
  return fileBuffer.toString('latin1').replace(/[\x00-\x08\x0E-\x1F]/g, ' ');
}

async function extractTextByExtension(file) {
  const ext = extensionOf(file.originalname);

  if (ext === '.txt') {
    const encoding = detectTextEncoding(file.buffer);
    return {
      text: decodeTextBuffer(file.buffer, encoding),
      encoding,
    };
  }

  if (ext === '.pdf') {
    return {
      text: await extractTextFromPdf(file.buffer),
      encoding: 'binary',
    };
  }

  if (ext === '.docx') {
    return {
      text: await extractTextFromDocx(file.buffer),
      encoding: 'binary',
    };
  }

  if (ext === '.doc') {
    return {
      text: await extractTextFromDoc(file.buffer),
      encoding: 'binary',
    };
  }

  throw createUploadError(400, `Unsupported file extension: ${ext}`);
}

async function withTimeout(taskPromise, timeoutMs, reason) {
  let timer;

  try {
    return await Promise.race([
      taskPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createUploadError(504, reason, 'Upload processing failed')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runClamAVScan(file, safeName) {
  const enabled = String(process.env.ENABLE_CLAMAV_SCAN || 'false').toLowerCase() === 'true';
  if (!enabled) {
    return { scanned: false, infected: false };
  }

  const cmd = process.env.CLAMAV_COMMAND || 'clamscan';
  const timeoutMs = Number(process.env.CLAMAV_TIMEOUT_MS || 12000);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cv-upload-'));
  const tmpPath = path.join(tmpDir, safeName || 'upload.bin');

  try {
    await fs.writeFile(tmpPath, file.buffer);
  } catch (error) {
    if (error?.code === 'ENOSPC') {
      throw createUploadError(507, 'Insufficient storage while processing upload', 'Upload failed');
    }
    throw createUploadError(500, `Failed to stage file for virus scan: ${error.message}`, 'Upload failed');
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(cmd, ['--no-summary', tmpPath]);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(createUploadError(504, 'Virus scan timed out', 'Upload failed'));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(createUploadError(500, `ClamAV execution failed: ${error.message}`, 'Upload failed'));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });

    if (result.code === 1 || /FOUND/i.test(result.stdout)) {
      throw createUploadError(400, 'Uploaded file failed virus scan');
    }

    if (result.code !== 0) {
      throw createUploadError(500, `Virus scan failed: ${result.stderr || result.stdout}`, 'Upload failed');
    }

    return { scanned: true, infected: false };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function processUploadedFile(file) {
  const validation = await validateUploadMeta(file);
  await runClamAVScan(file, validation.safeName);

  const extracted = await withTimeout(
    extractTextByExtension({ ...file, originalname: validation.safeName }),
    UPLOAD_PROCESS_TIMEOUT_MS,
    'Upload processing timed out'
  );

  const cleanedText = cleanExtractedText(extracted.text);

  if (!cleanedText || cleanedText.length < 80) {
    throw createUploadError(400, 'Could not extract meaningful text from uploaded file');
  }

  if (!isProbablyCVContent(cleanedText)) {
    throw createUploadError(400, 'Uploaded file does not appear to be a CV/resume');
  }

  const extractedFields = await withTimeout(
    extractCVFields(cleanedText),
    UPLOAD_PROCESS_TIMEOUT_MS,
    'Field extraction timed out'
  );

  return {
    originalName: validation.safeName,
    originalClientName: file.originalname,
    extension: validation.extension,
    mimeType: file.mimetype,
    detectedFormat: validation.detectedFormat,
    fileSize: file.size,
    humanSize: formatFileSize(file.size),
    encoding: extracted.encoding,
    rawContent: cleanedText,
    extractedFields,
  };
}

module.exports = {
  MAX_FILE_SIZE_BYTES,
  MIN_FILE_SIZE_BYTES,
  ALLOWED_EXTENSIONS,
  processUploadedFile,
  createUploadError,
  formatFileSize,
  __private: {
    extensionOf,
    isHiddenFile,
    sanitizeFilename,
    detectTextEncoding,
    decodeTextBuffer,
    cleanExtractedText,
    isProbablyCVContent,
    validateUploadMeta,
    detectFormat,
  },
};
