'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireFlag } = require('../middleware/flags');
const { createCatalogService } = require('../services/catalogService');
const asyncRoute = require('../utils/asyncRoute');

/**
 * READ-ONLY catalog for the Protocol Studio: the categories and conditions a doctor may choose from when
 * describing their own protocol. Active entries only, and only what is needed to choose one (id, name, slug).
 * Creating or changing categories/conditions stays admin-only (/api/admin/categories, /api/admin/conditions) —
 * nothing here can write.
 *
 * Same gate as the rest of the Studio API: a signed-in doctor or admin, with the PROTOCOL_STUDIO flag on
 * (a patient or anonymous caller is refused by the server itself).
 */
const router = express.Router();
const catalog = createCatalogService(db);

router.use(requireAuth, requireRole('doctor', 'admin'), requireFlag('PROTOCOL_STUDIO'));

const choice = ({ id, name, slug }) => ({ id, name, slug });

router.get('/categories', asyncRoute(async (req, res) => {
  res.json((await catalog.listCategories()).filter((c) => c.isActive).map(choice));
}));

router.get('/conditions', asyncRoute(async (req, res) => {
  res.json((await catalog.listConditions()).filter((c) => c.isActive).map(choice));
}));

module.exports = router;
