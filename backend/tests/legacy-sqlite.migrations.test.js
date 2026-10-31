/**
 * [DETERMINISTIC SOFTWARE TESTS] — the LEGACY SQLite migration runner (scripts/legacy-sqlite).
 * The application runs on PostgreSQL; this runner is kept only because the SQLite -> PostgreSQL importer uses it to
 * bring an old SQLite file (on a temporary copy) up to date before importing. These prove it still behaves correctly
 * against a real SQLite engine. PostgreSQL migrations are tested in postgres.migrations.test.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SKIP_REASON, openTempDb, seedLegacyDatabase, snapshotTables, makeTempDir, LEGACY_TABLES } = require('./helpers/testDb');

const quiet = () => {};
const latestVersion = () => loadMigrator().loadMigrations().length;
// Migrations after 003 ADD columns to protocols/protocol_versions. The guarantee under test is that every ORIGINAL
// column of every original row is unchanged, so compare each row projected onto the columns it had before.
const onOriginalColumns = (afterRows, beforeRows) => afterRows.map((r) => Object.fromEntries(Object.keys(beforeRows[0] || {}).map((k) => [k, r[k]])));
const loadMigrator = () => require('../scripts/legacy-sqlite/migrate'); // eslint-disable-line global-require

describe('[DETERMINISTIC] migrations on a brand-new database', { skip: SKIP_REASON }, () => {
  it('applies everything, ends at the latest version, and takes no backup (nothing to back up)', () => {
    const { runMigrations, loadMigrations } = loadMigrator();
    const t = openTempDb();
    try {
      const result = runMigrations(t.db, { dbFile: t.file, log: quiet });
      assert.equal(result.from, 0);
      assert.equal(result.to, loadMigrations().length);
      assert.equal(result.backupPath, null);
      assert.equal(t.db.pragma('user_version', { simple: true }), loadMigrations().length);
      assert.equal(fs.existsSync(path.join(t.dir, 'backups')), false);

      const tables = t.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
      for (const name of [...LEGACY_TABLES, 'feature_flags']) assert.ok(tables.includes(name), `missing table ${name}`);
    } finally { t.cleanup(); }
  });

  it('is idempotent: running again does nothing and creates no backup', () => {
    const { runMigrations } = loadMigrator();
    const t = openTempDb();
    try {
      runMigrations(t.db, { dbFile: t.file, log: quiet });
      const again = runMigrations(t.db, { dbFile: t.file, log: quiet });
      assert.deepEqual(again.applied, []);
      assert.equal(again.backupPath, null);
      assert.equal(fs.existsSync(path.join(t.dir, 'backups')), false);
    } finally { t.cleanup(); }
  });

  it('accepts the admin role and still rejects unknown roles', () => {
    const { runMigrations } = loadMigrator();
    const t = openTempDb();
    try {
      runMigrations(t.db, { dbFile: t.file, log: quiet });
      const ins = t.db.prepare('INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)');
      ins.run('a1', 'A', 'a@example.com', 'h', 'admin');
      assert.throws(() => ins.run('x1', 'X', 'x@example.com', 'h', 'superuser'), /CHECK constraint/i);
    } finally { t.cleanup(); }
  });
});

describe('[DETERMINISTIC] migrating a populated LEGACY database (the pre-migration schema, user_version 0)', { skip: SKIP_REASON }, () => {
  function legacyMigrated() {
    const { runMigrations } = loadMigrator();
    const t = openTempDb();
    seedLegacyDatabase(t.db);
    assert.equal(t.db.pragma('user_version', { simple: true }), 0, 'precondition: legacy DB has user_version 0');
    const before = snapshotTables(t.db);
    const result = runMigrations(t.db, { dbFile: t.file, log: quiet });
    return { t, before, result };
  }

  it('preserves EVERY row of EVERY existing table, byte for byte', () => {
    const { t, before, result } = legacyMigrated();
    try {
      assert.equal(result.to, latestVersion());
      const after = snapshotTables(t.db);
      for (const table of LEGACY_TABLES) {
        assert.deepEqual(onOriginalColumns(after[table], before[table]), before[table], `data changed in table ${table}`);
      }
      // sanity: the data really was non-trivial
      assert.equal(before.users.length, 3);
      assert.equal(before.objects.length, 4);
    } finally { t.cleanup(); }
  });

  it('writes a backup BEFORE migrating, and the backup holds the complete pre-migration data (incl. WAL content)', () => {
    const { t, before, result } = legacyMigrated();
    try {
      assert.ok(result.backupPath, 'a backup path must be returned for an existing database');
      assert.ok(fs.existsSync(result.backupPath));
      assert.ok(path.basename(result.backupPath).includes(`pre-migration-v0-to-v${latestVersion()}`));

      const { openDatabase } = require('../scripts/legacy-sqlite/open'); // eslint-disable-line global-require
      const backup = openDatabase(result.backupPath);
      try {
        const inBackup = snapshotTables(backup);
        for (const table of LEGACY_TABLES) assert.deepEqual(inBackup[table], before[table], `backup missing/altered data in ${table}`);
        // it is a true PRE-migration snapshot: still the old schema, no flags table yet
        const names = backup.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
        assert.equal(names.includes('feature_flags'), false);
        assert.throws(
          () => backup.prepare('INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)').run('n', 'n', 'n@x.com', 'h', 'admin'),
          /CHECK constraint/i,
          'backup should still have the old role constraint'
        );
      } finally { backup.close(); }
    } finally { t.cleanup(); }
  });

  it('keeps every foreign key relationship intact and enforced (cascade + set-null still work)', () => {
    const { t } = legacyMigrated();
    try {
      assert.deepEqual(t.db.pragma('foreign_key_check'), [], 'foreign_key_check must be clean');
      assert.equal(t.db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys must be switched back ON');

      const fks = t.db.pragma('foreign_key_list(protocols)').map((r) => `${r.from}->${r.table}.${r.to}:${r.on_delete}`).sort();
      // the two original relationships must be intact (migration 005 adds two more: category and published version)
      assert.ok(fks.includes('doctor_id->users.id:CASCADE') && fks.includes('patient_id->users.id:SET NULL'), `original foreign keys lost: ${fks}`);
      assert.deepEqual(fks, ['category_id->categories.id:SET NULL', 'doctor_id->users.id:CASCADE', 'patient_id->users.id:SET NULL', 'published_version_id->protocol_versions.id:RESTRICT']);

      // deleting a patient must null protocols.patient_id (SET NULL) …
      t.db.prepare("DELETE FROM users WHERE id = 'u-pat1'").run();
      assert.equal(t.db.prepare("SELECT patient_id FROM protocols WHERE id='p-1'").get().patient_id, null);
      // … and deleting the doctor must cascade through protocols -> canvases -> objects/versions
      t.db.prepare("DELETE FROM users WHERE id = 'u-doc'").run();
      for (const table of ['protocols', 'canvases', 'objects', 'protocol_versions']) {
        assert.equal(t.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c, 0, `${table} should have cascaded away`);
      }
    } finally { t.cleanup(); }
  });

  it('still enforces unique emails, and now allows admin', () => {
    const { t } = legacyMigrated();
    try {
      const ins = t.db.prepare('INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)');
      assert.throws(() => ins.run('dup', 'D', 'doc@example.com', 'h', 'doctor'), /UNIQUE constraint/i);
      ins.run('adm', 'Admin', 'admin@example.com', 'h', 'admin');
      assert.equal(t.db.prepare("SELECT role FROM users WHERE id='adm'").get().role, 'admin');
    } finally { t.cleanup(); }
  });

  it('seeds the feature flags in the required initial state', () => {
    const { t } = legacyMigrated();
    try {
      const flags = Object.fromEntries(t.db.prepare('SELECT key, enabled FROM feature_flags').all().map((r) => [r.key, r.enabled]));
      assert.deepEqual(flags, {
        WEBSITE: 1, PROTOCOL_BROWSER: 1, ADMIN: 1, PROTOCOL_STUDIO: 1, DOWNLOAD: 1,
        AI_ASSESSMENT: 0, PAYMENTS: 0, CAMERA: 0, AR: 0, PATIENT_ACCOUNTS: 0, PATIENT_ASSIGNMENT: 0,
      });
    } finally { t.cleanup(); }
  });
});

describe('[DETERMINISTIC] migration safety behaviour', { skip: SKIP_REASON }, () => {
  it('a failing migration rolls back completely and leaves the version untouched', () => {
    const { runMigrations, loadMigrations } = loadMigrator();
    const t = openTempDb();
    try {
      const real = loadMigrations();
      runMigrations(t.db, { dbFile: t.file, log: quiet, migrations: real });
      const broken = { version: real.length + 1, name: 'broken', up(db) { db.exec('CREATE TABLE half_done (x INTEGER)'); throw new Error('boom'); }, modifiesSchema: true, requiresForeignKeysOff: false };

      assert.throws(() => runMigrations(t.db, { dbFile: t.file, log: quiet, migrations: [...real, broken] }), /boom/);
      assert.equal(t.db.pragma('user_version', { simple: true }), real.length);
      const leftover = t.db.prepare("SELECT name FROM sqlite_master WHERE name='half_done'").get();
      assert.equal(leftover, undefined, 'partial DDL must have been rolled back');
    } finally { t.cleanup(); }
  });

  it('a failing table-rebuild migration also rolls back and switches foreign keys back ON', () => {
    const { runMigrations, loadMigrations } = loadMigrator();
    const t = openTempDb();
    try {
      seedLegacyDatabase(t.db);
      const real = loadMigrations();
      const before = snapshotTables(t.db);
      const rebuildThatFails = {
        version: 2, name: 'bad_rebuild', requiresForeignKeysOff: true, modifiesSchema: true,
        up(db) { db.exec('DROP TABLE users'); throw new Error('rebuild failed midway'); },
      };
      assert.throws(() => runMigrations(t.db, { dbFile: t.file, log: quiet, migrations: [real[0], rebuildThatFails] }), /rebuild failed midway/);
      assert.equal(t.db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys must be restored after a failed rebuild');
      assert.deepEqual(snapshotTables(t.db), before, 'the DROP TABLE must have been rolled back with all data');
    } finally { t.cleanup(); }
  });

  it('aborts (and rolls back) if a rebuild would leave orphaned foreign keys — existing data never silently damaged', () => {
    const { runMigrations } = loadMigrator();
    const t = openTempDb();
    try {
      seedLegacyDatabase(t.db);
      t.db.pragma('foreign_keys = OFF');
      t.db.prepare("INSERT INTO protocols (id,name,doctor_id,protocol_type) VALUES ('orphan','Orphan','no-such-user','hand')").run();
      t.db.pragma('foreign_keys = ON');
      const usersBefore = snapshotTables(t.db, ['users']);

      assert.throws(() => runMigrations(t.db, { dbFile: t.file, log: quiet }), /foreign-key violation/i);
      assert.deepEqual(snapshotTables(t.db, ['users']), usersBefore, 'users table must be untouched');
      assert.equal(t.db.pragma('user_version', { simple: true }), 1, 'baseline applied, admin-role migration rolled back');
      assert.equal(t.db.pragma('foreign_keys', { simple: true }), 1);
    } finally { t.cleanup(); }
  });

  it('refuses to touch a database that is NEWER than the application', () => {
    const { runMigrations } = loadMigrator();
    const t = openTempDb();
    try {
      runMigrations(t.db, { dbFile: t.file, log: quiet });
      t.db.pragma('user_version = 99');
      assert.throws(() => runMigrations(t.db, { dbFile: t.file, log: quiet }), /newer|only knows up to/i);
      assert.equal(t.db.pragma('user_version', { simple: true }), 99, 'must not be modified or downgraded');
    } finally { t.cleanup(); }
  });

  it('never overwrites an existing backup file', () => {
    const { runMigrations, loadMigrations } = loadMigrator();
    const t = openTempDb();
    try {
      seedLegacyDatabase(t.db);
      const fixedNow = () => new Date('2030-01-02T03:04:05Z');
      const backupDir = path.join(t.dir, 'bk');
      fs.mkdirSync(backupDir);
      const collide = path.join(backupDir, `test.pre-migration-v0-to-v${loadMigrations().length}.20300102-030405.db`);
      fs.writeFileSync(collide, 'precious');
      const result = runMigrations(t.db, { dbFile: t.file, backupDir, now: fixedNow, log: quiet });
      assert.notEqual(result.backupPath, collide);
      assert.equal(fs.readFileSync(collide, 'utf8'), 'precious');
    } finally { t.cleanup(); }
  });

  it('getMigrationStatus is read-only and reports pending migrations for a legacy database', () => {
    const { getMigrationStatus } = loadMigrator();
    const t = openTempDb();
    try {
      seedLegacyDatabase(t.db);
      const before = snapshotTables(t.db);
      const s = getMigrationStatus(t.db);
      assert.equal(s.current, 0);
      assert.equal(s.upToDate, false);
      assert.equal(s.hasExistingTables, true);
      assert.deepEqual(s.pending, ['001_baseline', '002_users_admin_role', '003_feature_flags', '004_catalog_tables', '005_protocol_publishing', '006_condition_synonyms', '007_payment_access']);
      assert.deepEqual(snapshotTables(t.db), before);
      assert.equal(t.db.pragma('user_version', { simple: true }), 0);
    } finally { t.cleanup(); }
  });
});

describe('[DETERMINISTIC] migration file validation (no database needed)', () => {
  function tmpMigrationsDir(files) {
    const dir = makeTempDir();
    Object.entries(files).forEach(([name, body]) => fs.writeFileSync(path.join(dir, name), body));
    return dir;
  }
  const ok = (v) => `module.exports={version:${v},name:'m${v}',up(){}};`;

  it('the shipped migrations load and are numbered 1..N', () => {
    const { loadMigrations } = loadMigrator();
    assert.deepEqual(loadMigrations().map((m) => m.version), [1, 2, 3, 4, 5, 6, 7]);
  });
  it('rejects a gap in numbering', () => {
    const { loadMigrations } = loadMigrator();
    const dir = tmpMigrationsDir({ '001_a.js': ok(1), '003_c.js': ok(3) });
    assert.throws(() => loadMigrations(dir), /no gaps or duplicates/);
  });
  it('rejects a filename/version mismatch', () => {
    const { loadMigrations } = loadMigrator();
    const dir = tmpMigrationsDir({ '001_a.js': ok(2) });
    assert.throws(() => loadMigrations(dir), /does not match the filename/);
  });
  it('rejects a migration without up()', () => {
    const { loadMigrations } = loadMigrator();
    const dir = tmpMigrationsDir({ '001_a.js': 'module.exports={version:1,name:"a"};' });
    assert.throws(() => loadMigrations(dir), /up\(db\)/);
  });
});
