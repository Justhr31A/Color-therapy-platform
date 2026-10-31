'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireFlag } = require('../middleware/flags');
const { createCatalogService } = require('../services/catalogService');
const { createProtocolService } = require('../services/protocolService');
const { badRequest } = require('../utils/errors');
const asyncRoute = require('../utils/asyncRoute');

/** Admin-only condition management and condition <-> protocol links. */
const router = express.Router();
const catalog = createCatalogService(db);
const protocols = createProtocolService(db);

router.use(requireAuth, requireRole('admin'), requireFlag('ADMIN'));

router.get('/', asyncRoute(async (req, res) => res.json(await catalog.listConditions({ categoryId: req.query && req.query.categoryId }))));
router.post('/', asyncRoute(async (req, res) => res.status(201).json(await catalog.createCondition(req.body || {}))));
router.get('/:id', asyncRoute(async (req, res) => res.json(await catalog.getCondition(req.params.id))));
router.put('/:id', asyncRoute(async (req, res) => res.json(await catalog.updateCondition(req.params.id, req.body || {}))));
router.post('/:id/activate', asyncRoute(async (req, res) => res.json(await catalog.setConditionActive(req.params.id, true))));
router.post('/:id/deactivate', asyncRoute(async (req, res) => res.json(await catalog.setConditionActive(req.params.id, false))));

// protocols attached to a condition
router.get('/:id/protocols', asyncRoute(async (req, res) => res.json(await catalog.listProtocolsForCondition(req.params.id))));

router.post('/:id/protocols', asyncRoute(async (req, res) => {
  const { protocolId } = req.body || {};
  if (typeof protocolId !== 'string' || !protocolId) throw badRequest('protocolId is required.', { code: 'INVALID_INPUT' });
  await protocols.attachCondition(req.params.id, protocolId, req.user);
  res.status(201).json({ conditionId: req.params.id, protocolId });
}));

router.delete('/:id/protocols/:protocolId', asyncRoute(async (req, res) => {
  await protocols.detachCondition(req.params.id, req.params.protocolId, req.user);
  res.json({ ok: true });
}));

module.exports = router;
