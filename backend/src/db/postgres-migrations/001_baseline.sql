
BEGIN;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    role TEXT NOT NULL CHECK (role IN ('doctor', 'patient', 'admin')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'pending')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS protocols (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    doctor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    patient_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    protocol_type TEXT NOT NULL CHECK (protocol_type IN ('hand', 'organ')),
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'in_review', 'published', 'archived', 'active')),
    current_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS canvases (
    id TEXT PRIMARY KEY,
    protocol_id TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
    canvas_type TEXT NOT NULL CHECK (canvas_type IN ('hand', 'organ')),
    view_key TEXT NOT NULL,
    background_asset_key TEXT,
    width REAL NOT NULL,
    height REAL NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (protocol_id, view_key)
);

CREATE TABLE IF NOT EXISTS objects (
    id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    object_type TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL,
    height REAL,
    rotation REAL NOT NULL DEFAULT 0,
    color TEXT,
    thickness REAL,
    opacity REAL,
    points_json TEXT,
    finger TEXT,
    landmark_json TEXT,
    metadata_json TEXT,
    z_index INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS protocol_versions (
    id TEXT PRIMARY KEY,
    protocol_id TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (protocol_id, version)
);

COMMIT;
