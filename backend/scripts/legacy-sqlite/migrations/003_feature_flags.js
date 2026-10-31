/**
 * 003 — feature flags.
 *
 * The seed values below are a FROZEN copy of the initial flag state, on
 * purpose: a migration must describe what it did at the time, and must not
 * change meaning when the application's flag definitions later evolve.
 * (A test asserts this seed matches the current definitions so drift is
 * noticed.) INSERT OR IGNORE means re-running never overwrites a flag an
 * administrator has already changed.
 */
const SEED = [
  ['WEBSITE', 1, 'Public website'],
  ['PROTOCOL_BROWSER', 1, 'Public protocol browser'],
  ['ADMIN', 1, 'Admin area'],
  ['PROTOCOL_STUDIO', 1, 'Protocol Studio (doctor/admin protocol authoring API)'],
  ['DOWNLOAD', 1, 'Protocol downloads'],
  ['AI_ASSESSMENT', 0, 'AI-assisted symptom assessment'],
  ['PAYMENTS', 0, 'Payments'],
  ['CAMERA', 0, 'Camera access on public pages'],
  ['AR', 0, 'Augmented-reality overlay (requires CAMERA)'],
  ['PATIENT_ACCOUNTS', 0, 'Legacy patient accounts'],
  ['PATIENT_ASSIGNMENT', 0, 'Legacy protocol-to-patient assignment (requires PATIENT_ACCOUNTS)'],
];

module.exports = {
  version: 3,
  name: 'feature_flags',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        key         TEXT PRIMARY KEY,
        enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        description TEXT NOT NULL DEFAULT '',
        updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const insert = db.prepare('INSERT OR IGNORE INTO feature_flags (key, enabled, description) VALUES (?, ?, ?)');
    SEED.forEach(([key, enabled, description]) => insert.run(key, enabled, description));
  },
};
