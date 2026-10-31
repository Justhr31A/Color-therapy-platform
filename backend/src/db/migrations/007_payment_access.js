/**
 * 007 — payment-ready protocol access (Payment Phase 1: free launch).
 *
 * Purely additive: two new tables, nothing existing is touched (migrations 001–006 stay byte-for-byte as they were,
 * and the PAYMENTS feature flag keeps the value migration 003 gave it: OFF).
 *
 *   payment_settings  one row (id = 1): the access MODE (FREE now, PAID in a future release), the future price, the
 *                     currency and the configured provider. A fresh database is FREE; the seed below is the launch state.
 *   payment_orders    one row per protocol-access grant. In FREE mode this is a 'free' record (amount 0, provider
 *                     'free'): proof that access was granted, never a payment. It names the protocol AND the exact
 *                     published version that was unlocked.
 *
 * Money is stored as integer MINOR units (paise for INR) so no floating-point rounding can ever creep in.
 * No column can hold card numbers, CVV, banking passwords or UPI PINs — by design there is nowhere to put them.
 */
module.exports = {
  version: 7,
  name: 'payment_access',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS payment_settings (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        mode           TEXT    NOT NULL DEFAULT 'FREE' CHECK (mode IN ('FREE', 'PAID')),
        access_enabled INTEGER NOT NULL DEFAULT 1 CHECK (access_enabled IN (0, 1)),
        amount_minor   INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
        currency       TEXT    NOT NULL DEFAULT 'INR',
        provider       TEXT,
        updated_by     TEXT,
        updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO payment_settings (id, mode, access_enabled, currency) VALUES (1, 'FREE', 1, 'INR');

      CREATE TABLE IF NOT EXISTS payment_orders (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT REFERENCES users(id) ON DELETE SET NULL,
        protocol_id         TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
        protocol_version_id TEXT NOT NULL REFERENCES protocol_versions(id) ON DELETE CASCADE,
        amount_minor        INTEGER NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
        currency            TEXT    NOT NULL DEFAULT 'INR',
        status              TEXT    NOT NULL CHECK (status IN ('created', 'pending', 'paid', 'failed', 'cancelled', 'free')),
        mode                TEXT    NOT NULL CHECK (mode IN ('FREE', 'PAID')),
        provider            TEXT    NOT NULL,
        provider_order_id   TEXT,
        provider_payment_id TEXT,
        provider_reference  TEXT,
        created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_payment_orders_protocol_id ON payment_orders(protocol_id);
      CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);
    `);
  },
};
