'use strict';

const express = require('express');
const db = require('../db');
const asyncRoute = require('../utils/asyncRoute');
const { requireFlag } = require('../middleware/flags');
const { createPublicProtocolService } = require('../services/publicProtocols');

/**
 * PUBLIC, read-only, no authentication.
 *
 * Only GET routes exist here, and every response is built from the frozen
 * snapshot of a protocol's PUBLISHED version (see services/publicProtocols.js).
 * A protocol that is a draft, in review, archived, unpublished or unknown gets
 * the identical 404, so nothing about unpublished data can be probed.
 * Gated by the WEBSITE and PROTOCOL_BROWSER feature flags (404 when off).
 */
const router = express.Router();
const publicProtocols = createPublicProtocolService(db);

router.use(requireFlag('WEBSITE'), requireFlag('PROTOCOL_BROWSER'));

const notFound = (res) => res.status(404).json({ error: 'Protocol not found.' });

// GET /api/public/categories — categories with at least one published protocol (for the home page and the
// browser's category filter). Never a second data source: it reads the same published snapshots as /protocols.
router.get('/categories', asyncRoute(async (req, res) => {
  res.json(await publicProtocols.listCategories());
}));

// GET /api/public/protocols?q=&category=<slug>&condition=<slug>&limit=&offset=
router.get('/protocols', asyncRoute(async (req, res) => {
  const { q, category, condition, limit, offset } = req.query || {};
  res.json(await publicProtocols.list({ q, category, condition, limit, offset }));
}));

// GET /api/public/protocols/:slug  — the currently published version's details
router.get('/protocols/:slug', asyncRoute(async (req, res) => {
  const detail = await publicProtocols.getDetail(req.params.slug);
  return detail ? res.json(detail) : notFound(res);
}));

// GET /api/public/protocols/:slug/render — structured, renderable data (viewer / download / AR)
router.get('/protocols/:slug/render', asyncRoute(async (req, res) => {
  const render = await publicProtocols.getRender(req.params.slug);
  return render ? res.json(render) : notFound(res);
}));

module.exports = router;
