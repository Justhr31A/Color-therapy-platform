/** [DETERMINISTIC SOFTWARE TESTS] — the admin seeding service used by `npm run admin:create`. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { missingReason } = require('./helpers/testDb');
const { openTestDatabase } = require('./helpers/pg');

// needs the DB driver plus bcryptjs (hashing) and uuid (ids); skipped cleanly if a package is missing.
// (A missing TEST_DATABASE_URL is a failure, never a skip: see helpers/pg.js.)
const SKIP_REASON = missingReason('pg', 'bcryptjs', 'uuid');
// Loaded lazily so a missing package produces a skip, not a crash while loading this file.
const seed = () => require('../src/services/adminSeed'); // eslint-disable-line global-require
const createAdminAccount = (...a) => seed().createAdminAccount(...a);
const comparePassword = (...a) => require('../src/utils/password').comparePassword(...a); // eslint-disable-line global-require
const rejectsWith = (code) => (e) => e instanceof seed().AdminSeedError && e.code === code;
const MIN_ADMIN_PASSWORD_LENGTH = 12;

const migratedDb = () => openTestDatabase();
const STRONG = 'correct horse battery staple'; // test-only value, not a real credential

describe('[DETERMINISTIC] admin seeding', { skip: SKIP_REASON }, () => {
  it('creates an active admin and never stores the password in plain text', async () => {
    const t = await migratedDb();
    try {
      const { action, user } = await createAdminAccount(t.db, { email: 'Boss@Example.com', name: 'The Boss', password: STRONG });
      assert.equal(action, 'created');
      assert.equal(user.role, 'admin');
      assert.equal(user.email, 'boss@example.com', 'email is normalised to lower case');

      const row = (await t.row('SELECT * FROM users WHERE id = $1', user.id));
      assert.equal(row.status, 'active');
      assert.notEqual(row.password_hash, STRONG);
      assert.ok(!JSON.stringify(row).includes(STRONG), 'the plain-text password must appear nowhere in the stored row');
      assert.equal(await comparePassword(STRONG, row.password_hash), true, 'the stored hash verifies the password');
      assert.equal(await comparePassword('wrong password!!', row.password_hash), false);
    } finally { await t.cleanup(); }
  });

  it('rejects a short password and a malformed email, creating nothing', async () => {
    const t = await migratedDb();
    try {
      await assert.rejects(createAdminAccount(t.db, { email: 'a@example.com', password: 'x'.repeat(MIN_ADMIN_PASSWORD_LENGTH - 1) }), rejectsWith('WEAK_PASSWORD'));
      await assert.rejects(createAdminAccount(t.db, { email: 'a@example.com' }), rejectsWith('WEAK_PASSWORD'));
      await assert.rejects(createAdminAccount(t.db, { email: 'not-an-email', password: STRONG }), rejectsWith('INVALID_EMAIL'));
      await assert.rejects(createAdminAccount(t.db, { password: STRONG }), rejectsWith('INVALID_EMAIL'));
      assert.equal((await t.row('SELECT COUNT(*) c FROM users')).c, 0);
    } finally { await t.cleanup(); }
  });

  it('refuses when the email is already an admin (nothing changes)', async () => {
    const t = await migratedDb();
    try {
      await createAdminAccount(t.db, { email: 'boss@example.com', password: STRONG });
      const before = (await t.rows('SELECT * FROM users'));
      await assert.rejects(createAdminAccount(t.db, { email: 'boss@example.com', password: 'a different long password' }), rejectsWith('ALREADY_ADMIN'));
      assert.deepEqual((await t.rows('SELECT * FROM users')), before);
    } finally { await t.cleanup(); }
  });

  it('never converts a patient into an admin', async () => {
    const t = await migratedDb();
    try {
      (await t.run("INSERT INTO users (id,name,email,password_hash,role,status) VALUES ('p','P','pat@example.com',NULL,'patient','pending')"));
      await assert.rejects(createAdminAccount(t.db, { email: 'pat@example.com', password: STRONG, promoteExisting: true }), rejectsWith('EXISTS_AS_PATIENT'));
      assert.equal((await t.row("SELECT role FROM users WHERE id='p'")).role, 'patient');
    } finally { await t.cleanup(); }
  });

  it('an existing doctor is NOT touched unless promotion is explicitly requested', async () => {
    const t = await migratedDb();
    try {
      (await t.run("INSERT INTO users (id,name,email,password_hash,role) VALUES ('d','Dr','dr@example.com','existing-hash','doctor')"));
      await assert.rejects(createAdminAccount(t.db, { email: 'dr@example.com', password: STRONG }), rejectsWith('EXISTS_AS_DOCTOR'));
      assert.equal((await t.row("SELECT role FROM users WHERE id='d'")).role, 'doctor');
    } finally { await t.cleanup(); }
  });

  it('promoting an existing doctor keeps their password, id and protocols', async () => {
    const t = await migratedDb();
    try {
      (await t.run("INSERT INTO users (id,name,email,password_hash,role) VALUES ('d','Dr','dr@example.com','existing-hash','doctor')"));
      (await t.run("INSERT INTO protocols (id,name,slug,doctor_id,protocol_type) VALUES ('p1','Mine','mine','d','hand')"));

      // no password supplied on purpose: promotion must not require or change one
      const { action, user } = await createAdminAccount(t.db, { email: 'dr@example.com', promoteExisting: true });
      assert.equal(action, 'promoted');
      assert.equal(user.role, 'admin');
      const row = (await t.row("SELECT * FROM users WHERE id='d'"));
      assert.equal(row.password_hash, 'existing-hash');
      assert.equal((await t.row("SELECT doctor_id FROM protocols WHERE id='p1'")).doctor_id, 'd');
    } finally { await t.cleanup(); }
  });
});
