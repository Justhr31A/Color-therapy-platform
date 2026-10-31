'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireFlag } = require('../middleware/flags');
const { createCatalogService } = require('../services/catalogService');
const asyncRoute = require('../utils/asyncRoute');

/** Admin-only category management. Every route (reads included) requires an admin session and the ADMIN flag. */
const router = express.Router();
const catalog = createCatalogService(db);

router.use(requireAuth, requireRole('admin'), requireFlag('ADMIN'));

router.get('/', asyncRoute(async (req, res) => res.json(await catalog.listCategories())));
router.post('/', asyncRoute(async (req, res) => res.status(201).json(await catalog.createCategory(req.body || {}))));
router.get('/:id', asyncRoute(async (req, res) => res.json(await catalog.getCategory(req.params.id))));
router.put('/:id', asyncRoute(async (req, res) => res.json(await catalog.updateCategory(req.params.id, req.body || {}))));
router.post('/:id/activate', asyncRoute(async (req, res) => res.json(await catalog.setCategoryActive(req.params.id, true))));
router.post('/:id/deactivate', asyncRoute(async (req, res) => res.json(await catalog.setCategoryActive(req.params.id, false))));

module.exports = router;
