'use strict';

const express = require('express');
const db = require('../db');
const asyncRoute = require('../utils/asyncRoute');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireFlag } = require('../middleware/flags');
const { createFeatureFlagService } = require('../services/featureFlags');

/**
 * ADMIN control of the public Camera (live AR) switch. Mounted at /api/admin/camera.
 *
 *   GET  /          the switch's state
 *   POST /enable    turn CAMERA, then AR, on
 *   POST /disable   turn AR, then CAMERA, off
 *
 * Same shape as admin.ai.routes.js: a thin, single-purpose door onto the EXISTING feature-flag service (the one
 * `npm run flags` and requireFlag use) — no second flag system. It changes exactly the CAMERA and AR flags (AR requires
 * CAMERA, so they are switched together and in dependency order); it cannot touch any other flag and does not list them.
 *
 * Why it exists: production has no server shell to run `npm run flags`, so without this an administrator could not
 * switch the camera on or off. (Flags now persist in PostgreSQL across redeploys.)
 *
 * Every route needs an admin session; a doctor gets 403, an anonymous caller 401.
 */
const router = express.Router();
const flags = createFeatureFlagService(db);

const PUBLIC_PREREQUISITES = ['WEBSITE', 'PROTOCOL_BROWSER'];

async function state() {
  const [camera, ar, ...prereqs] = await flags.areEnabled(['CAMERA', 'AR', ...PUBLIC_PREREQUISITES]);
  const enabled = camera && ar;
  const blockedBy = PUBLIC_PREREQUISITES.filter((key, i) => !prereqs[i]);
  return { key: 'CAMERA', enabled, available: enabled && blockedBy.length === 0, blockedBy };
}

router.use(requireAuth, requireRole('admin'), requireFlag('ADMIN'));

// CAMERA and AR change together: both writes run in one transaction, so a failure part-way never leaves one on and
// the other off.
async function switchCamera(on, actorId) {
  await db.transaction(async (tx) => {
    const txFlags = createFeatureFlagService(tx);
    if (on) {
      await txFlags.setFlag('CAMERA', true, { actorId });
      await txFlags.setFlag('AR', true, { actorId });
    } else {
      await txFlags.setFlag('AR', false, { actorId });
      await txFlags.setFlag('CAMERA', false, { actorId });
    }
  });
}

router.get('/', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await state());
}));

router.post('/enable', asyncRoute(async (req, res) => {
  await switchCamera(true, req.user.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await state());
}));

router.post('/disable', asyncRoute(async (req, res) => {
  await switchCamera(false, req.user.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await state());
}));

module.exports = router;
