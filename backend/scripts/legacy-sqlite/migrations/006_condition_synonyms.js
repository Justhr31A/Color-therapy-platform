/**
 * 006 — condition search terms / synonyms.
 *
 * Purely additive: one new column on the existing `conditions` table, nothing else touched. `protocols` already
 * has its own per-protocol search terms in a dedicated table (`protocol_search_terms`, migration 004); a
 * condition's synonyms are a much smaller thing — a handful of alternate names an admin wants remembered
 * against the condition itself, not a searchable/weighted index — so a single JSON array column is the smallest
 * schema addition that covers it, rather than a second table mirroring one built for a different job.
 *
 * `synonyms_json` defaults to `'[]'` for every existing row, so no condition created before this migration
 * changes in any way other than gaining an empty synonym list.
 */
module.exports = {
  version: 6,
  name: 'condition_synonyms',
  up(db) {
    db.exec(`
      ALTER TABLE conditions ADD COLUMN synonyms_json TEXT NOT NULL DEFAULT '[]';
    `);
  },
};
