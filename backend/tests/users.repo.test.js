const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserRepository } = require('../src/repositories/users.repo');

test('PostgreSQL users repository normalizes emails and uses parameterized queries', async () => {
  const calls = [];
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('SELECT * FROM users WHERE email')) return { rows: [{ id: 'u1', email: 'doctor@example.com' }] };
    if (sql.includes('INSERT INTO users')) return { rows: [{ id: params[0], email: params[2], role: params[4] }] };
    if (sql.includes('UPDATE users SET role')) return { rows: [{ id: params[1], role: params[0] }] };
    if (sql.includes('UPDATE users SET password_hash')) return { rows: [{ id: params[2], status: params[1] }] };
    return { rows: [] };
  } };
  const users = createUserRepository(db);
  assert.equal((await users.findByEmail(' Doctor@Example.com ')).id, 'u1');
  assert.deepEqual(calls[0].params, ['doctor@example.com']);
  assert.equal((await users.create({ id: 'u2', name: 'A', email: ' A@Example.com ', passwordHash: 'hash', role: 'doctor' })).email, 'a@example.com');
  assert.deepEqual(calls[1].params, ['u2', 'A', 'a@example.com', 'hash', 'doctor', 'active']);
  assert.equal((await users.updateRole('u2', 'admin')).role, 'admin');
  assert.equal((await users.setPasswordAndStatus('u2', 'hash2')).status, 'active');
});
