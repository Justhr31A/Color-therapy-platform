/**
 * 004 — categories, conditions, protocol↔condition links, protocol search terms.
 *
 * Purely additive: four new tables, nothing existing is touched.
 *
 *  - categories / conditions: unique slug, stable UUID ids, active flag.
 *    A condition may sit in one category (optional).
 *  - condition_protocols: many-to-many; the composite PRIMARY KEY is the
 *    unique constraint that stops the same link being inserted twice.
 *  - protocol_search_terms: synonyms/phrases users might type. Unique per
 *    protocol on the normalized (lowercased, whitespace-collapsed) text.
 *
 * (condition_protocols/protocol_search_terms point at protocols(id) by name;
 * migration 005 rebuilds `protocols` and that reference stays valid.)
 */
module.exports = {
  version: 4,
  name: 'catalog_tables',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE CHECK (slug = lower(slug) AND length(slug) BETWEEN 1 AND 80),
        description TEXT NOT NULL DEFAULT '',
        is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS conditions (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE CHECK (slug = lower(slug) AND length(slug) BETWEEN 1 AND 80),
        description TEXT NOT NULL DEFAULT '',
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
        is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_conditions_category_id ON conditions(category_id);

      CREATE TABLE IF NOT EXISTS condition_protocols (
        condition_id TEXT NOT NULL REFERENCES conditions(id) ON DELETE CASCADE,
        protocol_id  TEXT NOT NULL REFERENCES protocols(id)  ON DELETE CASCADE,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (condition_id, protocol_id)
      );
      CREATE INDEX IF NOT EXISTS idx_condition_protocols_protocol_id ON condition_protocols(protocol_id);

      CREATE TABLE IF NOT EXISTS protocol_search_terms (
        id              TEXT PRIMARY KEY,
        protocol_id     TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
        term            TEXT NOT NULL,
        term_normalized TEXT NOT NULL,
        kind            TEXT NOT NULL DEFAULT 'keyword' CHECK (kind IN ('keyword', 'synonym', 'phrase')),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (protocol_id, term_normalized)
      );
      CREATE INDEX IF NOT EXISTS idx_protocol_search_terms_term ON protocol_search_terms(term_normalized);
    `);
  },
};
