'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { serializeCanvasRow, serializeProtocolRow } = require('../utils/serialize');
const { createProtocolRepository } = require('../repositories/protocols.repo');
const { createUserRepository } = require('../repositories/users.repo');
const asyncRoute = require('../utils/asyncRoute');

const router = express.Router();
const protocols = createProtocolRepository(db);
const users = createUserRepository(db);

// Every route here requires a logged-in patient. Ownership (patient_id
// matching the logged-in user) is checked again on every single query below
// — a patient can never read another patient's protocol by guessing/editing
// an id in the URL, because the SQL itself is scoped to their own id, not
// just a client-side check.
router.use(requireAuth, requireRole('patient'));

async function loadCanvasesForProtocol(protocolId) {
  const canvases = [];
  for (const c of await protocols.getCanvases(protocolId)) {
    canvases.push(serializeCanvasRow(c, await protocols.getObjectsInSavedOrder(c.id)));
  }
  return canvases;
}

// ---------------------------------------------------------------------------
// GET /api/patient/protocols — protocols assigned to the logged-in patient
// ---------------------------------------------------------------------------
router.get('/protocols', asyncRoute(async (req, res) => {
  const rows = await protocols.listForPatient(req.user.id);
  res.json(rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    protocolType: row.protocol_type,
    status: row.status,
    currentVersion: row.current_version,
    doctorName: row.doctor_name,
    updatedAt: row.updated_at,
    // The patient can only ever *start* a protocol once the doctor has
    // marked it active — a draft is a doctor's work-in-progress, not
    // something ready to run against a live camera.
    canStart: row.status === 'active',
  })));
}));

// ---------------------------------------------------------------------------
// GET /api/patient/protocols/:id — full read-only protocol (own only)
// ---------------------------------------------------------------------------
router.get('/protocols/:id', asyncRoute(async (req, res) => {
  const row = await protocols.findForPatient(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Protocol not found.' });
  if (row.status !== 'active') {
    return res.status(403).json({ error: 'This protocol has not been activated by your doctor yet.' });
  }
  const doctor = await users.findById(row.doctor_id);
  const canvases = await loadCanvasesForProtocol(row.id);

  // Reuses the exact same serializer the doctor's builder uses — the patient
  // gets the identical protocol object model (same normalized coordinates,
  // same object shape), never a second/parallel format.
  const protocol = serializeProtocolRow(row, canvases, null);
  protocol.doctorName = doctor ? doctor.name : null;
  return res.json(protocol);
}));

module.exports = router;
