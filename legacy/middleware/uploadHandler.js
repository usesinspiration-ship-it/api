const path = require('node:path');
const multer = require('multer');
const {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_EXTENSIONS,
  processUploadedFile,
  createUploadError,
} = require('../utils/fileUpload');

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();

    if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
      cb(createUploadError(400, `Unsupported file extension: ${ext || 'unknown'}`));
      return;
    }

    cb(null, true);
  },
});

function selectUploadedFile(req) {
  const cvFile = req.files?.cv?.[0];
  const genericFile = req.files?.file?.[0];
  return cvFile || genericFile || null;
}

function uploadSingleCV(req, res, next) {
  upload.fields([
    { name: 'cv', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])(req, res, (error) => {
    if (!error) {
      req.file = selectUploadedFile(req);
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        next(createUploadError(400, `File size exceeds ${(MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0)}MB limit`));
        return;
      }

      next(createUploadError(400, error.message));
      return;
    }

    next(error);
  });
}

async function validateAndProcessUpload(req, res, next) {
  try {
    const isMultipart = String(req.headers['content-type'] || '').toLowerCase().includes('multipart/form-data');

    if (!req.file) {
      if (isMultipart) {
        throw createUploadError(400, 'Missing file in multipart request. Use field "file" (or "cv").');
      }
      next();
      return;
    }

    req.uploadData = await processUploadedFile(req.file);

    // Upload audit log with actor and file metadata.
    // eslint-disable-next-line no-console
    console.info(
      `[upload] user=${req.user?.id || 'unknown'} file=${req.uploadData.originalName} size=${req.uploadData.humanSize} mimetype=${req.uploadData.mimeType}`
    );

    next();
  } catch (error) {
    if (error?.code === 'ENOSPC') {
      next(createUploadError(507, 'Insufficient disk space during upload processing', 'Upload failed'));
      return;
    }

    next(error);
  }
}

module.exports = {
  uploadSingleCV,
  validateAndProcessUpload,
};
