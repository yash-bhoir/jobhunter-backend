const express    = require('express');
const router     = express.Router();
const ctrl       = require('../controllers/geoJobs.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);

// Search
router.get('/nearby',     ctrl.getNearbyJobs);

// Backfill geo on canonical Job documents (Nominatim + cache; rate-limited)
router.post('/enrich-stored', ctrl.enrichStoredJobs);

// Saved state
router.get('/saved-ids',  ctrl.getSavedGeoJobIds);

// Save / unsave
router.post('/:id/save',   ctrl.saveGeoJob);
router.post('/:id/unsave', ctrl.unsaveGeoJob);

// Seed (idempotent)
router.post('/seed', ctrl.seedGeoJobs);

module.exports = router;
