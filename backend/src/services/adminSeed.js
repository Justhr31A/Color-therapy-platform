'use strict';

const { v4: uuidv4 } = require('uuid');
const { createUserRepository } = require('../repositories/users.repo');
const { hashPassword } = require('../utils/password');

const MIN_ADMIN_PASSWORD_LENGTH = 12;

class AdminSeedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdminSeedError';
    this.code = code;
  }
}

/**
 * The ONLY supported way to create an admin: called from the CLI script
 * (backend/scripts/create-admin.js), never from a public HTTP route. The
 * password is supplied at run time by the operator, is hashed with the same
 * bcrypt routine as every other account, and is never stored or logged in
 * plain text. Nothing is hard-coded.
 *
 * - No such user            -> creates an active admin (password required).
 * - Existing doctor         -> only with promoteExisting: role becomes admin,
 *                              password and protocols are left untouched.
 * - Existing admin/patient  -> refused (nothing changes).
 *
 * `db` is the PostgreSQL app database (or a transaction handle).
 */
async function createAdminAccount(db, { email, name, password, promoteExisting = false }) {
  const users = createUserRepository(db);

  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AdminSeedError('INVALID_EMAIL', 'A valid email address is required.');
  }
  const normalizedEmail = email.toLowerCase();
  const existing = await users.findByEmail(normalizedEmail);

  if (existing) {
    if (existing.role === 'admin') {
      throw new AdminSeedError('ALREADY_ADMIN', `${normalizedEmail} is already an admin. Nothing was changed.`);
    }
    if (existing.role === 'patient') {
      throw new AdminSeedError('EXISTS_AS_PATIENT', `${normalizedEmail} belongs to a patient account and cannot be made an admin.`);
    }
    if (!promoteExisting) {
      throw new AdminSeedError(
        'EXISTS_AS_DOCTOR',
        `${normalizedEmail} already exists as a doctor. Re-run with --promote to make that existing account an admin ` +
          '(its password and protocols are kept), or use a different email.'
      );
    }
    const user = await users.updateRole(existing.id, 'admin');
    return { action: 'promoted', user };
  }

  if (typeof password !== 'string' || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new AdminSeedError('WEAK_PASSWORD', `The admin password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`);
  }
  const displayName = typeof name === 'string' && name.trim() ? name.trim() : 'Administrator';
  const passwordHash = await hashPassword(password);
  const user = await users.create({ id: uuidv4(), name: displayName, email: normalizedEmail, passwordHash, role: 'admin' });
  return { action: 'created', user };
}

module.exports = { createAdminAccount, AdminSeedError, MIN_ADMIN_PASSWORD_LENGTH };
