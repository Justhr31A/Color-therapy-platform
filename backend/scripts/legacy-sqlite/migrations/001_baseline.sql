-- Colour Therapy Protocol Platform — Phase 1 schema
-- SQLite. Run automatically on server startup (see src/db/index.js).

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,                     -- NULL for a "pending" patient invited by email but not yet signed up
  role          TEXT NOT NULL CHECK (role IN ('doctor', 'patient')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A protocol is the top-level object a doctor creates.
-- `current_version` tracks the latest saved version number; the full history
-- of every save lives in protocol_versions so old versions are never lost.
CREATE TABLE IF NOT EXISTS protocols (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  doctor_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  protocol_type   TEXT NOT NULL CHECK (protocol_type IN ('hand', 'organ')),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The "live" editable canvases for a protocol (current working state).
-- For a hand protocol there are exactly 4 rows (left_front, right_front, left_back, right_back).
-- For an organ protocol there is one row per organ/body diagram the doctor added.
CREATE TABLE IF NOT EXISTS canvases (
  id                  TEXT PRIMARY KEY,
  protocol_id         TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
  canvas_type         TEXT NOT NULL CHECK (canvas_type IN ('hand', 'organ')),
  view_key            TEXT NOT NULL,        -- e.g. 'left_front' or an organ asset key like 'body_front'
  background_asset_key TEXT NOT NULL,       -- looked up against the server-side asset config, never a raw path
  width               INTEGER NOT NULL,     -- reference canvas width (px) that normalized coords are relative to
  height              INTEGER NOT NULL,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (protocol_id, view_key)
);

-- Every individual protocol marking (dot, ring, line, triangle, etc).
-- Position/size fields are normalized 0.0-1.0 relative to the canvas's width/height above,
-- so they stay valid regardless of what screen size renders them (required for future AR mapping).
CREATE TABLE IF NOT EXISTS objects (
  id                TEXT PRIMARY KEY,
  canvas_id         TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  object_type       TEXT NOT NULL,   -- dot | ring | hline | vline | freeline | invertedTriangle | triangle | rectangle | square | arrow
  x                 REAL NOT NULL DEFAULT 0,   -- normalized 0-1
  y                 REAL NOT NULL DEFAULT 0,   -- normalized 0-1
  width             REAL DEFAULT NULL,         -- normalized 0-1, meaning depends on object_type
  height            REAL DEFAULT NULL,         -- normalized 0-1
  rotation          REAL NOT NULL DEFAULT 0,   -- degrees
  color             TEXT NOT NULL DEFAULT '#e5484d',
  thickness         REAL NOT NULL DEFAULT 3,   -- stroke width in px at reference canvas size
  opacity           REAL NOT NULL DEFAULT 1,
  points_json       TEXT DEFAULT NULL,         -- JSON array of {x,y} normalized points, for freeline
  finger            TEXT DEFAULT NULL,         -- thumb | index | middle | ring | pinky (hand protocols only)
  landmark_json     TEXT DEFAULT NULL,         -- JSON: future hand-landmark mapping metadata (uncalibrated in Phase 1)
  metadata_json     TEXT DEFAULT NULL,         -- JSON: free-form extensible metadata
  z_index           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_objects_canvas_id ON objects(canvas_id);
CREATE INDEX IF NOT EXISTS idx_protocols_doctor_id ON protocols(doctor_id);
CREATE INDEX IF NOT EXISTS idx_protocols_patient_id ON protocols(patient_id);

-- Full immutable snapshot of a protocol every time it is saved.
-- snapshot_json contains the entire canvases[] + objects[] tree at that moment,
-- so a specific historical version can always be retrieved exactly as it was,
-- even after later edits change the live canvases/objects rows above.
CREATE TABLE IF NOT EXISTS protocol_versions (
  id            TEXT PRIMARY KEY,
  protocol_id   TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (protocol_id, version)
);
