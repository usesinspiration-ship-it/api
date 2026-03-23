const express = require('express');
const {
  getAllCVs,
  getCVById,
  downloadCV,
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
} = require('../controllers/cvController');
const { verifyToken, requireRole } = require('../middleware/auth');
const { uploadSingleCV, validateAndProcessUpload } = require('../middleware/uploadHandler');

const router = express.Router();

// Global CV APIs are protected by JWT.
router.get('/cvs', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), getAllCVs);
router.get('/cvs/:id', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), getCVById);
router.get('/cvs/:id/download', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), downloadCV);
router.post('/cvs', verifyToken, requireRole('admin', 'hr'), uploadSingleCV, validateAndProcessUpload, createCV);
router.put('/cvs/:id', verifyToken, requireRole('admin', 'hr'), updateCV);
router.delete('/cvs/:id', verifyToken, requireRole('admin', 'hr'), deleteCV);

router.get('/search', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), searchCVs);
router.get('/search/analytics', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), getSearchInsights);
router.get('/stats', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), getStats);
router.get('/stats/skills', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), getSkillsStats);
router.get('/stats/job-titles', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), getJobTitlesStats);
router.get('/stats/experience', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), getExperienceStatsController);
router.get('/stats/education', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), getEducationStatsController);
router.get('/stats/languages', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), getLanguagesStats);
router.get('/stats/uploads', verifyToken, requireRole('admin', 'hr', 'recruiter', 'viewer'), getUploadsStats);
router.get('/stats/users', verifyToken, requireRole('admin'), getUsersStats);

module.exports = router;
