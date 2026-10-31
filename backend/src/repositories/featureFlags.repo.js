'use strict';

const { NOW_UTC } = require('../db/openPostgres');

/**
 * Data access for feature flags. All SQL for this table lives here so the service/middleware never
 * touch the database directly. Async, PostgreSQL.
 */
function createFeatureFlagRepository(db) {
  return {
    async getAll() {
      const result = await db.query('SELECT key, enabled, description, updated_by, updated_at FROM feature_flags');
      return result.rows;
    },
    async upsert(key, enabled, description, updatedBy) {
      await db.query(
        `INSERT INTO feature_flags (key, enabled, description, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, ${NOW_UTC})
         ON CONFLICT (key) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           updated_by = EXCLUDED.updated_by,
           updated_at = EXCLUDED.updated_at`,
        [key, enabled ? 1 : 0, description, updatedBy || null]
      );
    },
  };
}

module.exports = { createFeatureFlagRepository };
