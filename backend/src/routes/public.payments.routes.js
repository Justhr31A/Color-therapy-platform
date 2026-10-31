'use strict';

const express = require('express');
const db = require('../db');
const { requireFlag } = require('../middleware/flags');
const { verifyToken } = require('../utils/jwt');
const { COOKIE_NAME } = require('../middleware/auth');
const { createFeatureFlagService } = require('../services/featureFlags');
const { createProtocolRepository } = require('../repositories/protocols.repo');
const { createUserRepository } = require('../repositories/users.repo');
const { verifyChecksum } = require('../protocol/snapshot');
const { createPaymentService } = require('../payments/paymentService');

/**
 * PUBLIC protocol access (Payment Phase 1). No login required. Mounted at /api/public, before the read-only router.
 *
 *   GET  /payment/status               { accessEnabled, mode, free, canCheckout, price|null, message }
 *   POST /protocols/:slug/access       { accessId? } -> { accessId, status, mode, unlocked, protocol, message }
 *   GET  /access/:accessId             the same shape, re-checked against the protocol's current published state
 *   POST /access/:accessId/verify      PAID only (a provider confirms payment); answers 503 until one is configured
 *
 * Nothing in a request body is trusted for any access decision: the amount, "I paid" and "unlocked" are never read.
 * Only a currently PUBLISHED protocol can be unlocked; anything else is the same 404. Responses never include
 * provider names, provider ids, signatures or settings internals. A signed-in user (if any) is linked to the record,
 * but an account is never required.
 */
const router = express.Router();
const flags = createFeatureFlagService(db);
const protocols = createProtocolRepository(db);
const users = createUserRepository(db);

const findPublished = async (slug) => {
  const row = await protocols.findPublishedBySlug(slug);
  if (!row || row.kind !== 'published' || row.protocol_id !== row.id) return null;
  if (!verifyChecksum(row.snapshot_json, row.checksum)) {
    console.error(`[public] integrity check failed for published protocol "${row.slug}" (version ${row.version}).`);
    return null;
  }
  let snapshot;
  try { snapshot = JSON.parse(row.snapshot_json); } catch (_) { return null; }
  const protocol = snapshot && snapshot.protocol;
  if (!protocol || !protocol.name) return null;
  return { protocolId: row.id, versionId: row.version_id, slug: row.slug, name: protocol.displayName || protocol.name || row.slug };
};
const payments = createPaymentService({ db, flags, findPublished });

const publicGate = [requireFlag('WEBSITE'), requireFlag('PROTOCOL_BROWSER')];
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

async function optionalUserId(req) {
  try {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (!token) return null;
    const row = await users.findById(verifyToken(token).sub);
    return row ? row.id : null;
  } catch (e) {
    return null;
  }
}

router.get('/payment/status', publicGate, async (req, res, next) => {
  try { noStore(res); res.json(await payments.publicStatus()); } catch (err) { next(err); }
});

router.post('/protocols/:slug/access', publicGate, async (req, res, next) => {
  try {
    noStore(res);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const out = await payments.requestAccess({ slug: req.params.slug, userId: await optionalUserId(req), accessId: body.accessId });
    res.status(out.status === 'free' || out.unlocked ? 201 : 202).json(out);
  } catch (err) { next(err); }
});

router.get('/access/:accessId', publicGate, async (req, res, next) => {
  try { noStore(res); res.json(await payments.getAccess(req.params.accessId)); } catch (err) { next(err); }
});

router.post('/access/:accessId/verify', publicGate, async (req, res, next) => {
  try {
    noStore(res);
    res.json(await payments.verifyAccess(req.params.accessId, req.body));
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.payments = payments;
