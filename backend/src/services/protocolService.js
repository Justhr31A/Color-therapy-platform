'use strict';

const { v4: uuidv4 } = require('uuid');
const { createProtocolRepository } = require('../repositories/protocols.repo');
const { createCatalogRepository } = require('../repositories/catalog.repo');
const { isUniqueViolation } = require('../db/errors');
const { HAND_ASSETS, HAND_VIEW_ORDER } = require('../config/handAssets');
const { ORGAN_ASSETS } = require('../config/organAssets');
const { serializeCanvasRow } = require('../utils/serialize');
const { OBJECT_TYPES } = require('../protocol/vocabulary');
const { ALL_STATUSES, checkStatusChange, canPublishFrom } = require('../protocol/lifecycle');
const {
  SNAPSHOT_SCHEMA_VERSION, canonicalStringify, sha256Hex, buildSnapshot, contentFingerprint, normalizeSnapshot, verifyChecksum,
} = require('../protocol/snapshot');
const { validateForPublish, LIMITS } = require('../protocol/validation');
const { slugify, isValidSlug, uniqueSlugAsync } = require('./slug');
const { HttpError, badRequest, notFound, conflict, unprocessable } = require('../utils/errors');

const TERM_KINDS = ['keyword', 'synonym', 'phrase'];
const TERM_MAX = 120;
const METADATA_MAX_BYTES = 50000;
const SLUG_UNIQUE_INDEX = 'idx_protocols_slug';
/** Object fields stored in numeric (DOUBLE PRECISION) columns. */
const NUMERIC_OBJECT_FIELDS = ['x', 'y', 'width', 'height', 'rotation', 'thickness', 'opacity', 'zIndex'];

/**
 * SQLite's dynamic typing stored a non-numeric value (e.g. thickness "thick") in a numeric column and the problem only
 * surfaced at publish. PostgreSQL cannot store it, so such a value is refused when the draft is SAVED, with a clear 400.
 * A numeric string ("4") is still accepted and stored as a number, exactly as SQLite's REAL affinity did.
 */
function assertNumericFields(canvasId, o) {
  for (const field of NUMERIC_OBJECT_FIELDS) {
    const v = o[field];
    if (v === undefined || v === null) continue;
    const ok = (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
    if (!ok) throw badRequest(`Object ${o.id || '(new)'} on canvas ${canvasId}: ${field} must be a number.`, { code: 'INVALID_INPUT' });
  }
}

const normalizeTerm = (t) => String(t).trim().toLowerCase().replace(/\s+/g, ' ');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const parseJson = (text, fallback = null) => (text ? JSON.parse(text) : fallback);

/** A slug collision that slipped past the pre-check (two requests racing) still becomes a clean 409. */
function asConflictIfUnique(err) {
  if (isUniqueViolation(err, SLUG_UNIQUE_INDEX)) return conflict('That slug is already in use.', { code: 'SLUG_TAKEN' });
  return err;
}

function parseMetadataInput(input, { partial }) {
  const out = {};
  const text = (value, max, label, { nullable = false } = {}) => {
    if (value === null || value === undefined) return nullable ? null : '';
    if (typeof value !== 'string') throw badRequest(`${label} must be text.`, { code: 'INVALID_INPUT' });
    if (value.length > max) throw badRequest(`${label} must be at most ${max} characters.`, { code: 'INVALID_INPUT' });
    return value;
  };
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim()) throw badRequest('Protocol name is required.', { code: 'INVALID_INPUT' });
    out.name = text(input.name.trim(), LIMITS.NAME, 'Name');
  }
  if (input.displayName !== undefined) {
    const v = text(input.displayName, LIMITS.DISPLAY_NAME, 'Display name', { nullable: true });
    out.displayName = v && v.trim() ? v.trim() : null;
  }
  if (input.shortDescription !== undefined) out.shortDescription = text(input.shortDescription, LIMITS.SHORT_DESCRIPTION, 'Short description');
  if (input.description !== undefined) out.description = text(input.description, LIMITS.DESCRIPTION, 'Description');
  if (input.categoryId !== undefined) out.categoryId = input.categoryId === null ? null : String(input.categoryId);
  if (input.metadata !== undefined) {
    if (input.metadata !== null && !isPlainObject(input.metadata)) throw badRequest('metadata must be a JSON object.', { code: 'INVALID_INPUT' });
    let size;
    try { size = Buffer.byteLength(canonicalStringify(input.metadata || {}), 'utf8'); } catch (e) { throw badRequest('metadata cannot be serialized.', { code: 'INVALID_INPUT' }); }
    if (size > METADATA_MAX_BYTES) throw badRequest(`metadata must be smaller than ${METADATA_MAX_BYTES} bytes.`, { code: 'INVALID_INPUT' });
    out.metadata = input.metadata || {};
  }
  if (input.slug !== undefined) out.slug = input.slug;
  return out;
}

function parseTermInput(input) {
  const raw = typeof input === 'string' ? { term: input } : input;
  if (!raw || typeof raw.term !== 'string' || !raw.term.trim()) throw badRequest('A search term is required.', { code: 'INVALID_INPUT' });
  const term = raw.term.trim().replace(/\s+/g, ' ');
  if (term.length > TERM_MAX) throw badRequest(`A search term must be at most ${TERM_MAX} characters.`, { code: 'INVALID_INPUT' });
  const kind = raw.kind === undefined || raw.kind === null ? 'keyword' : raw.kind;
  if (!TERM_KINDS.includes(kind)) throw badRequest(`kind must be one of: ${TERM_KINDS.join(', ')}.`, { code: 'INVALID_INPUT' });
  return { term, termNormalized: normalizeTerm(term), kind };
}

function serializeVersionMeta(v, protocolRow) {
  return {
    version: v.version,
    kind: v.kind,
    schemaVersion: v.schema_version,
    isCurrentlyPublished: Boolean(protocolRow) && protocolRow.published_version_id === v.id,
    restoredFromVersion: v.restored_from_version,
    createdBy: v.created_by,
    note: v.note,
    checksum: v.checksum,
    createdAt: v.created_at,
  };
}

/**
 * Data-access helpers bound to ONE query executor: the pool for plain reads, or a transaction handle so
 * that every read and write of a multi-step operation happens on the same connection inside the same
 * transaction (a read on another pooled connection would not see the transaction's uncommitted rows).
 */
function createCore(q) {
  const repo = createProtocolRepository(q);
  const catalog = createCatalogRepository(q);

  /**
   * Inside a transaction the protocol row is also LOCKED (FOR UPDATE) until COMMIT/ROLLBACK, so concurrent writes to
   * the same protocol run one after another — exactly as SQLite's single writer did. Without it, two simultaneous saves
   * could compute the same next version number.
   */
  async function mustFind(id) {
    const row = q.inTransaction ? await repo.findByIdForUpdate(id) : await repo.findById(id);
    if (!row) throw notFound('Protocol not found.');
    return row;
  }

  async function loadWorking(protocolId) {
    const protocol = await repo.findById(protocolId);
    if (!protocol) return null;
    const category = protocol.category_id ? (await catalog.findById('category', protocol.category_id)) || null : null;
    const conditions = await repo.listConditions(protocolId);
    const searchTerms = await repo.listTerms(protocolId);
    const canvases = [];
    for (const c of await repo.getCanvases(protocolId)) {
      canvases.push(serializeCanvasRow(c, await repo.getObjects(c.id)));
    }
    return { protocol, category, conditions, searchTerms, canvases };
  }

  async function nextVersionNumber(row) {
    return Math.max(row.current_version, await repo.maxVersion(row.id)) + 1;
  }

  /** Serializes a snapshot and stores it as a new immutable version row. */
  async function storeVersion(protocolId, snapshot, { kind, versionNumber, actorId, restoredFromVersion = null, note = null }) {
    const snapshotJson = canonicalStringify(snapshot);
    const id = uuidv4();
    await repo.insertVersion({
      id, protocolId, version: versionNumber, snapshotJson, kind, schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      createdBy: actorId || null, restoredFromVersion, checksum: sha256Hex(snapshotJson), note,
    });
    return { id, version: versionNumber };
  }

  /** Records the current working copy as a new checkpoint version and advances the version counter. */
  async function checkpoint(protocolId, actorId, { restoredFromVersion = null, note = null } = {}) {
    const row = await mustFind(protocolId);
    const versionNumber = await nextVersionNumber(row);
    const working = await loadWorking(protocolId);
    const snapshot = buildSnapshot(working, { status: row.status, kind: 'checkpoint', versionNumber, restoredFromVersion });
    const stored = await storeVersion(protocolId, snapshot, { kind: 'checkpoint', versionNumber, actorId, restoredFromVersion, note });
    await repo.setCurrentVersion(protocolId, versionNumber);
    return stored;
  }

  /**
   * The very first snapshot of a new protocol is version 1 and does not advance the
   * counter (a new protocol already starts at current_version = 1) — same numbering the
   * builder has always had: create = v1, first save = v2.
   */
  async function initialCheckpoint(protocolId, actorId) {
    const row = await mustFind(protocolId);
    const working = await loadWorking(protocolId);
    const snapshot = buildSnapshot(working, { status: row.status, kind: 'checkpoint', versionNumber: 1 });
    return storeVersion(protocolId, snapshot, { kind: 'checkpoint', versionNumber: 1, actorId });
  }

  /** Editing content while a protocol awaits review sends it back to draft: what was reviewed has changed. */
  async function afterContentEdit(protocolId, actorId, opts) {
    const row = await mustFind(protocolId);
    if (row.status === 'in_review') await repo.updateFields(protocolId, { status: 'draft' });
    return checkpoint(protocolId, actorId, opts);
  }

  async function assertCategoryAssignable(categoryId) {
    if (categoryId === null || categoryId === undefined) return null;
    const cat = await catalog.findById('category', categoryId);
    if (!cat) throw badRequest('That category does not exist.', { code: 'CATEGORY_NOT_FOUND' });
    if (!cat.is_active) throw conflict(`Category "${cat.name}" is inactive.`, { code: 'CATEGORY_INACTIVE' });
    return cat.id;
  }

  async function resolveSlug(explicit, name, exceptId = null) {
    if (q.inTransaction) await repo.lockSlugAllocation(); // concurrent creates get calm, calm-2, ... instead of a conflict
    if (explicit !== undefined && explicit !== null && explicit !== '') {
      if (!isValidSlug(explicit)) throw badRequest('Slug must be lowercase letters, digits and single hyphens (max 80 characters).', { code: 'INVALID_SLUG' });
      if (await repo.slugExists(explicit, exceptId)) throw conflict(`The slug "${explicit}" is already in use.`, { code: 'SLUG_TAKEN' });
      return explicit;
    }
    return uniqueSlugAsync(slugify(name, { fallback: 'protocol' }), (s) => repo.slugExists(s, exceptId));
  }

  async function insertCanvasesFor(protocolId, protocolType, organKeys) {
    if (protocolType === 'hand') {
      for (const [index, viewKey] of HAND_VIEW_ORDER.entries()) {
        const asset = HAND_ASSETS[viewKey];
        await repo.insertCanvas({ id: uuidv4(), protocolId, canvasType: 'hand', viewKey, backgroundAssetKey: asset.key, width: asset.width, height: asset.height, sortOrder: index });
      }
    } else {
      for (const [index, key] of organKeys.entries()) {
        const asset = ORGAN_ASSETS[key];
        await repo.insertCanvas({ id: uuidv4(), protocolId, canvasType: 'organ', viewKey: key, backgroundAssetKey: asset.key, width: asset.width, height: asset.height, sortOrder: index });
      }
    }
  }

  /** Everything an admin/Studio needs about one protocol, including whether the working copy differs from what is published. */
  async function getFull(id) {
    const row = await mustFind(id);
    const working = await loadWorking(id);
    let published = null;
    let hasUnpublishedChanges = false;
    if (row.published_version_id) {
      const v = await repo.getVersionById(row.published_version_id);
      published = { versionId: v.id, version: v.version, publishedAt: row.published_at };
      const pubSnap = normalizeSnapshot(JSON.parse(v.snapshot_json));
      const candidate = buildSnapshot(working, { status: row.status, kind: 'checkpoint', versionNumber: row.current_version });
      hasUnpublishedChanges = pubSnap.schemaVersion >= 2 && contentFingerprint(candidate) !== contentFingerprint(pubSnap);
    }
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      displayName: row.display_name,
      shortDescription: row.short_description,
      description: row.description,
      protocolType: row.protocol_type,
      status: row.status,
      currentVersion: row.current_version,
      ownerId: row.doctor_id,
      categoryId: row.category_id,
      category: working.category ? { id: working.category.id, slug: working.category.slug, name: working.category.name, isActive: working.category.is_active === 1 } : null,
      conditions: working.conditions.map((c) => ({ id: c.id, slug: c.slug, name: c.name, isActive: c.is_active === 1 })),
      searchTerms: working.searchTerms.map((t) => ({ id: t.id, term: t.term, kind: t.kind })),
      metadata: parseJson(row.metadata_json, {}),
      published,
      hasUnpublishedChanges,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      canvases: working.canvases,
    };
  }

  return {
    repo, catalog, mustFind, loadWorking, nextVersionNumber, storeVersion, checkpoint, initialCheckpoint,
    afterContentEdit, assertCategoryAssignable, resolveSlug, insertCanvasesFor, getFull,
  };
}

/**
 * Protocol lifecycle, versioning and publishing. Every method is async (PostgreSQL).
 *
 * MODEL (see docs/PROTOCOL_PUBLISHING.md)
 *  - The rows in protocols/canvases/objects (+ conditions, search terms) are the
 *    editable WORKING COPY.
 *  - protocol_versions holds immutable snapshots ("checkpoints"). Every content
 *    change records one; publishing records one of kind 'published'.
 *  - protocols.published_version_id points at the published snapshot. The public
 *    API reads ONLY that snapshot, so editing the working copy never changes
 *    what the public sees — only an explicit publish does.
 *
 * `db` is the app database or a transaction handle. When it is a transaction handle (a route wrapping
 * several service calls in one transaction), every call below joins that transaction.
 */
function createProtocolService(db) {
  const base = createCore(db);
  const inTransaction = (fn) => db.transaction((tx) => fn(createCore(tx)));

  const service = {
    /**
     * Creates a new DRAFT protocol with its canvases and an initial checkpoint.
     * @returns {Promise<string>} the new protocol id
     */
    async create(input = {}, actor) {
      const meta = parseMetadataInput(input, { partial: false });
      const protocolType = input.protocolType || 'hand';
      if (!['hand', 'organ'].includes(protocolType)) throw badRequest("protocolType must be 'hand' or 'organ'.", { code: 'INVALID_INPUT' });

      let organKeys = [];
      if (protocolType === 'organ') {
        organKeys = Array.isArray(input.organKeys) && input.organKeys.length ? input.organKeys : Object.keys(ORGAN_ASSETS);
        const unknown = organKeys.filter((k) => !ORGAN_ASSETS[k]);
        if (unknown.length) throw badRequest(`Unknown organ asset key(s): ${unknown.join(', ')}`, { code: 'INVALID_INPUT' });
      }
      const conditionIds = input.conditionIds === undefined ? [] : input.conditionIds;
      if (!Array.isArray(conditionIds)) throw badRequest('conditionIds must be a list.', { code: 'INVALID_INPUT' });
      const terms = (input.searchTerms === undefined ? [] : input.searchTerms);
      if (!Array.isArray(terms)) throw badRequest('searchTerms must be a list.', { code: 'INVALID_INPUT' });

      const id = uuidv4();
      try {
        await inTransaction(async (c) => {
          const categoryId = await c.assertCategoryAssignable(meta.categoryId);
          await c.repo.insertProtocol({
            id, name: meta.name, slug: await c.resolveSlug(meta.slug, meta.name), displayName: meta.displayName, shortDescription: meta.shortDescription,
            description: meta.description, categoryId, metadata: meta.metadata, ownerId: actor.id, protocolType,
          });
          await c.insertCanvasesFor(id, protocolType, organKeys);
          for (const conditionId of [...new Set(conditionIds)]) {
            const cond = await c.catalog.findById('condition', conditionId);
            if (!cond) throw badRequest(`Condition ${conditionId} does not exist.`, { code: 'CONDITION_NOT_FOUND' });
            if (!cond.is_active) throw conflict(`Condition "${cond.name}" is inactive.`, { code: 'CONDITION_INACTIVE' });
            await c.repo.link(cond.id, id);
          }
          const seen = new Set();
          for (const t of terms.map(parseTermInput)) {
            if (seen.has(t.termNormalized)) continue;
            seen.add(t.termNormalized);
            await c.repo.insertTerm({ id: uuidv4(), protocolId: id, ...t });
          }
          await c.initialCheckpoint(id, actor.id);
        });
      } catch (err) { throw asConflictIfUnique(err); }
      return id;
    },

    /** Updates descriptive metadata (never status, never the published pointer). A slug changes ONLY if `slug` is in the request. */
    async updateMetadata(id, patch = {}, actor) {
      await base.mustFind(id);
      const meta = parseMetadataInput(patch, { partial: true });
      try {
        await inTransaction(async (c) => {
          const row = await c.mustFind(id);
          const fields = {};
          if (meta.name !== undefined) fields.name = meta.name;
          if (meta.displayName !== undefined) fields.display_name = meta.displayName;
          if (meta.shortDescription !== undefined) fields.short_description = meta.shortDescription;
          if (meta.description !== undefined) fields.description = meta.description;
          if (meta.metadata !== undefined) fields.metadata_json = JSON.stringify(meta.metadata);
          if (meta.categoryId !== undefined) fields.category_id = meta.categoryId === row.category_id ? row.category_id : await c.assertCategoryAssignable(meta.categoryId);
          if (meta.slug !== undefined && meta.slug !== row.slug) fields.slug = await c.resolveSlug(meta.slug, row.name, id);
          await c.repo.updateFields(id, fields);
          await c.afterContentEdit(id, actor && actor.id);
        });
      } catch (err) { throw asConflictIfUnique(err); }
      return base.getFull(id);
    },

    /**
     * Plain status change (draft / in_review / archived, plus legacy 'active' when allowed).
     * 'published' is refused here: only publish() can make a protocol published.
     */
    async changeStatus(id, to, { allowLegacy = false } = {}) {
      const row = await base.mustFind(id);
      const verdict = checkStatusChange(row.status, to, { allowLegacy });
      if (!verdict.ok) {
        throw new HttpError(verdict.code === 'INVALID_TRANSITION' ? 409 : 400, verdict.reason, { code: verdict.code });
      }
      if (row.status !== to) await base.repo.updateFields(id, { status: to });
      return base.getFull(id);
    },

    /** Takes a protocol out of public view. Its history and last published version are kept. */
    archive(id) {
      return service.changeStatus(id, 'archived');
    },

    /**
     * PUBLISH — all or nothing:
     *   1. validate the exact snapshot that would be frozen (422 with every problem if invalid)
     *   2. store it as a new immutable version of kind 'published'
     *   3. point protocols.published_version_id at it and set status = 'published' (one UPDATE)
     * Any failure rolls the whole thing back; the previous public version stays live.
     */
    async publish(id, actor, { note = null } = {}) {
      if (note !== null && (typeof note !== 'string' || note.length > 500)) throw badRequest('note must be text of at most 500 characters.', { code: 'INVALID_INPUT' });
      return inTransaction(async (c) => {
        const row = await c.mustFind(id);
        if (!canPublishFrom(row.status)) throw conflict(`A protocol with status "${row.status}" cannot be published. Move it back to draft first.`, { code: 'INVALID_TRANSITION' });

        const working = await c.loadWorking(id);
        const versionNumber = await c.nextVersionNumber(row);
        const snapshot = buildSnapshot(working, { status: 'published', kind: 'published', versionNumber });

        const errors = validateForPublish(working, snapshot);
        if (errors.length) {
          throw unprocessable('The protocol failed validation and was not published.', { code: 'VALIDATION_FAILED', details: errors });
        }

        const stored = await c.storeVersion(id, snapshot, { kind: 'published', versionNumber, actorId: actor && actor.id, note });
        await c.repo.markPublished(id, stored.id, versionNumber);
        return { protocolId: id, versionId: stored.id, version: versionNumber };
      });
    },

    /**
     * Legacy builder save: replaces the objects of the given canvases, then records a checkpoint.
     * Behaviour (validation messages, defaults, version numbering) matches the original endpoint.
     */
    async saveCanvases(id, canvases, actor) {
      if (!Array.isArray(canvases)) throw badRequest('canvases[] is required.');
      const row = await base.mustFind(id);
      const owned = new Set((await base.repo.getCanvases(row.id)).map((c) => c.id));
      for (const c of canvases) {
        if (!owned.has(c.id)) throw badRequest(`Canvas ${c.id} does not belong to this protocol.`);
        if (!Array.isArray(c.objects)) throw badRequest(`Canvas ${c.id} is missing objects[].`);
        for (const o of c.objects) {
          if (!OBJECT_TYPES.includes(o.type)) throw badRequest(`Unknown object type "${o.type}".`);
          assertNumericFields(c.id, o);
        }
      }
      await inTransaction(async (c) => {
        await c.mustFind(row.id); // lock first: concurrent saves of one protocol are serialised
        for (const canvas of canvases) {
          await c.repo.deleteObjectsOfCanvas(canvas.id);
          await c.repo.insertObjects(canvas.id, canvas.objects, 0);
        }
        await c.afterContentEdit(row.id, actor && actor.id);
      });
    },

    /** Deep copy as a brand-new DRAFT: new ids everywhere, new slug, no published pointer, no patient. */
    async duplicate(id, actor) {
      const source = await base.mustFind(id);
      const newId = uuidv4();
      try {
        await inTransaction(async (c) => {
          const working = await c.loadWorking(id);
          const name = `${source.name} (Copy)`;
          await c.repo.insertProtocol({
            id: newId, name, slug: await c.resolveSlug(undefined, name),
            displayName: source.display_name ? `${source.display_name} (Copy)` : null,
            shortDescription: source.short_description, description: source.description,
            categoryId: source.category_id, metadata: parseJson(source.metadata_json), ownerId: actor.id, protocolType: source.protocol_type,
          });
          for (const canvas of working.canvases) {
            const newCanvasId = uuidv4();
            await c.repo.insertCanvas({
              id: newCanvasId, protocolId: newId, canvasType: canvas.canvasType, viewKey: canvas.viewKey, backgroundAssetKey: canvas.backgroundAssetKey,
              width: canvas.width, height: canvas.height, sortOrder: canvas.sortOrder,
            });
            await c.repo.insertObjects(newCanvasId, canvas.objects.map((o) => ({ ...o, id: uuidv4() })), 0); // fresh id per object
          }
          for (const cond of working.conditions) await c.repo.link(cond.id, newId);
          for (const t of working.searchTerms) {
            await c.repo.insertTerm({ id: uuidv4(), protocolId: newId, term: t.term, termNormalized: t.term_normalized, kind: t.kind });
          }
          await c.initialCheckpoint(newId, actor.id);
        });
      } catch (err) { throw asConflictIfUnique(err); }
      return newId;
    },

    // ----------------------------------------------------------- versions
    async listVersions(id) {
      const row = await base.mustFind(id);
      return (await base.repo.listVersions(id)).map((v) => serializeVersionMeta(v, row));
    },

    async getVersion(id, versionNumber) {
      const row = await base.mustFind(id);
      const v = await base.repo.getVersion(id, versionNumber);
      if (!v) throw notFound('Version not found.');
      return {
        ...serializeVersionMeta(v, row),
        integrity: { checksum: v.checksum, valid: verifyChecksum(v.snapshot_json, v.checksum) },
        snapshot: normalizeSnapshot(JSON.parse(v.snapshot_json)),
      };
    },

    /**
     * Restore = copy an old snapshot INTO the editable working copy and record that as a NEW checkpoint.
     * The historical version row is never touched, and the published version is unaffected
     * (a published protocol simply gains "unpublished changes" until it is published again).
     * Slug, lifecycle status and the published pointer are not restored.
     */
    async restoreVersion(id, versionNumber, actor) {
      return inTransaction(async (c) => {
        const row = await c.mustFind(id);
        if (row.status === 'archived') throw conflict('Move an archived protocol back to draft before restoring a version.', { code: 'INVALID_TRANSITION' });
        const v = await c.repo.getVersion(id, versionNumber);
        if (!v) throw notFound('Version not found.');
        if (!verifyChecksum(v.snapshot_json, v.checksum)) throw new HttpError(500, 'That version failed its integrity check and was not restored.', { code: 'INTEGRITY_ERROR' });

        const snap = normalizeSnapshot(JSON.parse(v.snapshot_json));
        const liveCanvases = await c.repo.getCanvases(id);
        const liveViewKeys = new Set(liveCanvases.map((lc) => lc.view_key));
        const missing = snap.canvases.filter((sc) => !liveViewKeys.has(sc.viewKey)).map((sc) => sc.viewKey);
        if (missing.length) throw conflict(`That version contains view(s) this protocol no longer has: ${missing.join(', ')}.`, { code: 'VERSION_INCOMPATIBLE' });

        const warnings = [];
        // canvases + objects (object ids are preserved; a canvas absent from the snapshot ends up empty)
        for (const live of liveCanvases) {
          const fromSnap = snap.canvases.find((sc) => sc.viewKey === live.view_key);
          await c.repo.deleteObjectsOfCanvas(live.id);
          await c.repo.insertObjects(live.id, fromSnap ? fromSnap.objects : [], 0);
        }

        if (snap.schemaVersion >= 2) {
          const p = snap.protocol;
          const fields = {
            name: p.name, display_name: p.displayName, short_description: p.shortDescription, description: p.description,
            metadata_json: JSON.stringify(p.metadata || {}),
          };
          const cat = p.category ? await c.catalog.findById('category', p.category.id) : null;
          fields.category_id = cat && cat.is_active ? cat.id : null;
          if (p.category && !(cat && cat.is_active)) warnings.push(`Category "${p.category.name}" no longer exists or is inactive, so the category was cleared.`);
          await c.repo.updateFields(id, fields);

          await c.repo.unlinkAll(id);
          for (const cond of p.conditions) {
            const live = await c.catalog.findById('condition', cond.id);
            if (live && live.is_active) await c.repo.link(live.id, id);
            else warnings.push(`Condition "${cond.name}" no longer exists or is inactive, so it was not re-attached.`);
          }
          await c.repo.deleteAllTerms(id);
          for (const t of p.searchTerms) {
            await c.repo.insertTerm({ id: uuidv4(), protocolId: id, term: t.term, termNormalized: normalizeTerm(t.term), kind: t.kind });
          }
        } else {
          warnings.push('This version predates full snapshots: only views and markings were restored (metadata, conditions and search terms were left as they are).');
        }

        const created = await c.afterContentEdit(id, actor && actor.id, { restoredFromVersion: v.version });
        return { protocolId: id, restoredFromVersion: v.version, newVersion: created.version, warnings };
      });
    },

    // ------------------------------------------------------- search terms
    async listTerms(id) {
      await base.mustFind(id);
      return (await base.repo.listTerms(id)).map((t) => ({ id: t.id, term: t.term, kind: t.kind, createdAt: t.created_at }));
    },
    async addTerm(id, input, actor) {
      await base.mustFind(id);
      const t = parseTermInput(input);
      return inTransaction(async (c) => {
        await c.mustFind(id);
        if (await c.repo.findTerm(id, t.termNormalized)) throw conflict(`"${t.term}" is already a search term of this protocol.`, { code: 'TERM_EXISTS' });
        const termId = uuidv4();
        await c.repo.insertTerm({ id: termId, protocolId: id, ...t });
        await c.afterContentEdit(id, actor && actor.id);
        return { id: termId, term: t.term, kind: t.kind };
      });
    },
    async removeTerm(id, termId, actor) {
      await base.mustFind(id);
      await inTransaction(async (c) => {
        await c.mustFind(id);
        if (!(await c.repo.deleteTerm(id, termId))) throw notFound('Search term not found.');
        await c.afterContentEdit(id, actor && actor.id);
      });
    },

    // -------------------------------------------------- condition ↔ protocol
    async attachCondition(conditionId, protocolId, actor) {
      await inTransaction(async (c) => {
        const cond = await c.catalog.findById('condition', conditionId);
        if (!cond) throw notFound('Condition not found.');
        await c.mustFind(protocolId);
        if (!cond.is_active) throw conflict(`Condition "${cond.name}" is inactive.`, { code: 'CONDITION_INACTIVE' });
        if (await c.repo.isLinked(conditionId, protocolId)) throw conflict('That protocol is already attached to this condition.', { code: 'ALREADY_ATTACHED' });
        await c.repo.link(conditionId, protocolId);
        await c.afterContentEdit(protocolId, actor && actor.id);
      });
    },
    async detachCondition(conditionId, protocolId, actor) {
      await inTransaction(async (c) => {
        if (!(await c.catalog.findById('condition', conditionId))) throw notFound('Condition not found.');
        await c.mustFind(protocolId);
        if (!(await c.repo.unlink(conditionId, protocolId))) throw notFound('That protocol is not attached to this condition.');
        await c.afterContentEdit(protocolId, actor && actor.id);
      });
    },

    // ------------------------------------------------------------ deletion
    /** Only protocols that were never published can be deleted; the rest must be archived (history is kept). */
    async remove(id) {
      const row = await base.mustFind(id);
      if (row.published_version_id) throw conflict('This protocol has been published and cannot be deleted. Archive it instead.', { code: 'PUBLISHED_PROTOCOL' });
      await base.repo.deleteProtocol(id);
    },

    // -------------------------------------------------------------- reading
    getFull(id) {
      return base.getFull(id);
    },

    async list({ status, categoryId, q, limit = 50, offset = 0 } = {}) {
      if (status && !ALL_STATUSES.includes(status)) throw badRequest(`Unknown status "${status}".`, { code: 'INVALID_INPUT' });
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
      const off = Math.max(parseInt(offset, 10) || 0, 0);
      const { rows, total } = await base.repo.listAdmin({ status, categoryId, q: q ? String(q).slice(0, 100) : null, limit: lim, offset: off });
      return {
        total, limit: lim, offset: off,
        items: rows.map((r) => ({
          id: r.id, slug: r.slug, name: r.name, displayName: r.display_name, protocolType: r.protocol_type, status: r.status,
          categoryId: r.category_id, currentVersion: r.current_version,
          publishedVersionId: r.published_version_id, publishedVersion: r.published_version_number ?? null, publishedAt: r.published_at,
          conditionCount: r.condition_count, searchTermCount: r.term_count, ownerId: r.doctor_id,
          createdAt: r.created_at, updatedAt: r.updated_at,
        })),
      };
    },
  };
  return service;
}

module.exports = { createProtocolService, normalizeTerm };
