'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireFlag } = require('../middleware/flags');
const { isAdmin, canManageProtocol } = require('../policy/protocolAccess');
const { ALL_STATUSES } = require('../protocol/lifecycle');
const { serializeCanvasRow, serializeProtocolRow } = require('../utils/serialize');
const { createProtocolService } = require('../services/protocolService');
const { createProtocolRepository } = require('../repositories/protocols.repo');
const { createUserRepository } = require('../repositories/users.repo');
const { badRequest } = require('../utils/errors');
const asyncRoute = require('../utils/asyncRoute');

const router = express.Router();
const protocolService = createProtocolService(db);
const protocols = createProtocolRepository(db);
const users = createUserRepository(db);

// Every route below requires a logged-in doctor OR admin, and the
// PROTOCOL_STUDIO feature flag to be on. This is the real enforcement
// boundary — a patient account (or no account at all) gets a 401/403 from the
// server itself, and a disabled feature answers 404, regardless of what the
// client UI shows. Doctors are still limited to their own protocols; admins
// may manage every protocol (see policy/protocolAccess.js).
router.use(requireAuth, requireRole('doctor', 'admin'), requireFlag('PROTOCOL_STUDIO'));

async function loadCanvasesForProtocol(protocolId) {
  const canvases = [];
  for (const c of await protocols.getCanvases(protocolId)) {
    canvases.push(serializeCanvasRow(c, await protocols.getObjectsInSavedOrder(c.id)));
  }
  return canvases;
}

/**
 * The one place that decides whether `user` may manage protocol `id`.
 * Returns the protocol row, or null when it doesn't exist OR the user isn't
 * allowed to see it (callers answer 404 either way, so ids can't be probed).
 */
async function findProtocolFor(user, id) {
  const row = await protocols.findById(id);
  return canManageProtocol(user, row) ? row : null;
}

async function loadFullProtocol(protocolId, user) {
  const row = await findProtocolFor(user, protocolId);
  if (!row) return null;
  const canvases = await loadCanvasesForProtocol(protocolId);
  const patientRow = row.patient_id ? await users.findPatientSummary(row.patient_id) : null;
  return serializeProtocolRow(row, canvases, patientRow, { extended: true });
}

/**
 * A URL version number as the protocol_versions.version INTEGER it names, or null when it cannot name one.
 * (SQLite compared the raw text and simply found no row; PostgreSQL rejects non-integer input, so it is
 * checked here and answered with the same 404.)
 */
function urlVersionNumber(raw) {
  const n = Number(raw);
  return typeof raw === 'string' && raw.trim() !== '' && Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : null;
}

// ---------------------------------------------------------------------------
// GET /api/protocols — list protocols (doctor: their own; admin: all)
// ---------------------------------------------------------------------------
router.get('/', asyncRoute(async (req, res) => {
  const rows = await protocols.listForBuilder(isAdmin(req.user) ? null : req.user.id);
  const list = [];
  for (const row of rows) {
    const patientRow = row.patient_id ? await users.findPatientSummary(row.patient_id) : null;
    const canvasCount = await protocols.countCanvases(row.id);
    list.push({
      id: row.id,
      name: row.name,
      description: row.description,
      protocolType: row.protocol_type,
      status: row.status,
      currentVersion: row.current_version,
      canvasCount,
      patient: patientRow
        ? { id: patientRow.id, name: patientRow.name, email: patientRow.email, status: patientRow.status }
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  res.json(list);
}));

// ---------------------------------------------------------------------------
// POST /api/protocols — create a new protocol (hand or organ)
// ---------------------------------------------------------------------------
router.post('/', asyncRoute(async (req, res) => {
  const { name, description, protocolType, organKeys } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Protocol name is required.' });
  }
  if (!['hand', 'organ'].includes(protocolType)) {
    return res.status(400).json({ error: "protocolType must be 'hand' or 'organ'." });
  }

  // The service creates the protocol as a DRAFT with a unique slug, its canvases and version 1.
  const protocolId = await protocolService.create({ name, description, protocolType, organKeys }, req.user);
  return res.status(201).json(await loadFullProtocol(protocolId, req.user));
}));

// ---------------------------------------------------------------------------
// GET /api/protocols/:id — full protocol with canvases + objects
// ---------------------------------------------------------------------------
router.get('/:id', asyncRoute(async (req, res) => {
  const protocol = await loadFullProtocol(req.params.id, req.user);
  if (!protocol) return res.status(404).json({ error: 'Protocol not found.' });
  return res.json(protocol);
}));

// ---------------------------------------------------------------------------
// PUT /api/protocols/:id — update metadata (name/description/status)
// ---------------------------------------------------------------------------
router.put('/:id', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });

  const { name, description, status } = req.body || {};
  const patch = {};
  if (name && typeof name === 'string' && name.trim() && name.trim() !== existing.name) {
    patch.name = name.trim();
  }
  if (description !== undefined && description !== existing.description) {
    patch.description = description === null ? '' : description;
  }

  // Lifecycle rules apply here too: a protocol becomes 'published' only via
  // the publish action, and a published protocol can only move to 'archived'.
  // Unrecognised status values are ignored, as this endpoint always did.
  const statusRequested = typeof status === 'string' && status !== existing.status && ALL_STATUSES.includes(status);

  // Metadata and status change together or not at all.
  await db.transaction(async (tx) => {
    const svc = createProtocolService(tx);
    if (Object.keys(patch).length) await svc.updateMetadata(existing.id, patch, req.user);
    if (statusRequested) await svc.changeStatus(existing.id, status, { allowLegacy: true });
  });

  return res.json(await loadFullProtocol(existing.id, req.user));
}));

// ---------------------------------------------------------------------------
// POST /api/protocols/:id/assign — assign to a patient by email
// ---------------------------------------------------------------------------
router.post('/:id/assign', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });

  const { patientEmail, patientName } = req.body || {};
  if (!patientEmail || typeof patientEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmail)) {
    return res.status(400).json({ error: 'A valid patient email is required.' });
  }
  const email = patientEmail.toLowerCase();

  const outcome = await db.transaction(async (tx) => {
    const txUsers = createUserRepository(tx);
    let patient = await txUsers.findByEmail(email);
    if (patient && patient.role !== 'patient') return { conflict: true };
    if (!patient) {
      patient = await txUsers.create({
        id: uuidv4(),
        name: (typeof patientName === 'string' && patientName.trim()) || email.split('@')[0],
        email,
        passwordHash: null,
        role: 'patient',
        status: 'pending',
      });
    }
    await createProtocolRepository(tx).assignPatient(existing.id, patient.id);
    return { conflict: false };
  });
  if (outcome.conflict) return res.status(409).json({ error: 'That email belongs to a non-patient account.' });

  return res.json(await loadFullProtocol(existing.id, req.user));
}));

// ---------------------------------------------------------------------------
// POST /api/protocols/:id/duplicate — deep clone with new IDs
// ---------------------------------------------------------------------------
router.post('/:id/duplicate', asyncRoute(async (req, res) => {
  const source = await findProtocolFor(req.user, req.params.id);
  if (!source) return res.status(404).json({ error: 'Protocol not found.' });
  const newProtocolId = await protocolService.duplicate(source.id, req.user);
  return res.status(201).json(await loadFullProtocol(newProtocolId, req.user));
}));

// ---------------------------------------------------------------------------
// DELETE /api/protocols/:id
// ---------------------------------------------------------------------------
router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });
  // A protocol that was ever published cannot be deleted (409: archive it instead), so history is never lost.
  await protocolService.remove(existing.id);
  return res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// POST /api/protocols/:id/publish — publish a protocol owned by the doctor
// or any protocol managed by an admin.
// ---------------------------------------------------------------------------
router.post('/:id/publish', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });
  const note = (req.body || {}).note === undefined ? null : req.body.note;
  const result = await protocolService.publish(existing.id, req.user, { note });
  return res.status(201).json({ ...result, protocol: await loadFullProtocol(existing.id, req.user) });
}));

// ---------------------------------------------------------------------------
// Protocol DETAILS for the owning doctor (an admin may use these on any protocol):
// description, category, conditions and search terms.
//
// Same ownership rule as every route above (findProtocolFor -> a plain 404 for anyone
// else's protocol, so ids cannot be probed) and the SAME service functions the
// admin endpoints call, so the rules are identical: validation, refusing inactive
// categories/conditions, and "editing a published protocol only creates unpublished
// changes — the published version is never touched".
//
// What a doctor deliberately CANNOT do here: change the slug (that would break links
// already shared), set the status, archive/restore versions, or create categories or
// conditions (the catalog stays admin-managed; doctors choose from the existing ones —
// see routes/catalog.routes.js).
// ---------------------------------------------------------------------------
const DETAILS_EDITABLE = ['name', 'displayName', 'shortDescription', 'description', 'categoryId'];

router.get('/:id/details', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });
  return res.json(await protocolService.getFull(existing.id));
}));

router.put('/:id/details', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });
  const body = req.body || {};
  const refused = Object.keys(body).filter((k) => !DETAILS_EDITABLE.includes(k));
  if (refused.length) {
    throw badRequest(`These fields cannot be changed here: ${refused.join(', ')}.`, { code: 'FIELD_NOT_ALLOWED' });
  }
  return res.json(await protocolService.updateMetadata(existing.id, body, req.user));
}));

router.post('/:id/search-terms', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });
  return res.status(201).json(await protocolService.addTerm(existing.id, req.body || {}, req.user));
}));

router.delete('/:id/search-terms/:termId', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });
  await protocolService.removeTerm(existing.id, req.params.termId, req.user);
  return res.json({ ok: true });
}));

router.post('/:id/conditions', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });
  const { conditionId } = req.body || {};
  if (typeof conditionId !== 'string' || !conditionId) {
    throw badRequest('conditionId is required.', { code: 'INVALID_INPUT' });
  }
  await protocolService.attachCondition(conditionId, existing.id, req.user);
  return res.status(201).json({ conditionId, protocolId: existing.id });
}));

router.delete('/:id/conditions/:conditionId', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });
  await protocolService.detachCondition(req.params.conditionId, existing.id, req.user);
  return res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// POST /api/protocols/:id/save — persist the full working state + new version
// Body: { canvases: [ { id, objects: [ {...} ] } ] }
// ---------------------------------------------------------------------------
router.post('/:id/save', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });
  const { canvases } = req.body || {};
  if (!Array.isArray(canvases)) return res.status(400).json({ error: 'canvases[] is required.' });

  // Replaces the objects of the given canvases and records a complete
  // checkpoint snapshot. Saving edits the WORKING COPY only:
  // it never changes a published version.
  await protocolService.saveCanvases(existing.id, canvases, req.user);
  return res.json(await loadFullProtocol(existing.id, req.user));
}));

// ---------------------------------------------------------------------------
// GET /api/protocols/:id/versions — lightweight version history list
// ---------------------------------------------------------------------------
router.get('/:id/versions', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });
  return res.json(await protocols.listVersionSummaries(existing.id));
}));

// ---------------------------------------------------------------------------
// GET /api/protocols/:id/versions/:version — one full historical snapshot
// ---------------------------------------------------------------------------
router.get('/:id/versions/:version', asyncRoute(async (req, res) => {
  const existing = await findProtocolFor(req.user, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Protocol not found.' });
  const versionNumber = urlVersionNumber(req.params.version);
  const row = versionNumber === null ? null : await protocols.getVersion(existing.id, versionNumber);
  if (!row) return res.status(404).json({ error: 'Version not found.' });
  return res.json({
    version: row.version,
    createdAt: row.created_at,
    snapshot: JSON.parse(row.snapshot_json),
  });
}));

module.exports = router;
