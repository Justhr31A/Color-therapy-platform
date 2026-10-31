'use strict';

const { NOW_UTC } = require('../db/openPostgres');

const PUBLIC_COLUMNS = 'id, name, email, role, status';
const normalizeEmail = (email) => String(email).trim().toLowerCase();

/** Async PostgreSQL data access for the users table. `db` is the app database (or a transaction handle). */
function createUserRepository(db) {
  const one = async (sql, values) => (await db.query(sql, values)).rows[0] || null;
  return {
    /** Full row (including password_hash) — for authentication only. */
    findByEmail: (email) => one('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)]),
    findById: (id) => one(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]),
    /** The session user attached to req.user (never the password hash). */
    findSessionUser: (id) => one(`SELECT ${PUBLIC_COLUMNS}, created_at FROM users WHERE id = $1`, [id]),
    findPatientSummary: (id) => one('SELECT id, name, email, status FROM users WHERE id = $1', [id]),
    create({ id, name, email, passwordHash, role, status = 'active' }) {
      return one(
        `INSERT INTO users (id, name, email, password_hash, role, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${PUBLIC_COLUMNS}`,
        [id, name, normalizeEmail(email), passwordHash, role, status]
      );
    },
    updateRole(id, role) {
      return one(`UPDATE users SET role = $1, updated_at = ${NOW_UTC} WHERE id = $2 RETURNING ${PUBLIC_COLUMNS}`, [role, id]);
    },
    setPasswordAndStatus(id, passwordHash, status = 'active') {
      return one(
        `UPDATE users SET password_hash = $1, status = $2, updated_at = ${NOW_UTC} WHERE id = $3 RETURNING ${PUBLIC_COLUMNS}`,
        [passwordHash, status, id]
      );
    },
  };
}

module.exports = { createUserRepository, normalizeEmail };
