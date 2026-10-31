'use strict';

const { v4: uuidv4 } = require('uuid');
const { canonicalFinger } = require('../protocol/vocabulary');
const { NOW_UTC } = require('../db/openPostgres');

const OBJECT_COLUMNS = ['id', 'canvas_id', 'object_type', 'x', 'y', 'width', 'height', 'rotation', 'color', 'thickness', 'opacity',
  'points_json', 'finger', 'landmark_json', 'metadata_json', 'z_index'];
const OBJECT_INSERT_CHUNK = 500; // 16 params per row, well under PostgreSQL's 65535-parameter limit
const SLUG_LOCK_KEY = 728462; // advisory lock id for protocol slug allocation

/**
 * All SQL for protocols, their canvases/objects, versions, search terms and condition links.
 * Async PostgreSQL. `db` is the app database or a transaction handle; transactions are opened by the
 * SERVICE (or route) layer, never here.
 */
function createProtocolRepository(db) {
  const EDITABLE_COLUMNS = ['name', 'slug', 'display_name', 'short_description', 'description', 'category_id', 'metadata_json', 'status'];
  const one = async (sql, values = []) => (await db.query(sql, values)).rows[0] || null;
  const many = async (sql, values = []) => (await db.query(sql, values)).rows;
  const run = (sql, values = []) => db.query(sql, values);

  /**
   * One object in API/snapshot shape -> column values. The defaults are the ones the builder's save endpoint
   * has always applied — do not change them without checking existing saves.
   */
  // A numeric string is stored as the number it spells (SQLite REAL affinity did the same).
  const num = (v) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
  const objectValues = (canvasId, o, index) => [
    o.id || uuidv4(), canvasId, o.type, num(o.x ?? 0), num(o.y ?? 0), num(o.width ?? null), num(o.height ?? null), num(o.rotation ?? 0),
    o.color || '#e5484d', num(o.thickness ?? 3), num(o.opacity ?? 1),
    o.points ? JSON.stringify(o.points) : null,
    canonicalFinger(o.finger),
    o.landmarkReference ? JSON.stringify(o.landmarkReference) : null,
    o.metadata ? JSON.stringify(o.metadata) : null,
    num(o.zIndex ?? index),
  ];

  const repo = {
    // ------------------------------------------------------------ protocols
    findById: (id) => one('SELECT * FROM protocols WHERE id = $1', [id]),
    /** Same row, locked until the surrounding transaction ends: writes to one protocol are serialised (as under SQLite). */
    findByIdForUpdate: (id) => one('SELECT * FROM protocols WHERE id = $1 FOR UPDATE', [id]),
    /** Serialises slug allocation (check-then-insert) across concurrent transactions; released at COMMIT/ROLLBACK. */
    async lockSlugAllocation() { await run('SELECT pg_advisory_xact_lock($1)', [SLUG_LOCK_KEY]); },
    findBySlug: (slug) => one('SELECT * FROM protocols WHERE slug = $1', [slug]),
    async slugExists(slug, exceptId = null) {
      const row = exceptId
        ? await one('SELECT 1 AS x FROM protocols WHERE slug = $1 AND id <> $2', [slug, exceptId])
        : await one('SELECT 1 AS x FROM protocols WHERE slug = $1', [slug]);
      return Boolean(row);
    },
    async insertProtocol(p) {
      await run(
        `INSERT INTO protocols
           (id, name, slug, display_name, short_description, description, category_id, metadata_json,
            doctor_id, patient_id, protocol_type, status, current_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, 'draft', 1)`,
        [p.id, p.name, p.slug, p.displayName ?? null, p.shortDescription ?? '', p.description ?? '', p.categoryId ?? null,
          p.metadata ? JSON.stringify(p.metadata) : null, p.ownerId, p.protocolType]
      );
    },
    /** `fields` uses column names; only whitelisted columns are ever written. Always bumps updated_at. */
    async updateFields(id, fields) {
      const cols = Object.keys(fields);
      const bad = cols.filter((c) => !EDITABLE_COLUMNS.includes(c));
      if (bad.length) throw new Error(`Refusing to update non-editable column(s): ${bad.join(', ')}`);
      if (!cols.length) return;
      const values = cols.map((c) => fields[c]);
      values.push(id);
      const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      await run(`UPDATE protocols SET ${set}, updated_at = ${NOW_UTC} WHERE id = $${values.length}`, values);
    },
    async setCurrentVersion(id, versionNumber) {
      await run(`UPDATE protocols SET current_version = $1, updated_at = ${NOW_UTC} WHERE id = $2`, [versionNumber, id]);
    },
    async touch(id) {
      await run(`UPDATE protocols SET updated_at = ${NOW_UTC} WHERE id = $1`, [id]);
    },
    /** One statement, so status and pointer change together (the table CHECK requires it). */
    async markPublished(id, versionId, versionNumber) {
      await run(
        `UPDATE protocols
            SET status = 'published', published_version_id = $1, published_at = ${NOW_UTC},
                current_version = $2, updated_at = ${NOW_UTC}
          WHERE id = $3`,
        [versionId, versionNumber, id]
      );
    },
    async assignPatient(id, patientId) {
      await run(`UPDATE protocols SET patient_id = $1, updated_at = ${NOW_UTC} WHERE id = $2`, [patientId, id]);
    },
    async deleteProtocol(id) {
      await run('DELETE FROM protocols WHERE id = $1', [id]);
    },
    /** Builder list: every protocol (admin) or one doctor's own, most recently changed first. */
    listForBuilder: (doctorId = null) => (doctorId
      ? many('SELECT * FROM protocols WHERE doctor_id = $1 ORDER BY updated_at DESC, id COLLATE "C" ASC', [doctorId])
      : many('SELECT * FROM protocols ORDER BY updated_at DESC, id COLLATE "C" ASC')),
    listForPatient: (patientId) => many(
      `SELECT p.*, u.name AS doctor_name
         FROM protocols p JOIN users u ON u.id = p.doctor_id
        WHERE p.patient_id = $1
        ORDER BY p.updated_at DESC, p.id COLLATE "C" ASC`,
      [patientId]
    ),
    findForPatient: (id, patientId) => one('SELECT * FROM protocols WHERE id = $1 AND patient_id = $2', [id, patientId]),
    async countCanvases(protocolId) {
      return (await one('SELECT COUNT(*)::integer AS c FROM canvases WHERE protocol_id = $1', [protocolId])).c;
    },
    async listAdmin({ status, categoryId, q, limit, offset }) {
      const where = [];
      const values = [];
      const param = (v) => { values.push(v); return `$${values.length}`; };
      if (status) where.push(`p.status = ${param(status)}`);
      if (categoryId) where.push(`p.category_id = ${param(categoryId)}`);
      if (q) {
        const like = `%${String(q).toLowerCase()}%`;
        where.push(`(lower(p.name) LIKE ${param(like)} OR lower(p.slug) LIKE ${param(like)} OR lower(COALESCE(p.display_name, '')) LIKE ${param(like)})`);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (await one(`SELECT COUNT(*)::integer AS c FROM protocols p ${clause}`, values)).c;
      const rows = await many(
        `SELECT p.*, pv.version AS published_version_number,
                (SELECT COUNT(*)::integer FROM condition_protocols cp WHERE cp.protocol_id = p.id) AS condition_count,
                (SELECT COUNT(*)::integer FROM protocol_search_terms t WHERE t.protocol_id = p.id) AS term_count
           FROM protocols p LEFT JOIN protocol_versions pv ON pv.id = p.published_version_id
           ${clause}
          ORDER BY p.updated_at DESC, p.id COLLATE "C" ASC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );
      return { rows, total };
    },

    // ------------------------------------------------------ canvases/objects
    getCanvases: (protocolId) => many('SELECT * FROM canvases WHERE protocol_id = $1 ORDER BY sort_order ASC, id COLLATE "C" ASC', [protocolId]),
    /** Snapshot/service order (deterministic: ties on z_index broken by id). */
    getObjects: (canvasId) => many('SELECT * FROM objects WHERE canvas_id = $1 ORDER BY z_index ASC, id COLLATE "C" ASC', [canvasId]),
    /** Builder/patient order (ties on z_index kept in the order the objects were saved, as SQLite's rowid did). */
    getObjectsInSavedOrder: (canvasId) => many('SELECT * FROM objects WHERE canvas_id = $1 ORDER BY z_index ASC, insert_seq ASC', [canvasId]),
    async insertCanvas(c) {
      await run(
        `INSERT INTO canvases (id, protocol_id, canvas_type, view_key, background_asset_key, width, height, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [c.id, c.protocolId, c.canvasType, c.viewKey, c.backgroundAssetKey, c.width, c.height, c.sortOrder]
      );
    },
    async deleteObjectsOfCanvas(canvasId) {
      await run('DELETE FROM objects WHERE canvas_id = $1', [canvasId]);
    },
    async insertObject(canvasId, o, index = 0) {
      await repo.insertObjects(canvasId, [o], index);
    },
    /** Inserts objects in order (multi-row INSERT, chunked). `firstIndex` is the default z_index of the first one. */
    async insertObjects(canvasId, objects, firstIndex = 0) {
      for (let start = 0; start < objects.length; start += OBJECT_INSERT_CHUNK) {
        const chunk = objects.slice(start, start + OBJECT_INSERT_CHUNK);
        const values = [];
        const tuples = chunk.map((o, i) => {
          const row = objectValues(canvasId, o, firstIndex + start + i);
          const base = values.length;
          values.push(...row);
          return `(${row.map((_, k) => `$${base + k + 1}`).join(', ')})`;
        });
        // eslint-disable-next-line no-await-in-loop
        await run(`INSERT INTO objects (${OBJECT_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`, values);
      }
    },

    // -------------------------------------------------------------- versions
    async insertVersion(v) {
      await run(
        `INSERT INTO protocol_versions
           (id, protocol_id, version, snapshot_json, kind, schema_version, created_by, restored_from_version, checksum, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [v.id, v.protocolId, v.version, v.snapshotJson, v.kind, v.schemaVersion, v.createdBy ?? null, v.restoredFromVersion ?? null, v.checksum, v.note ?? null]
      );
    },
    getVersion: (protocolId, versionNumber) => one('SELECT * FROM protocol_versions WHERE protocol_id = $1 AND version = $2', [protocolId, versionNumber]),
    async maxVersion(protocolId) {
      const r = await one('SELECT MAX(version)::integer AS m FROM protocol_versions WHERE protocol_id = $1', [protocolId]);
      return r && r.m ? r.m : 0;
    },
    getVersionById: (id) => one('SELECT * FROM protocol_versions WHERE id = $1', [id]),
    listVersions: (protocolId) => many(
      `SELECT id, version, kind, schema_version, created_by, restored_from_version, checksum, note, created_at
         FROM protocol_versions WHERE protocol_id = $1 ORDER BY version DESC`,
      [protocolId]
    ),

    // ---------------------------------------------------------- search terms
    listTerms: (protocolId) => many('SELECT * FROM protocol_search_terms WHERE protocol_id = $1 ORDER BY term_normalized COLLATE "C" ASC', [protocolId]),
    findTerm: (protocolId, termNormalized) => one('SELECT * FROM protocol_search_terms WHERE protocol_id = $1 AND term_normalized = $2', [protocolId, termNormalized]),
    async insertTerm(t) {
      await run('INSERT INTO protocol_search_terms (id, protocol_id, term, term_normalized, kind) VALUES ($1, $2, $3, $4, $5)',
        [t.id, t.protocolId, t.term, t.termNormalized, t.kind]);
    },
    async deleteTerm(protocolId, termId) {
      return (await run('DELETE FROM protocol_search_terms WHERE protocol_id = $1 AND id = $2', [protocolId, termId])).rowCount;
    },
    async deleteAllTerms(protocolId) {
      await run('DELETE FROM protocol_search_terms WHERE protocol_id = $1', [protocolId]);
    },

    // ------------------------------------------------------ condition links
    listConditions: (protocolId) => many(
      `SELECT c.* FROM conditions c JOIN condition_protocols cp ON cp.condition_id = c.id
        WHERE cp.protocol_id = $1 ORDER BY c.slug COLLATE "C" ASC`,
      [protocolId]
    ),
    async isLinked(conditionId, protocolId) {
      return Boolean(await one('SELECT 1 AS x FROM condition_protocols WHERE condition_id = $1 AND protocol_id = $2', [conditionId, protocolId]));
    },
    async link(conditionId, protocolId) {
      await run('INSERT INTO condition_protocols (condition_id, protocol_id) VALUES ($1, $2)', [conditionId, protocolId]);
    },
    async unlink(conditionId, protocolId) {
      return (await run('DELETE FROM condition_protocols WHERE condition_id = $1 AND protocol_id = $2', [conditionId, protocolId])).rowCount;
    },
    async unlinkAll(protocolId) {
      await run('DELETE FROM condition_protocols WHERE protocol_id = $1', [protocolId]);
    },

    // -------------------------------------------------------- public reading
    /** Published protocols with the frozen snapshot of their published version (nothing from editable rows). */
    listPublishedWithVersions: () => many(
      `SELECT p.id, p.slug, p.published_at, v.version, v.checksum, v.snapshot_json
         FROM protocols p JOIN protocol_versions v ON v.id = p.published_version_id
        WHERE p.status = 'published'
        ORDER BY p.slug COLLATE "C" ASC`
    ),
    findPublishedBySlug: (slug) => one(
      `SELECT p.id, p.slug, p.published_at, p.status, v.id AS version_id, v.version, v.kind, v.checksum, v.snapshot_json, v.protocol_id
         FROM protocols p JOIN protocol_versions v ON v.id = p.published_version_id
        WHERE p.slug = $1 AND p.status = 'published'`,
      [slug]
    ),
    /** Lightweight history for the builder (number + time only). */
    listVersionSummaries: (protocolId) => many('SELECT version, created_at FROM protocol_versions WHERE protocol_id = $1 ORDER BY version DESC', [protocolId]),
  };
  return repo;
}

module.exports = { createProtocolRepository };
