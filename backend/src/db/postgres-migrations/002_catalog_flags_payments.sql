
BEGIN;

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE
        CHECK (slug = lower(slug) AND length(slug) BETWEEN 1 AND 80),
    description TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conditions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE
        CHECK (slug = lower(slug) AND length(slug) BETWEEN 1 AND 80),
    description TEXT NOT NULL DEFAULT '',
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    synonyms_json TEXT NOT NULL DEFAULT '[]',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conditions_category_id
    ON conditions(category_id);

CREATE TABLE IF NOT EXISTS condition_protocols (
    condition_id TEXT NOT NULL REFERENCES conditions(id) ON DELETE CASCADE,
    protocol_id TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (condition_id, protocol_id)
);

CREATE INDEX IF NOT EXISTS idx_condition_protocols_protocol_id
    ON condition_protocols(protocol_id);

CREATE TABLE IF NOT EXISTS protocol_search_terms (
    id TEXT PRIMARY KEY,
    protocol_id TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    term_normalized TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'keyword'
        CHECK (kind IN ('keyword', 'synonym', 'phrase')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (protocol_id, term_normalized)
);

CREATE INDEX IF NOT EXISTS idx_protocol_search_terms_term
    ON protocol_search_terms(term_normalized);

CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    description TEXT NOT NULL DEFAULT '',
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO feature_flags (key, enabled, description) VALUES
    ('WEBSITE', 1, 'Public website'),
    ('PROTOCOL_BROWSER', 1, 'Public protocol browser'),
    ('ADMIN', 1, 'Admin area'),
    ('PROTOCOL_STUDIO', 1, 'Protocol Studio (doctor/admin protocol authoring API)'),
    ('DOWNLOAD', 1, 'Protocol downloads'),
    ('AI_ASSESSMENT', 0, 'AI-assisted symptom assessment'),
    ('PAYMENTS', 0, 'Payments'),
    ('CAMERA', 0, 'Camera access on public pages'),
    ('AR', 0, 'Augmented-reality overlay (requires CAMERA)'),
    ('PATIENT_ACCOUNTS', 0, 'Legacy patient accounts'),
    ('PATIENT_ASSIGNMENT', 0, 'Legacy protocol-to-patient assignment (requires PATIENT_ACCOUNTS)')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS payment_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL DEFAULT 'FREE' CHECK (mode IN ('FREE', 'PAID')),
    access_enabled INTEGER NOT NULL DEFAULT 1 CHECK (access_enabled IN (0, 1)),
    amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'INR',
    provider TEXT,
    updated_by TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO payment_settings (id, mode, access_enabled, currency)
VALUES (1, 'FREE', 1, 'INR')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS payment_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    protocol_id TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
    protocol_version_id TEXT NOT NULL
        REFERENCES protocol_versions(id) ON DELETE CASCADE,
    amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL
        CHECK (status IN ('created', 'pending', 'paid', 'failed', 'cancelled', 'free')),
    mode TEXT NOT NULL CHECK (mode IN ('FREE', 'PAID')),
    provider TEXT NOT NULL,
    provider_order_id TEXT,
    provider_payment_id TEXT,
    provider_reference TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_protocol_id
    ON payment_orders(protocol_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id
    ON payment_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status
    ON payment_orders(status);

COMMIT;
