const multer = require('multer');
const path   = require('path');

const storage = multer.memoryStorage();

// PDF-only filter (existing resume upload)
const pdfFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext !== '.pdf') return cb(new Error('Only PDF files are allowed'), false);
  cb(null, true);
};

// DOCX-only filter (new DOCX resume upload for keyword patching)
const docxFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext !== '.docx') return cb(new Error('Only .docx files are allowed'), false);
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter: pdfFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const uploadDocx = multer({
  storage,
  fileFilter: docxFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

module.exports = { upload, uploadDocx };