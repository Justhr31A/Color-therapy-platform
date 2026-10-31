'use strict';

const express = require('express');
const db = require('../db');
const asyncRoute = require('../utils/asyncRoute');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireFlag } = require('../middleware/flags');
const { createFeatureFlagService } = require('../services/featureFlags');

/**
 * ADMIN control of the AI Protocol Assistant switch. Mounted at /api/admin/ai.
 *
 *   GET  /          the switch's state
 *   POST /enable    turn AI_ASSESSMENT on
 *   POST /disable   turn AI_ASSESSMENT off
 *
 * This is a thin, single-purpose door onto the EXISTING feature-flag service (the same one `npm run flags` and the
 * requireFlag middleware use) — there is no second flag system. It can change exactly one flag: an administrator
 * cannot use it to flip AR, PAYMENTS, CAMERA or anything else, and it does not list the other flags.
 *
 * Doctors, patients and anonymous callers cannot reach it: every route needs an admin session, and a doctor gets 403.
 * The switch is OFF unless an administrator turns it on (the flag's default is off and nothing here changes that).
 */
const router = express.Router();
const flags = createFeatureFlagService(db);

const KEY = 'AI_ASSESSMENT';
// The public assistant also needs the public website and protocol browser, because everything it returns is shown there.
const PUBLIC_PREREQUISITES = ['WEBSITE', 'PROTOCOL_BROWSER'];

async function state() {
  const [enabled, ...prereqs] = await flags.areEnabled([KEY, ...PUBLIC_PREREQUISITES]);
  const blockedBy = PUBLIC_PREREQUISITES.filter((key, i) => !prereqs[i]);
  return {
    key: KEY,
    enabled, //                                   the switch itself
    available: enabled && blockedBy.length === 0, // whether visitors can actually use the assistant right now
    blockedBy, //                                 website features that are off and would keep visitors from using it
  };
}

router.use(requireAuth, requireRole('admin'), requireFlag('ADMIN'));

router.get('/', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await state());
}));

router.post('/enable', asyncRoute(async (req, res) => {
  await flags.setFlag(KEY, true, { actorId: req.user.id });
  res.setHeader('Cache-Control', 'no-store');
  res.json(await state());
}));

router.post('/disable', asyncRoute(async (req, res) => {
  await flags.setFlag(KEY, false, { actorId: req.user.id });
  res.setHeader('Cache-Control', 'no-store');
  res.json(await state());
}));

module.exports = router;
