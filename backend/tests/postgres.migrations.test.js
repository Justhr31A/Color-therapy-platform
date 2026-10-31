/**
 * [DETERMINISTIC SOFTWARE TESTS — real PostgreSQL] the PostgreSQL migration runner and the final schema.
 * Fresh migration, idempotent re-run, concurrent runners, a failing migration rolling back, refusal of a newer
 * schema, and that the final schema matches what the application (and the old SQLite schema) relies on.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { missingReason } = require('./helpers/testDb');
const { openTestDatabase } = require('./helpers/pg');

const SKIP = missingReason('pg');
const migrator = () => require('../src/db/postgres-migrate'); // eslint-disable-line global-require

const column = (t, table, name) => t.row(
  `SELECT data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, table, name
);

describe('[DETERMINISTIC] PostgreSQL migrations on a brand-new database', { skip: SKIP }, () => {
  it('apply 1..N in order on an empty database, record each one, and a second run changes nothing', async () => {
    const t = await openTestDatabase({ migrated: false });
    try {
      const { runPostgresMigrations, listMigrationFiles, getPostgresMigrationStatus } = migrator();
      const logs = [];
      const rows = await runPostgresMigrations({ pool: t.pool, log: (m) => logs.push(m) });
      const files = listMigrationFiles();
      assert.deepEqual(rows.map((r) => r.version), files.map((f) => f.version));
      assert.equal(logs.length, files.length, 'one "applied" line per migration');

      const tablesBefore = await t.rows("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1");
      const again = [];
      await runPostgresMigrations({ pool: t.pool, log: (m) => again.push(m) });
      assert.deepEqual(again, [], 'nothing re-applied');
      assert.deepEqual(await t.rows("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1"), tablesBefore);
      const s = await getPostgresMigrationStatus({ pool: t.pool });
      assert.equal(s.upToDate, true);
      assert.equal(s.current, files.length);
      assert.deepEqual(s.pending, []);
    } finally { await t.cleanup(); }
  });

  it('two runners started at the same moment apply every migration exactly once (advisory lock)', async () => {
    const t = await openTestDatabase({ migrated: false });
    try {
      const { runPostgresMigrations, listMigrationFiles } = migrator();
      const [a, b] = await Promise.all([runPostgresMigrations({ pool: t.pool, log: () => {} }), runPostgresMigrations({ pool: t.pool, log: () => {} })]);
      assert.deepEqual(a.map((r) => r.version), b.map((r) => r.version));
      assert.equal((await t.row('SELECT COUNT(*)::integer AS n FROM app_schema_migrations')).n, listMigrationFiles().length);
    } finally { await t.cleanup(); }
  });

  it('seeds exactly what the SQLite migrations seeded: 11 flags with their defaults, one FREE/INR payment settings row', async () => {
    const t = await openTestDatabase();
    try {
      const { FLAG_DEFINITIONS, FLAG_KEYS } = require('../src/services/featureFlagDefinitions'); // eslint-disable-line global-require
      const flags = await t.rows('SELECT key, enabled, description FROM feature_flags');
      assert.deepEqual(flags.map((f) => f.key).sort(), [...FLAG_KEYS].sort());
      for (const f of flags) {
        assert.equal(f.enabled === 1, FLAG_DEFINITIONS[f.key].default, f.key);
        assert.equal(f.description, FLAG_DEFINITIONS[f.key].description, f.key);
      }
      assert.deepEqual(await t.rows('SELECT id, mode, access_enabled, amount_minor, currency, provider FROM payment_settings'),
        [{ id: 1, mode: 'FREE', access_enabled: 1, amount_minor: null, currency: 'INR', provider: null }]);
    } finally { await t.cleanup(); }
  });
});

describe('[DETERMINISTIC] PostgreSQL migration safety', { skip: SKIP }, () => {
  it('a failing migration is rolled back completely and nothing after it runs', async () => {
    const t = await openTestDatabase({ migrated: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-mig-'));
    try {
      fs.writeFileSync(path.join(dir, '001_ok.sql'), 'CREATE TABLE ok_table (id INTEGER PRIMARY KEY);');
      fs.writeFileSync(path.join(dir, '002_broken.sql'), 'CREATE TABLE half_done (id INTEGER); INSERT INTO no_such_table VALUES (1);');
      fs.writeFileSync(path.join(dir, '003_never.sql'), 'CREATE TABLE never_created (id INTEGER);');
      const { runPostgresMigrations } = migrator();
      await assert.rejects(runPostgresMigrations({ pool: t.pool, dir, log: () => {} }), /Migration 002_broken\.sql failed/);
      const tables = (await t.rows("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).map((r) => r.table_name);
      assert.deepEqual(tables, ['app_schema_migrations', 'ok_table'], 'the half-done table was rolled back and 003 never ran');
      assert.deepEqual((await t.rows('SELECT version FROM app_schema_migrations')).map((r) => r.version), [1]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); await t.cleanup(); }
  });

  it('refuses a database whose schema is NEWER than this code, and refuses a gap in the numbering', async () => {
    const t = await openTestDatabase();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-mig-'));
    try {
      const { runPostgresMigrations, listMigrationFiles } = migrator();
      await t.run('INSERT INTO app_schema_migrations (version, name) VALUES (999, $1)', '999_from_the_future.sql');
      await assert.rejects(runPostgresMigrations({ pool: t.pool, log: () => {} }), /NEWER than this application/);
      fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;');
      fs.writeFileSync(path.join(dir, '003_c.sql'), 'SELECT 1;');
      assert.throws(() => listMigrationFiles(dir), /sequence gap/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); await t.cleanup(); }
  });

  it('the server refuses to start without DATABASE_URL — there is no fallback database', async () => {
    const { spawnSync } = require('child_process'); // eslint-disable-line global-require
    const env = { ...process.env, PORT: '0', JWT_SECRET: 'x'.repeat(40) };
    delete env.DATABASE_URL;
    const r = spawnSync(process.execPath, ['src/server.js'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /DATABASE_URL is required/);
    assert.doesNotMatch(r.stdout + r.stderr, /sqlite/i);
  });
});

describe('[DETERMINISTIC] the final PostgreSQL schema matches what the application relies on', { skip: SKIP }, () => {
  it('coordinates/sizes are 8-byte doubles (like SQLite REAL), and z_index holds Date.now() values', async () => {
    const t = await openTestDatabase();
    try {
      for (const c of ['x', 'y', 'width', 'height', 'rotation', 'thickness', 'opacity', 'z_index']) {
        assert.equal((await column(t, 'objects', c)).data_type, 'double precision', `objects.${c}`);
      }
      for (const c of ['width', 'height']) assert.equal((await column(t, 'canvases', c)).data_type, 'double precision', `canvases.${c}`);
      assert.equal((await column(t, 'payment_orders', 'amount_minor')).data_type, 'bigint');
      assert.equal((await column(t, 'payment_settings', 'amount_minor')).data_type, 'bigint');
      assert.equal((await column(t, 'categories', 'sort_order')).data_type, 'bigint');
    } finally { await t.cleanup(); }
  });

  it('defaults and NULL rules match the SQLite schema (objects defaults, nullable protocol description, UTC timestamps)', async () => {
    const t = await openTestDatabase();
    try {
      await t.run("INSERT INTO users (id,name,email,role) VALUES ('u','U','u@x.com','doctor')");
      await t.run("INSERT INTO protocols (id,name,slug,description,doctor_id,protocol_type) VALUES ('p','P','p',NULL,'u','hand')");
      await t.run("INSERT INTO canvases (id,protocol_id,canvas_type,view_key,background_asset_key,width,height) VALUES ('c','p','hand','left_front','left_front',1586,1982)");
      await t.run("INSERT INTO objects (id,canvas_id,object_type) VALUES ('o','c','dot')");
      const o = await t.row('SELECT x, y, rotation, color, thickness, opacity, z_index, created_at FROM objects');
      assert.deepEqual({ ...o, created_at: undefined }, { x: 0, y: 0, rotation: 0, color: '#e5484d', thickness: 3, opacity: 1, z_index: 0, created_at: undefined });
      assert.match(o.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'timestamps come back in the SQLite text format');
      const utc = await t.row("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS now_utc");
      assert.equal(o.created_at.slice(0, 16), utc.now_utc, 'stored in UTC, whatever the session time zone');
      assert.equal((await t.row("SELECT description FROM protocols WHERE id = 'p'")).description, null);
      await assert.rejects(t.run("INSERT INTO canvases (id,protocol_id,canvas_type,view_key,background_asset_key,width,height) VALUES ('c2','p','hand','right_front',NULL,1,1)"), /null value/);
    } finally { await t.cleanup(); }
  });

  it('the database itself enforces the publishing rules (immutable history, published pointer, no deleting a published protocol)', async () => {
    const t = await openTestDatabase();
    try {
      await t.run("INSERT INTO users (id,name,email,role) VALUES ('u','U','u@x.com','doctor')");
      await t.run("INSERT INTO protocols (id,name,slug,doctor_id,protocol_type) VALUES ('p','P','p','u','hand'), ('q','Q','q','u','hand')");
      await t.run("INSERT INTO protocol_versions (id,protocol_id,version,snapshot_json,kind,checksum) VALUES ('v1','p',1,'{}','checkpoint','x'), ('v2','p',2,'{}','published','y'), ('w1','q',1,'{}','published','z')");
      await assert.rejects(t.run("UPDATE protocols SET status = 'published' WHERE id = 'p'"), /protocols_published_requires_version/);
      await assert.rejects(t.run("UPDATE protocols SET published_version_id = 'v1', status = 'published' WHERE id = 'p'"), /must reference a published version/);
      await assert.rejects(t.run("UPDATE protocols SET published_version_id = 'w1', status = 'published' WHERE id = 'p'"), /must reference a published version/);
      await t.run("UPDATE protocols SET published_version_id = 'v2', status = 'published' WHERE id = 'p'");
      await assert.rejects(t.run("UPDATE protocol_versions SET note = 'x' WHERE id = 'v1'"), /immutable/);
      await assert.rejects(t.run("DELETE FROM protocol_versions WHERE id = 'v1'"), /cannot be deleted/);
      await assert.rejects(t.run("DELETE FROM protocols WHERE id = 'p'"), /archive it instead/);
      await assert.rejects(t.run("INSERT INTO protocols (id,name,slug,doctor_id,protocol_type) VALUES ('r','R','P','u','hand')"), /protocols_slug_format_check/);
      await assert.rejects(t.run("INSERT INTO protocols (id,name,slug,doctor_id,protocol_type) VALUES ('r','R','q','u','hand')"), /idx_protocols_slug/);
      // a never-published protocol can be deleted, and its history goes with it (cascade is allowed past the trigger)
      await t.run("DELETE FROM protocols WHERE id = 'q'");
      assert.equal((await t.row("SELECT COUNT(*) AS n FROM protocol_versions WHERE protocol_id = 'q'")).n, 0);
    } finally { await t.cleanup(); }
  });
});
