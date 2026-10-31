'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireFlag } = require('../middleware/flags');
const { createFeatureFlagService } = require('../services/featureFlags');
const { createPaymentService } = require('../payments/paymentService');

/**
 * ADMIN payment-access settings. Mounted at /api/admin/payments. Admin only: anonymous 401, doctor/patient 403.
 *
 *   GET  /settings   current mode, launch message, future amount/currency, provider, whether charging is active
 *   POST /settings   { mode?, accessEnabled?, futureAmount?, currency? }
 *
 * Switching to PAID changes nothing a visitor pays: with no provider configured (Phase 1) checkout is refused and
 * protocols are simply not charged for. A payment provider cannot be selected here.
 */
const router = express.Router();
const flags = createFeatureFlagService(db);
const payments = createPaymentService({ db, flags, findPublished: () => null }); // settings only; never grants access

router.use(requireAuth, requireRole('admin'), requireFlag('ADMIN'));

router.get('/settings', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await payments.adminState());
  } catch (err) { next(err); }
});

router.post('/settings', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await payments.updateSettings(req.body, req.user.id));
  } catch (err) { next(err); }
});

module.exports = router;
