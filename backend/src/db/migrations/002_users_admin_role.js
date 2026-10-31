/**
 * 002 — allow the 'admin' role.
 *
 * `users.role` was created with CHECK (role IN ('doctor','patient')). SQLite
 * cannot alter a CHECK constraint in place, so the table is rebuilt using
 * SQLite's documented procedure (https://sqlite.org/lang_altertable.html,
 * "Making Other Kinds Of Table Schema Changes"):
 *   create users_new -> copy every row -> drop users -> rename users_new.
 * The runner switches foreign keys off around this migration (required for
 * the procedure) and refuses to commit if PRAGMA foreign_key_check reports
 * anything afterwards, so protocols.doctor_id / patient_id links cannot be
 * silently broken. Every existing row is copied unchanged.
 */
module.exports = {
  version: 2,
  name: 'users_admin_role',
  requiresForeignKeysOff: true,
  up(db) {
    db.exec(`
      CREATE TABLE users_new (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        role          TEXT NOT NULL CHECK (role IN ('admin', 'doctor', 'patient')),
        status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending')),
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO users_new (id, name, email, password_hash, role, status, created_at, updated_at)
        SELECT id, name, email, password_hash, role, status, created_at, updated_at FROM users;

      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  },
};
