/** [DETERMINISTIC SOFTWARE TESTS] — feature flag definitions, service and middleware. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { missingReason } = require('./helpers/testDb');
const { openTestDatabase } = require('./helpers/pg');

const SKIP_REASON = missingReason('pg');
const { FLAG_DEFINITIONS, FLAG_KEYS, isKnownFlag, dependentsOf } = require('../src/services/featureFlagDefinitions');
const { createFeatureFlagService, FeatureFlagError } = require('../src/services/featureFlags');
const { requireFlag } = require('../src/middleware/flags');

const EXPECTED_INITIAL = {
  WEBSITE: true, PROTOCOL_BROWSER: true, ADMIN: true, PROTOCOL_STUDIO: true, DOWNLOAD: true,
  AI_ASSESSMENT: false, PAYMENTS: false, CAMERA: false, AR: false, PATIENT_ACCOUNTS: false, PATIENT_ASSIGNMENT: false,
};

const migratedDb = () => openTestDatabase();

describe('[DETERMINISTIC] feature flag definitions (pure, no database)', () => {
  it('defines exactly the required flags with the required default state', async () => {
    assert.deepEqual(Object.fromEntries(FLAG_KEYS.map((k) => [k, FLAG_DEFINITIONS[k].default])), EXPECTED_INITIAL);
  });
  it('declares the two required dependencies and no others', async () => {
    const deps = Object.fromEntries(FLAG_KEYS.filter((k) => FLAG_DEFINITIONS[k].requires.length).map((k) => [k, FLAG_DEFINITIONS[k].requires]));
    assert.deepEqual(deps, { AR: ['CAMERA'], PATIENT_ASSIGNMENT: ['PATIENT_ACCOUNTS'] });
  });
  it('every dependency names a real flag, and there are no cycles', async () => {
    const hasCycle = (key, path = []) => path.includes(key) || FLAG_DEFINITIONS[key].requires.some((dep) => hasCycle(dep, [...path, key]));
    for (const key of FLAG_KEYS) {
      for (const dep of FLAG_DEFINITIONS[key].requires) assert.ok(isKnownFlag(dep), `${key} requires unknown flag ${dep}`);
      assert.equal(hasCycle(key), false, `dependency cycle involving ${key}`);
    }
    // and the detector itself works (guards against a vacuous test):
    const fake = { A: { requires: ['B'] }, B: { requires: ['A'] } };
    const detect = (k, path = []) => path.includes(k) || fake[k].requires.some((d) => detect(d, [...path, k]));
    assert.equal(detect('A'), true);
  });
  it('dependentsOf finds what relies on a flag', async () => {
    assert.deepEqual(dependentsOf('CAMERA'), ['AR']);
    assert.deepEqual(dependentsOf('PATIENT_ACCOUNTS'), ['PATIENT_ASSIGNMENT']);
    assert.deepEqual(dependentsOf('WEBSITE'), []);
  });
});

describe('[DETERMINISTIC] feature flag service against a migrated database', { skip: SKIP_REASON }, () => {
  it('migration seed matches the code definitions exactly (drift detector)', async () => {
    const t = await migratedDb();
    try {
      const rows = (await t.rows('SELECT key, enabled, description FROM feature_flags ORDER BY key COLLATE "C"'));
      assert.deepEqual(rows.map((r) => r.key).sort(), [...FLAG_KEYS].sort());
      for (const r of rows) {
        assert.equal(r.enabled === 1, FLAG_DEFINITIONS[r.key].default, `${r.key} seeded state differs from definition`);
        assert.equal(r.description, FLAG_DEFINITIONS[r.key].description, `${r.key} description drifted`);
      }
    } finally { await t.cleanup(); }
  });

  it('initial effective state is exactly as specified', async () => {
    const t = await migratedDb();
    try {
      const svc = createFeatureFlagService(t.db);
      const effective = {};
      for (const k of FLAG_KEYS) effective[k] = await svc.isEnabled(k);
      assert.deepEqual(effective, EXPECTED_INITIAL);
    } finally { await t.cleanup(); }
  });

  it('a flag is only effectively ON when its prerequisites are ON, even if the row says on (enforced at read time)', async () => {
    const t = await migratedDb();
    try {
      const svc = createFeatureFlagService(t.db);
      (await t.run("UPDATE feature_flags SET enabled = 1 WHERE key = 'AR'")); // hand-edited DB: AR on, CAMERA off
      assert.equal((await svc.isEnabled('AR')), false);
      const ar = (await svc.listFlags()).find((f) => f.key === 'AR');
      assert.equal(ar.stored, true);
      assert.equal(ar.enabled, false);
      assert.deepEqual(ar.blockedBy, ['CAMERA']);
      (await t.run("UPDATE feature_flags SET enabled = 1 WHERE key = 'CAMERA'"));
      assert.equal((await svc.isEnabled('AR')), true);
    } finally { await t.cleanup(); }
  });

  it('setFlag enforces "AR requires CAMERA" and "PATIENT_ASSIGNMENT requires PATIENT_ACCOUNTS" when enabling', async () => {
    const t = await migratedDb();
    try {
      const svc = createFeatureFlagService(t.db);
      await assert.rejects(() => svc.setFlag('AR', true), (e) => e instanceof FeatureFlagError && e.code === 'DEPENDENCY_DISABLED' && /CAMERA/.test(e.message));
      await assert.rejects(() => svc.setFlag('PATIENT_ASSIGNMENT', true), (e) => e.code === 'DEPENDENCY_DISABLED' && /PATIENT_ACCOUNTS/.test(e.message));
      assert.equal((await svc.isEnabled('AR')), false, 'a rejected change must not have been stored');

      (await svc.setFlag('CAMERA', true));
      (await svc.setFlag('AR', true));
      assert.equal((await svc.isEnabled('AR')), true);
    } finally { await t.cleanup(); }
  });

  it('setFlag refuses to disable a prerequisite while something still depends on it', async () => {
    const t = await migratedDb();
    try {
      const svc = createFeatureFlagService(t.db);
      (await svc.setFlag('CAMERA', true));
      (await svc.setFlag('AR', true));
      await assert.rejects(() => svc.setFlag('CAMERA', false), (e) => e.code === 'DEPENDENT_ENABLED' && /AR/.test(e.message));
      assert.equal((await svc.isEnabled('CAMERA')), true);
      (await svc.setFlag('AR', false));
      (await svc.setFlag('CAMERA', false)); // now allowed
      assert.equal((await svc.isEnabled('CAMERA')), false);
    } finally { await t.cleanup(); }
  });

  it('rejects unknown flags, and records who changed a flag', async () => {
    const t = await migratedDb();
    try {
      const svc = createFeatureFlagService(t.db);
      await assert.rejects(() => svc.isEnabled('NOT_A_FLAG'), /Unknown feature flag/);
      await assert.rejects(() => svc.setFlag('NOT_A_FLAG', true), (e) => e.code === 'UNKNOWN_FLAG');

      (await t.run("INSERT INTO users (id,name,email,password_hash,role) VALUES ('adm','A','a@x.com','h','admin')"));
      (await svc.setFlag('DOWNLOAD', false, { actorId: 'adm' }));
      assert.equal((await t.row("SELECT updated_by FROM feature_flags WHERE key='DOWNLOAD'")).updated_by, 'adm');
    } finally { await t.cleanup(); }
  });

  it('a missing row falls back to the code default instead of failing', async () => {
    const t = await migratedDb();
    try {
      const svc = createFeatureFlagService(t.db);
      (await t.run("DELETE FROM feature_flags WHERE key IN ('WEBSITE','AR')"));
      assert.equal((await svc.isEnabled('WEBSITE')), true);
      assert.equal((await svc.isEnabled('AR')), false);
    } finally { await t.cleanup(); }
  });
});

describe('[DETERMINISTIC] requireFlag middleware', () => {
  const fakeRes = () => {
    const r = { statusCode: null, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };

  it('throws immediately (at route-definition time) for a mistyped flag name', async () => {
    assert.throws(() => requireFlag('PROTOCOL_STUDI0'), /Unknown feature flag/);
  });
  it('calls next() when the flag is on', async () => {
    const mw = requireFlag('WEBSITE', { service: { isEnabled: async () => true } });
    let called = false;
    await mw({}, fakeRes(), () => { called = true; });
    assert.equal(called, true);
  });
  it('answers 404 (not 403) and does NOT call next() when the flag is off', async () => {
    const mw = requireFlag('AR', { service: { isEnabled: async () => false } });
    const res = fakeRes();
    let called = false;
    await mw({}, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Not found.' });
  });
  it('passes service errors to next(err) instead of crashing or leaking the feature', async () => {
    const boom = new Error('db down');
    const mw = requireFlag('WEBSITE', { service: { isEnabled: async () => { throw boom; } } });
    let received = null;
    await mw({}, fakeRes(), (e) => { received = e; });
    assert.equal(received, boom);
  });
});
