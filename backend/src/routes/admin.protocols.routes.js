'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireFlag } = require('../middleware/flags');
const { createProtocolService } = require('../services/protocolService');
const { badRequest } = require('../utils/errors');
const asyncRoute = require('../utils/asyncRoute');

/**
 * Admin-only protocol management: metadata, lifecycle, publishing, version
 * history/restore, duplication and search terms.
 *
 * Editing the DRAFT canvases/objects uses the existing builder endpoint
 * (POST /api/protocols/:id/save, open to admins), so there is one save path.
 */
const router = express.Router();
const protocols = createProtocolService(db);

router.use(requireAuth, requireRole('admin'), requireFlag('ADMIN'));

function versionParam(req) {
  const n = Number(req.params.version);
  if (!Number.isInteger(n) || n < 1) throw badRequest('version must be a positive whole number.', { code: 'INVALID_INPUT' });
  // protocol_versions.version is a 4-byte INTEGER: anything larger cannot exist.
  return n > 2147483647 ? 2147483647 : n;
}

router.get('/', asyncRoute(async (req, res) => {
  const { status, categoryId, q, limit, offset } = req.query || {};
  res.json(await protocols.list({ status, categoryId, q, limit, offset }));
}));

router.post('/', asyncRoute(async (req, res) => {
  const id = await protocols.create(req.body || {}, req.user);
  res.status(201).json(await protocols.getFull(id));
}));

router.get('/:id', asyncRoute(async (req, res) => res.json(await protocols.getFull(req.params.id))));

// metadata only — never status, never the published pointer. The slug changes only if `slug` is sent.
router.put('/:id', asyncRoute(async (req, res) => res.json(await protocols.updateMetadata(req.params.id, req.body || {}, req.user))));

// draft <-> in_review <-> archived. ('published' is refused: use /publish)
router.post('/:id/status', asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  if (typeof status !== 'string') throw badRequest('status is required.', { code: 'INVALID_INPUT' });
  res.json(await protocols.changeStatus(req.params.id, status));
}));

router.post('/:id/publish', asyncRoute(async (req, res) => {
  const result = await protocols.publish(req.params.id, req.user, { note: (req.body || {}).note === undefined ? null : req.body.note });
  res.status(201).json({ ...result, protocol: await protocols.getFull(req.params.id) });
}));

router.post('/:id/archive', asyncRoute(async (req, res) => res.json(await protocols.archive(req.params.id))));

router.post('/:id/duplicate', asyncRoute(async (req, res) => {
  const newId = await protocols.duplicate(req.params.id, req.user);
  res.status(201).json(await protocols.getFull(newId));
}));

// ---- version history (metadata list; a version's full snapshot on request) ----
router.get('/:id/versions', asyncRoute(async (req, res) => res.json(await protocols.listVersions(req.params.id))));
router.get('/:id/versions/:version', asyncRoute(async (req, res) => res.json(await protocols.getVersion(req.params.id, versionParam(req)))));
router.post('/:id/versions/:version/restore', asyncRoute(async (req, res) => {
  const result = await protocols.restoreVersion(req.params.id, versionParam(req), req.user);
  res.json({ ...result, protocol: await protocols.getFull(req.params.id) });
}));

// ---- search terms ----
router.get('/:id/search-terms', asyncRoute(async (req, res) => res.json(await protocols.listTerms(req.params.id))));
router.post('/:id/search-terms', asyncRoute(async (req, res) => res.status(201).json(await protocols.addTerm(req.params.id, req.body || {}, req.user))));
router.delete('/:id/search-terms/:termId', asyncRoute(async (req, res) => {
  await protocols.removeTerm(req.params.id, req.params.termId, req.user);
  res.json({ ok: true });
}));

module.exports = router;
