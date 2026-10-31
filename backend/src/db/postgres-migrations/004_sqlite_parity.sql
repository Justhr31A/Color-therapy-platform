-- 004 — make the PostgreSQL schema match the SQLite schema the application was written against.
--
-- Written as a NEW migration (rather than editing 001–003) so that any PostgreSQL database that already ran
-- 001–003 is brought to the same final schema as a fresh one.
--
-- 1. Coordinates and sizes: PostgreSQL REAL is a 4-byte float (~7 significant digits); SQLite REAL is an 8-byte
--    double. Normalised marking positions such as 0.4578123456 would be silently rounded and published snapshots
--    would stop matching the live rows. All such columns become DOUBLE PRECISION (identical to SQLite REAL).
--    NOTE: a value already stored as REAL keeps its 4-byte rounding; fresh databases are unaffected.
-- 2. Defaults / NOT NULL that SQLite had and 001 omitted (objects colour/thickness/opacity/x/y,
--    canvases.background_asset_key). SET NOT NULL fails loudly if a NULL already exists — nothing is invented.
-- 3. protocols.description was nullable in SQLite (TEXT DEFAULT ''); 001 made it NOT NULL, which would reject
--    a faithful import of legacy rows. Restored to nullable with the same default.
-- 4. Timestamps: SQLite stored datetime('now') = UTC. CURRENT_TIMESTAMP into a TIMESTAMP column uses the
--    session TimeZone instead, so defaults are pinned to UTC explicitly.
-- 5. idx_objects_canvas_id existed in SQLite and was missing here.
-- 6. objects.z_index and 7. caller-supplied 64-bit integers: see the notes next to those statements.
-- 8. objects.insert_seq: insertion order (see below).

ALTER TABLE canvases
  ALTER COLUMN width TYPE DOUBLE PRECISION,
  ALTER COLUMN height TYPE DOUBLE PRECISION,
  ALTER COLUMN background_asset_key SET NOT NULL;

ALTER TABLE objects
  ALTER COLUMN x TYPE DOUBLE PRECISION,
  ALTER COLUMN x SET DEFAULT 0,
  ALTER COLUMN y TYPE DOUBLE PRECISION,
  ALTER COLUMN y SET DEFAULT 0,
  ALTER COLUMN width TYPE DOUBLE PRECISION,
  ALTER COLUMN height TYPE DOUBLE PRECISION,
  ALTER COLUMN rotation TYPE DOUBLE PRECISION,
  ALTER COLUMN color SET DEFAULT '#e5484d',
  ALTER COLUMN color SET NOT NULL,
  ALTER COLUMN thickness TYPE DOUBLE PRECISION,
  ALTER COLUMN thickness SET DEFAULT 3,
  ALTER COLUMN thickness SET NOT NULL,
  ALTER COLUMN opacity TYPE DOUBLE PRECISION,
  ALTER COLUMN opacity SET DEFAULT 1,
  ALTER COLUMN opacity SET NOT NULL,
  -- The builder assigns zIndex = Date.now() (~1.7e12), far beyond a 4-byte INTEGER (max ~2.1e9): every real save
  -- would fail. SQLite INTEGER is 64-bit and also kept non-integer values; DOUBLE PRECISION holds both exactly
  -- (integers up to 2^53) and returns the same JSON numbers.
  ALTER COLUMN z_index TYPE DOUBLE PRECISION;

-- 7. Other 64-bit SQLite integers the API accepts from callers: payment amounts (validated up to 1e10 minor
--    units, beyond INTEGER) and category sort order (any whole number).
ALTER TABLE payment_settings ALTER COLUMN amount_minor TYPE BIGINT;
ALTER TABLE payment_orders ALTER COLUMN amount_minor TYPE BIGINT;
ALTER TABLE categories ALTER COLUMN sort_order TYPE BIGINT;

CREATE INDEX IF NOT EXISTS idx_objects_canvas_id ON objects(canvas_id);

-- 8. Insertion order. SQLite returned objects with an equal z_index in insertion (rowid) order, and the builder,
--    patient and render paths relied on that for stacking. PostgreSQL has no rowid, so ties would come back in an
--    arbitrary order. insert_seq records insertion order (the importer copies SQLite rows in rowid order).
ALTER TABLE objects ADD COLUMN IF NOT EXISTS insert_seq BIGINT GENERATED ALWAYS AS IDENTITY;

ALTER TABLE protocols ALTER COLUMN description DROP NOT NULL;

ALTER TABLE users
  ALTER COLUMN created_at SET DEFAULT (now() AT TIME ZONE 'UTC'),
  ALTER COLUMN updated_at SET DEFAULT (now() AT TIME ZONE 'UTC');
ALTER TABLE protocols
  ALTER COLUMN created_at SET DEFAULT (now() AT TIME ZONE 'UTC'),
  ALTER COLUMN updated_at SET DEFAULT (now() AT TIME ZONE 'UTC');
ALTER TABLE objects
  ALTER COLUMN created_at SET DEFAULT (now() AT TIME ZONE 'UTC'),
  ALTER COLUMN updated_at SET DEFAULT (now() AT TIME ZONE 'UTC');
ALTER TABLE protocol_versions
  ALTER COLUMN created_at SET DEFAULT (now() AT TIME ZONE 'UTC');
ALTER TABLE categories
  ALTER COLUMN created_at SET DEFAULT (now() AT TIME ZONE 'UTC'),
  ALTER COLUMN updated_at SET DEFAULT (now() AT TIME ZONE 'UTC');
ALTER TABLE conditions
  ALTER COLUMN created_at SET DEFAULT (now() AT TIME ZONE 'UTC'),
  ALTER COLUMN updated_at SET DEFAULT (now() AT TIME ZONE 'UTC');
ALTER TABLE condition_protocols
  ALTER COLUMN created_at SET DEFAULT (now() AT TIME ZONE 'UTC');
ALTER TABLE protocol_search_terms
  ALTER COLUMN created_at SET DEFAULT (now() AT TIME ZONE 'UTC');
ALTER TABLE feature_flags
  ALTER COLUMN updated_at SET DEFAULT (now() AT TIME ZONE 'UTC');
ALTER TABLE payment_settings
  ALTER COLUMN updated_at SET DEFAULT (now() AT TIME ZONE 'UTC');
ALTER TABLE payment_orders
  ALTER COLUMN created_at SET DEFAULT (now() AT TIME ZONE 'UTC'),
  ALTER COLUMN updated_at SET DEFAULT (now() AT TIME ZONE 'UTC');
