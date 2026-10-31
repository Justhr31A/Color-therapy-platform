'use strict';

const express = require('express');
const db = require('../db');
const asyncRoute = require('../utils/asyncRoute');
const { createFeatureFlagService } = require('../services/featureFlags');

/**
 * PUBLIC camera / AR availability. No login. Mounted at /api/public/camera.
 *
 *   GET /status   { enabled: boolean } — always 200, so the protocol page can decide whether to show its Camera
 *                 option. It reveals nothing but that one boolean.
 *
 * The camera view is ON only while the public website, the protocol browser, CAMERA and AR are all on (AR already
 * requires CAMERA in the feature-flag service). Both camera flags are OFF by default; an administrator switches them
 * at /admin/camera (admin.camera.routes.js) or with `npm run flags`.
 *
 * There is deliberately no protocol data here: the camera page reads the SAME published render contract as the
 * website and the PDF (GET /api/public/protocols/:slug/render — published snapshots only). Camera frames are never
 * sent to this server: hand tracking runs entirely in the visitor's browser.
 */
const router = express.Router();
const flags = createFeatureFlagService(db);

const REQUIRED = ['WEBSITE', 'PROTOCOL_BROWSER', 'CAMERA', 'AR'];
const cameraEnabled = async () => (await flags.areEnabled(REQUIRED)).every(Boolean);

router.get('/status', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ enabled: await cameraEnabled() });
}));

module.exports = router;
module.exports.cameraEnabled = cameraEnabled;
module.exports.REQUIRED_FLAGS = REQUIRED;
