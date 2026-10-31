/**
 * 005 — protocol lifecycle, slugs, metadata, published-version pointer and
 *       immutable version history.
 *
 * WHAT CHANGES
 *  protocols (rebuilt — SQLite cannot alter a CHECK constraint in place):
 *    + slug (unique, backfilled for every existing row), display_name,
 *      short_description, category_id, metadata_json, published_version_id,
 *      published_at
 *    ~ status now allows draft | in_review | published | archived, plus the
 *      legacy value 'active' (kept: the old patient flow still uses it)
 *    + CHECK: status='published' requires a published_version_id
 *  protocol_versions (columns ADDED, rows untouched):
 *    + kind ('checkpoint'|'published'), schema_version, created_by,
 *      restored_from_version, checksum, note
 *    The checksum of every EXISTING snapshot is computed and stored so the
 *    whole history can be integrity-checked; snapshot_json itself is not modified.
 *
 * WHAT IS ENFORCED BY THE DATABASE ITSELF (not just by application code)
 *  - protocol_versions rows can never be UPDATEd.
 *  - a version cannot be DELETEd while its protocol still exists (deleting a
 *    never-published protocol removes its history with it).
 *  - a protocol that has been published cannot be deleted at all (archive it).
 *  - protocols.published_version_id must reference a version of THAT protocol
 *    whose kind is 'published'.
 *
 * DATA SAFETY: existing protocols keep every value (status included, so
 * 'active' stays 'active'); canvases/objects/versions are not modified.
 * The runner backs the database up first and checks foreign keys afterwards.
 *
 * The slug helper below is a FROZEN copy on purpose: a migration must keep
 * doing what it did when it was written, even if services/slug.js evolves.
 */
const crypto = require('crypto');

function frozenSlugify(input) {
  let s = String(input === null || input === undefined ? '' : input)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 80) s = s.slice(0, 80).replace(/-+$/, '');
  return s || 'protocol';
}

module.exports = {
  version: 5,
  name: 'protocol_publishing',
  requiresForeignKeysOff: true,
  up(db) {
    // ---- 1. rebuild protocols ---------------------------------------------
    db.exec(`
      CREATE TABLE protocols_new (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL CHECK (slug = lower(slug) AND length(slug) BETWEEN 1 AND 80),
        display_name         TEXT,
        short_description    TEXT NOT NULL DEFAULT '',
        description          TEXT DEFAULT '',
        category_id          TEXT REFERENCES categories(id) ON DELETE SET NULL,
        metadata_json        TEXT,
        doctor_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        patient_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
        protocol_type        TEXT NOT NULL CHECK (protocol_type IN ('hand', 'organ')),
        status               TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'in_review', 'published', 'archived', 'active')),
        published_version_id TEXT REFERENCES protocol_versions(id) ON DELETE RESTRICT,
        published_at         TEXT,
        current_version      INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (status <> 'published' OR published_version_id IS NOT NULL)
      );
    `);

    // Existing protocols get a deterministic, collision-safe slug (oldest first).
    const existing = db.prepare('SELECT * FROM protocols ORDER BY created_at ASC, id ASC').all();
    const taken = new Set();
    const insert = db.prepare(
      `INSERT INTO protocols_new
         (id, name, slug, description, doctor_id, patient_id, protocol_type, status, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of existing) {
      const base = frozenSlugify(row.name);
      let slug = base;
      for (let n = 2; taken.has(slug); n += 1) {
        const suffix = `-${n}`;
        slug = base.slice(0, 80 - suffix.length).replace(/-+$/, '') + suffix;
      }
      taken.add(slug);
      insert.run(row.id, row.name, slug, row.description, row.doctor_id, row.patient_id, row.protocol_type, row.status, row.current_version, row.created_at, row.updated_at);
    }

    db.exec(`
      DROP TABLE protocols;
      ALTER TABLE protocols_new RENAME TO protocols;
      CREATE UNIQUE INDEX idx_protocols_slug ON protocols(slug);
      CREATE INDEX idx_protocols_doctor_id ON protocols(doctor_id);
      CREATE INDEX idx_protocols_patient_id ON protocols(patient_id);
      CREATE INDEX idx_protocols_category_id ON protocols(category_id);
      CREATE INDEX idx_protocols_status ON protocols(status);
    `);

    // ---- 2. extend protocol_versions (add columns; existing rows untouched) ----
    db.exec(`
      ALTER TABLE protocol_versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'checkpoint' CHECK (kind IN ('checkpoint', 'published'));
      ALTER TABLE protocol_versions ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE protocol_versions ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE protocol_versions ADD COLUMN restored_from_version INTEGER;
      ALTER TABLE protocol_versions ADD COLUMN checksum TEXT;
      ALTER TABLE protocol_versions ADD COLUMN note TEXT;
    `);

    // Record a checksum for every pre-existing snapshot (must happen BEFORE the
    // no-update trigger below is created).
    const setChecksum = db.prepare('UPDATE protocol_versions SET checksum = ? WHERE id = ?');
    for (const v of db.prepare('SELECT id, snapshot_json FROM protocol_versions').all()) {
      setChecksum.run(crypto.createHash('sha256').update(v.snapshot_json, 'utf8').digest('hex'), v.id);
    }

    db.exec(`
      CREATE INDEX idx_protocol_versions_protocol ON protocol_versions(protocol_id, version);

      -- History is immutable.
      CREATE TRIGGER protocol_versions_no_update
      BEFORE UPDATE ON protocol_versions
      BEGIN
        SELECT RAISE(ABORT, 'protocol_versions rows are immutable and cannot be updated');
      END;

      -- History is never deleted while its protocol exists (cascade from deleting the protocol itself is allowed).
      CREATE TRIGGER protocol_versions_no_delete
      BEFORE DELETE ON protocol_versions
      WHEN EXISTS (SELECT 1 FROM protocols WHERE id = OLD.protocol_id)
      BEGIN
        SELECT RAISE(ABORT, 'protocol_versions rows cannot be deleted while their protocol exists');
      END;

      -- A protocol that has ever been published cannot be deleted (it would take its
      -- history and its public page with it). Archive it instead.
      CREATE TRIGGER protocols_no_delete_when_published
      BEFORE DELETE ON protocols
      WHEN OLD.published_version_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'a protocol that has been published cannot be deleted; archive it instead');
      END;

      -- The published pointer must name a published version of the SAME protocol.
      CREATE TRIGGER protocols_published_pointer_insert
      BEFORE INSERT ON protocols
      WHEN NEW.published_version_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'published_version_id must reference a published version of this protocol')
        WHERE NOT EXISTS (SELECT 1 FROM protocol_versions v
                          WHERE v.id = NEW.published_version_id AND v.protocol_id = NEW.id AND v.kind = 'published');
      END;

      CREATE TRIGGER protocols_published_pointer_update
      BEFORE UPDATE OF published_version_id ON protocols
      WHEN NEW.published_version_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'published_version_id must reference a published version of this protocol')
        WHERE NOT EXISTS (SELECT 1 FROM protocol_versions v
                          WHERE v.id = NEW.published_version_id AND v.protocol_id = NEW.id AND v.kind = 'published');
      END;
    `);
  },
};
