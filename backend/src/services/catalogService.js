'use strict';

const { v4: uuidv4 } = require('uuid');
const { createCatalogRepository } = require('../repositories/catalog.repo');
const { isUniqueViolation } = require('../db/errors');
const { slugify, isValidSlug, uniqueSlugAsync } = require('./slug');
const { badRequest, notFound, conflict } = require('../utils/errors');

const NAME_MAX = 120;
const DESCRIPTION_MAX = 5000;
const SYNONYM_MAX = 80;
const SYNONYMS_MAX_COUNT = 30;
// Advisory locks serialising slug allocation (check-then-insert) for concurrent creates; held until COMMIT/ROLLBACK.
const CATEGORY_SLUG_LOCK = 728463;
const CONDITION_SLUG_LOCK = 728464;

const serializeCategory = (r) => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  description: r.description,
  isActive: Number(r.is_active) === 1,
  sortOrder: r.sort_order,
  ...(r.protocol_count !== undefined ? { protocolCount: r.protocol_count, conditionCount: r.condition_count } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const serializeCondition = (r) => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  description: r.description,
  categoryId: r.category_id,
  isActive: Number(r.is_active) === 1,
  synonyms: (() => { try { return JSON.parse(r.synonyms_json || '[]'); } catch (e) { return []; } })(),
  ...(r.protocol_count !== undefined ? { protocolCount: r.protocol_count } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function requireName(value) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest('Name is required.', { code: 'INVALID_INPUT' });
  const name = value.trim();
  if (name.length > NAME_MAX) throw badRequest(`Name must be at most ${NAME_MAX} characters.`, { code: 'INVALID_INPUT' });
  return name;
}
function optionalDescription(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest('Description must be text.', { code: 'INVALID_INPUT' });
  if (value.length > DESCRIPTION_MAX) throw badRequest(`Description must be at most ${DESCRIPTION_MAX} characters.`, { code: 'INVALID_INPUT' });
  return value;
}

/**
 * Search terms / synonyms for a CONDITION (distinct from a protocol's own `protocol_search_terms` — see
 * migration 006's comment for why this is a plain JSON array rather than a second table). Accepts an array of
 * strings, trims each, drops empties, case-insensitively dedupes, and caps both the length of any one synonym
 * and how many can be stored — the same shape of limit `protocol_search_terms` enforces at the database/route
 * layer, just applied here since there is no separate table to constrain it.
 */
function optionalSynonyms(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('synonyms must be an array of strings.', { code: 'INVALID_INPUT' });
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw badRequest('Each synonym must be text.', { code: 'INVALID_INPUT' });
    const s = raw.trim();
    if (!s) continue;
    if (s.length > SYNONYM_MAX) throw badRequest(`Each synonym must be at most ${SYNONYM_MAX} characters.`, { code: 'INVALID_INPUT' });
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  if (out.length > SYNONYMS_MAX_COUNT) throw badRequest(`At most ${SYNONYMS_MAX_COUNT} synonyms are allowed.`, { code: 'INVALID_INPUT' });
  return out;
}

/** A database uniqueness violation that slipped past the pre-check (two requests racing) still becomes a clean 409. */
function asConflictIfUnique(err, what) {
  if (isUniqueViolation(err)) return conflict(`${what} already exists.`, { code: 'SLUG_TAKEN' });
  return err;
}

/** `db` is the PostgreSQL app database (or a transaction handle). Every method is async. */
function createCatalogService(db) {
  const repo = createCatalogRepository(db);

  /**
   * Explicit slug -> must be valid and free (else 400 / 409: never silently altered).
   * No slug given -> derived from the name, with a numeric suffix if taken.
   */
  async function resolveSlug(kind, name, explicit, exceptId = null, r = repo) {
    if (explicit !== undefined && explicit !== null && explicit !== '') {
      if (!isValidSlug(explicit)) throw badRequest('Slug must be lowercase letters, digits and single hyphens (max 80 characters).', { code: 'INVALID_SLUG' });
      if (await r.slugExists(kind, explicit, exceptId)) throw conflict(`The slug "${explicit}" is already in use.`, { code: 'SLUG_TAKEN' });
      return explicit;
    }
    return uniqueSlugAsync(slugify(name, { fallback: kind }), (s) => r.slugExists(kind, s, exceptId));
  }

  async function mustFind(kind, id) {
    const row = await repo.findById(kind, id);
    if (!row) throw notFound(kind === 'category' ? 'Category not found.' : 'Condition not found.');
    return row;
  }

  async function checkCategoryRef(categoryId) {
    if (categoryId === null || categoryId === undefined) return null;
    const row = await repo.findById('category', categoryId);
    if (!row) throw badRequest('That category does not exist.', { code: 'CATEGORY_NOT_FOUND' });
    return row.id;
  }

  return {
    // ------------------------------------------------------------ categories
    async listCategories() {
      return (await repo.listCategories()).map(serializeCategory);
    },
    async getCategory(id) {
      return serializeCategory(await mustFind('category', id));
    },
    async createCategory(input = {}) {
      const name = requireName(input.name);
      const description = optionalDescription(input.description);
      const sortOrder = input.sortOrder === undefined ? 0 : input.sortOrder;
      if (!Number.isInteger(sortOrder)) throw badRequest('sortOrder must be a whole number.', { code: 'INVALID_INPUT' });
      const id = uuidv4();
      try {
        await db.transaction(async (tx) => {
          const txRepo = createCatalogRepository(tx);
          await tx.query('SELECT pg_advisory_xact_lock($1)', [CATEGORY_SLUG_LOCK]);
          const slug = await resolveSlug('category', name, input.slug, null, txRepo);
          await txRepo.insertCategory({ id, name, slug, description, isActive: input.isActive !== false, sortOrder });
        });
      } catch (err) { throw asConflictIfUnique(err, 'A category with that slug'); }
      return serializeCategory(await repo.findById('category', id));
    },
    async updateCategory(id, patch = {}) {
      const existing = await mustFind('category', id);
      const fields = {};
      if (patch.name !== undefined) fields.name = requireName(patch.name);
      if (patch.description !== undefined) fields.description = optionalDescription(patch.description);
      if (patch.sortOrder !== undefined) {
        if (!Number.isInteger(patch.sortOrder)) throw badRequest('sortOrder must be a whole number.', { code: 'INVALID_INPUT' });
        fields.sort_order = patch.sortOrder;
      }
      // Renaming never touches the slug; only an explicit slug in the request changes it.
      if (patch.slug !== undefined && patch.slug !== existing.slug) fields.slug = await resolveSlug('category', existing.name, patch.slug, id);
      try { await repo.updateCategory(id, fields); } catch (err) { throw asConflictIfUnique(err, 'A category with that slug'); }
      return serializeCategory(await repo.findById('category', id));
    },
    async setCategoryActive(id, isActive) {
      await mustFind('category', id);
      await repo.setActive('category', id, isActive);
      return serializeCategory(await repo.findById('category', id));
    },

    // ------------------------------------------------------------ conditions
    async listConditions(filter = {}) {
      return (await repo.listConditions(filter)).map(serializeCondition);
    },
    async getCondition(id) {
      return serializeCondition(await mustFind('condition', id));
    },
    async createCondition(input = {}) {
      const name = requireName(input.name);
      const description = optionalDescription(input.description);
      const categoryId = await checkCategoryRef(input.categoryId);
      const synonymsJson = JSON.stringify(optionalSynonyms(input.synonyms));
      const id = uuidv4();
      try {
        await db.transaction(async (tx) => {
          const txRepo = createCatalogRepository(tx);
          await tx.query('SELECT pg_advisory_xact_lock($1)', [CONDITION_SLUG_LOCK]);
          const slug = await resolveSlug('condition', name, input.slug, null, txRepo);
          await txRepo.insertCondition({ id, name, slug, description, categoryId, isActive: input.isActive !== false, synonymsJson });
        });
      } catch (err) { throw asConflictIfUnique(err, 'A condition with that slug'); }
      return serializeCondition(await repo.findById('condition', id));
    },
    async updateCondition(id, patch = {}) {
      const existing = await mustFind('condition', id);
      const fields = {};
      if (patch.name !== undefined) fields.name = requireName(patch.name);
      if (patch.description !== undefined) fields.description = optionalDescription(patch.description);
      if (patch.categoryId !== undefined) fields.category_id = await checkCategoryRef(patch.categoryId);
      if (patch.synonyms !== undefined) fields.synonyms_json = JSON.stringify(optionalSynonyms(patch.synonyms));
      if (patch.slug !== undefined && patch.slug !== existing.slug) fields.slug = await resolveSlug('condition', existing.name, patch.slug, id);
      try { await repo.updateCondition(id, fields); } catch (err) { throw asConflictIfUnique(err, 'A condition with that slug'); }
      return serializeCondition(await repo.findById('condition', id));
    },
    async setConditionActive(id, isActive) {
      await mustFind('condition', id);
      await repo.setActive('condition', id, isActive);
      return serializeCondition(await repo.findById('condition', id));
    },
    async listProtocolsForCondition(id) {
      await mustFind('condition', id);
      return (await repo.listProtocolsForCondition(id)).map((p) => ({ id: p.id, slug: p.slug, name: p.name, displayName: p.display_name, status: p.status }));
    },
  };
}

module.exports = { createCatalogService, serializeCategory, serializeCondition };
