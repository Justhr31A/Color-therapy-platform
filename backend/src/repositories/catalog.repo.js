'use strict';

const { NOW_UTC } = require('../db/openPostgres');

/** All SQL for categories and conditions (see protocols.repo.js for the linking table). Async, PostgreSQL. */
function createCatalogRepository(db) {
  const tableFor = (kind) => {
    if (kind === 'category') return 'categories';
    if (kind === 'condition') return 'conditions';
    throw new Error(`Unknown catalog kind "${kind}"`);
  };
  const one = async (sql, values = []) => (await db.query(sql, values)).rows[0] || null;
  const many = async (sql, values = []) => (await db.query(sql, values)).rows;

  return {
    // generic (categories and conditions have the same id/slug/active shape)
    findById: (kind, id) => one(`SELECT * FROM ${tableFor(kind)} WHERE id = $1`, [id]),
    findBySlug: (kind, slug) => one(`SELECT * FROM ${tableFor(kind)} WHERE slug = $1`, [slug]),
    async slugExists(kind, slug, exceptId = null) {
      const table = tableFor(kind);
      const row = exceptId
        ? await one(`SELECT 1 AS found FROM ${table} WHERE slug = $1 AND id <> $2`, [slug, exceptId])
        : await one(`SELECT 1 AS found FROM ${table} WHERE slug = $1`, [slug]);
      return Boolean(row);
    },
    async setActive(kind, id, isActive) {
      await db.query(`UPDATE ${tableFor(kind)} SET is_active = $1, updated_at = ${NOW_UTC} WHERE id = $2`, [isActive ? 1 : 0, id]);
    },

    // categories
    async insertCategory(c) {
      await db.query('INSERT INTO categories (id, name, slug, description, is_active, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
        [c.id, c.name, c.slug, c.description, c.isActive ? 1 : 0, c.sortOrder]);
    },
    async updateCategory(id, fields) {
      const cols = Object.keys(fields);
      if (!cols.length) return;
      if (cols.some((c) => !['name', 'slug', 'description', 'sort_order'].includes(c))) throw new Error('Refusing to update non-editable category column');
      const values = cols.map((c) => fields[c]);
      values.push(id);
      const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      await db.query(`UPDATE categories SET ${set}, updated_at = ${NOW_UTC} WHERE id = $${values.length}`, values);
    },
    listCategories: () => many(
      `SELECT c.*, (SELECT COUNT(*)::integer FROM protocols p WHERE p.category_id = c.id) AS protocol_count,
              (SELECT COUNT(*)::integer FROM conditions d WHERE d.category_id = c.id) AS condition_count
         FROM categories c ORDER BY c.sort_order ASC, c.name COLLATE "C" ASC, c.id COLLATE "C" ASC`
    ),

    // conditions
    async insertCondition(c) {
      await db.query('INSERT INTO conditions (id, name, slug, description, category_id, is_active, synonyms_json) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [c.id, c.name, c.slug, c.description, c.categoryId, c.isActive ? 1 : 0, c.synonymsJson]);
    },
    async updateCondition(id, fields) {
      const cols = Object.keys(fields);
      if (!cols.length) return;
      if (cols.some((c) => !['name', 'slug', 'description', 'category_id', 'synonyms_json'].includes(c))) throw new Error('Refusing to update non-editable condition column');
      const values = cols.map((c) => fields[c]);
      values.push(id);
      const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      await db.query(`UPDATE conditions SET ${set}, updated_at = ${NOW_UTC} WHERE id = $${values.length}`, values);
    },
    listConditions: ({ categoryId } = {}) => many(
      `SELECT c.*, (SELECT COUNT(*)::integer FROM condition_protocols cp WHERE cp.condition_id = c.id) AS protocol_count
         FROM conditions c ${categoryId ? 'WHERE c.category_id = $1' : ''} ORDER BY c.name COLLATE "C" ASC, c.id COLLATE "C" ASC`,
      categoryId ? [categoryId] : []
    ),
    listProtocolsForCondition: (conditionId) => many(
      `SELECT p.id, p.slug, p.name, p.display_name, p.status
         FROM protocols p JOIN condition_protocols cp ON cp.protocol_id = p.id
        WHERE cp.condition_id = $1 ORDER BY p.name COLLATE "C" ASC, p.id COLLATE "C" ASC`,
      [conditionId]
    ),
  };
}

module.exports = { createCatalogRepository };
