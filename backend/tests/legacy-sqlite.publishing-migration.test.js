/**
 * [DETERMINISTIC SOFTWARE TESTS] LEGACY SQLite migrations 004 (catalog tables) and 005 (protocol publishing), as used by
 * the SQLite -> PostgreSQL importer on a temporary copy of an old file: existing data survives, and SQLite enforces the
 * publishing rules. (The PostgreSQL equivalents are tested in postgres.migrations.test.js.)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SKIP_REASON, openTempDb, seedLegacyDatabase, snapshotTables, LEGACY_TABLES } = require('./helpers/testDb');

const quiet = () => {};
const migrator = () => require('../scripts/legacy-sqlite/migrate'); // eslint-disable-line global-require
const MIGRATIONS_DIR = path.join(__dirname, '..', 'scripts', 'legacy-sqlite', 'migrations');

const project = (afterRows, beforeRows) => afterRows.map((r) => Object.fromEntries(Object.keys(beforeRows[0] || {}).map((k) => [k, r[k]])));
const throwsMatching = (fn, re) => assert.throws(fn, (e) => re.test(String(e.message)), `expected an error matching ${re}`);

describe('[DETERMINISTIC] already-applied migrations are frozen', () => {
  // A migration that has run on someone's database must never change. If one of these fails, ADD a new migration instead of editing an old one.
  const PINNED = {
    '001_baseline.js': '9165a3a644fc5c17066fb7f197ce127d61c17b9e1e39475a28c17004182ef939',
    '001_baseline.sql': '50bc5273e7756a7311776d19d962a4dac4dbad30d4e4e3aa0f12447ac9a0d931',
    '002_users_admin_role.js': '3d3e9d61776e70afdde42ac46fca127e9eb53dd4c63bccb0803edf75bd96fcea',
    '003_feature_flags.js': '290a529c8e20a71697c3d835f9fd3b2bf7661a59e1f3511461f1765ed9e69db1',
  };
  for (const [file, hash] of Object.entries(PINNED)) {
    it(`${file} is byte-for-byte unchanged`, () => {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(MIGRATIONS_DIR, file))).digest('hex');
      assert.equal(actual, hash, `${file} was modified — applied migrations must never be edited`);
    });
  }
  it('the new migrations are numbered 004, 005, 006 and 007 and load in order', () => {
    const list = migrator().loadMigrations();
    assert.deepEqual(list.slice(3).map((m) => `${String(m.version).padStart(3, '0')}_${m.name}`), ['004_catalog_tables', '005_protocol_publishing', '006_condition_synonyms', '007_payment_access']);
  });
});

describe('[DETERMINISTIC] upgrading a populated legacy database through 004 and 005', { skip: SKIP_REASON }, () => {
  function upgraded(extraSeed) {
    const t = openTempDb();
    seedLegacyDatabase(t.db);
    if (extraSeed) extraSeed(t.db);
    const before = snapshotTables(t.db);
    const result = migrator().runMigrations(t.db, { dbFile: t.file, log: quiet });
    return { t, before, result, db: t.db };
  }

  it('every original column of every original row is unchanged (users, protocols, canvases, objects, versions)', () => {
    const { t, before, db } = upgraded();
    try {
      const after = snapshotTables(db);
      for (const table of LEGACY_TABLES) assert.deepEqual(project(after[table], before[table]), before[table], `data changed in ${table}`);
      assert.equal(before.protocols.length, 2); assert.equal(before.objects.length, 4); assert.equal(before.protocol_versions.length, 2);
    } finally { t.cleanup(); }
  });

  it('existing protocols keep their status (legacy "active" stays "active"), patient link, version counter and get safe defaults', () => {
    const { t, db } = upgraded();
    try {
      const p1 = db.prepare("SELECT * FROM protocols WHERE id='p-1'").get();
      assert.equal(p1.status, 'active');
      assert.equal(p1.patient_id, 'u-pat1');
      assert.equal(p1.current_version, 3);
      assert.equal(p1.published_version_id, null, 'nothing is published by the migration');
      assert.equal(p1.published_at, null);
      assert.equal(p1.short_description, '');
      assert.equal(p1.display_name, null);
      assert.equal(p1.category_id, null);
      assert.equal(db.prepare("SELECT status FROM protocols WHERE id='p-2'").get().status, 'draft');
    } finally { t.cleanup(); }
  });

  it('every existing protocol gets a valid, unique, deterministic slug (oldest first; duplicates and odd names handled)', () => {
    const { t, db } = upgraded((legacy) => {
      const ins = legacy.prepare('INSERT INTO protocols (id,name,doctor_id,protocol_type,created_at,updated_at) VALUES (?,?,?,?,?,?)');
      ins.run('p-3', 'Calm', 'u-doc', 'hand', '2024-03-01 00:00:00', '2024-03-01 00:00:00'); // same name as p-1 (created 2024-01-10)
      ins.run('p-4', 'Calm', 'u-doc', 'hand', '2024-04-01 00:00:00', '2024-04-01 00:00:00');
      ins.run('p-5', '  Sleep & Relax!! ', 'u-doc', 'hand', '2024-05-01 00:00:00', '2024-05-01 00:00:00');
      ins.run('p-6', '!!!', 'u-doc', 'hand', '2024-06-01 00:00:00', '2024-06-01 00:00:00');
    });
    try {
      const slugs = Object.fromEntries(db.prepare('SELECT id, slug FROM protocols').all().map((r) => [r.id, r.slug]));
      assert.deepEqual(slugs, { 'p-1': 'calm', 'p-2': 'sleep', 'p-3': 'calm-2', 'p-4': 'calm-3', 'p-5': 'sleep-and-relax', 'p-6': 'protocol' });
      assert.equal(new Set(Object.values(slugs)).size, 6);
    } finally { t.cleanup(); }
  });

  it('existing version history is kept and every old snapshot now has a matching SHA-256 checksum', () => {
    const { t, before, db } = upgraded();
    try {
      const versions = db.prepare('SELECT * FROM protocol_versions ORDER BY id').all();
      assert.equal(versions.length, 2);
      for (const v of versions) {
        assert.equal(v.kind, 'checkpoint');
        assert.equal(v.schema_version, 1, 'old snapshots are labelled as schema 1');
        assert.equal(v.checksum, crypto.createHash('sha256').update(v.snapshot_json, 'utf8').digest('hex'));
        assert.equal(v.snapshot_json, before.protocol_versions.find((b) => b.id === v.id).snapshot_json, 'snapshot text untouched');
      }
    } finally { t.cleanup(); }
  });

  it('keeps every foreign key intact, and adds category and published-version links', () => {
    const { t, db } = upgraded();
    try {
      assert.deepEqual(db.pragma('foreign_key_check'), []);
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
      const fk = (table) => db.pragma(`foreign_key_list(${table})`).map((r) => `${r.from}->${r.table}.${r.to}:${r.on_delete}`).sort();
      assert.deepEqual(fk('protocols'), ['category_id->categories.id:SET NULL', 'doctor_id->users.id:CASCADE', 'patient_id->users.id:SET NULL', 'published_version_id->protocol_versions.id:RESTRICT']);
      assert.deepEqual(fk('condition_protocols'), ['condition_id->conditions.id:CASCADE', 'protocol_id->protocols.id:CASCADE']);
      assert.deepEqual(fk('protocol_search_terms'), ['protocol_id->protocols.id:CASCADE']);
      assert.ok(fk('canvases').includes('protocol_id->protocols.id:CASCADE'), 'canvases still hang off the rebuilt protocols table');
    } finally { t.cleanup(); }
  });

  it('a fresh install reaches the latest version directly with no backup', () => {
    const t = openTempDb();
    try {
      const r = migrator().runMigrations(t.db, { dbFile: t.file, log: quiet });
      assert.equal(r.to, migrator().loadMigrations().length);
      assert.equal(r.backupPath, null);
      const tables = t.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
      for (const name of ['categories', 'conditions', 'condition_protocols', 'protocol_search_terms']) assert.ok(tables.includes(name), name);
    } finally { t.cleanup(); }
  });

  it('is safe if 005 cannot complete: orphaned data aborts it, rolls everything back, and the database stays at version 4', () => {
    const t = openTempDb();
    try {
      const { runMigrations, loadMigrations } = migrator();
      const all = loadMigrations();
      seedLegacyDatabase(t.db);
      runMigrations(t.db, { dbFile: t.file, log: quiet, migrations: all.slice(0, 4) });
      t.db.pragma('foreign_keys = OFF');
      t.db.prepare("INSERT INTO protocols (id,name,doctor_id,protocol_type) VALUES ('orphan','Orphan','ghost','hand')").run();
      t.db.pragma('foreign_keys = ON');
      const before = snapshotTables(t.db);

      throwsMatching(() => runMigrations(t.db, { dbFile: t.file, log: quiet }), /foreign-key violation/i);
      assert.equal(t.db.pragma('user_version', { simple: true }), 4);
      assert.equal(t.db.pragma('foreign_keys', { simple: true }), 1);
      assert.deepEqual(snapshotTables(t.db), before, 'no table changed');
      const cols = t.db.pragma('table_info(protocols)').map((c) => c.name);
      assert.ok(!cols.includes('slug'), 'the protocols table was not half-rebuilt');
      assert.equal(t.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name LIKE 'protocol_versions_no_%'").get().c, 0, 'no trigger was left behind');
    } finally { t.cleanup(); }
  });
});

describe('[DETERMINISTIC] constraints the database enforces by itself', { skip: SKIP_REASON }, () => {
  function fresh() {
    const t = openTempDb();
    migrator().runMigrations(t.db, { dbFile: t.file, log: quiet });
    const db = t.db;
    db.prepare("INSERT INTO users (id,name,email,password_hash,role) VALUES ('u','U','u@x.com','h','admin')").run();
    const proto = (id, slug) => db.prepare("INSERT INTO protocols (id,name,slug,doctor_id,protocol_type) VALUES (?,?,?,'u','hand')").run(id, id, slug);
    const version = (id, protocolId, n, kind = 'checkpoint') => db.prepare("INSERT INTO protocol_versions (id,protocol_id,version,snapshot_json,kind,schema_version,checksum) VALUES (?,?,?,'{}',?,2,'c')").run(id, protocolId, n, kind);
    return { t, db, proto, version };
  }

  it('slugs are unique for protocols, categories and conditions, and must be lowercase', () => {
    const { t, db, proto } = fresh();
    try {
      proto('p1', 'one');
      throwsMatching(() => proto('p2', 'one'), /UNIQUE constraint/i);
      throwsMatching(() => proto('p3', 'Upper'), /CHECK constraint/i);
      db.prepare("INSERT INTO categories (id,name,slug) VALUES ('c1','C','cat')").run();
      throwsMatching(() => db.prepare("INSERT INTO categories (id,name,slug) VALUES ('c2','C2','cat')").run(), /UNIQUE constraint/i);
      db.prepare("INSERT INTO conditions (id,name,slug) VALUES ('d1','D','cond')").run();
      throwsMatching(() => db.prepare("INSERT INTO conditions (id,name,slug) VALUES ('d2','D2','cond')").run(), /UNIQUE constraint/i);
      throwsMatching(() => db.prepare("INSERT INTO conditions (id,name,slug) VALUES ('d3','D3','')").run(), /CHECK constraint/i);
    } finally { t.cleanup(); }
  });

  it('the same condition <-> protocol link cannot be inserted twice, but many-to-many works', () => {
    const { t, db, proto } = fresh();
    try {
      proto('p1', 'one'); proto('p2', 'two');
      db.prepare("INSERT INTO conditions (id,name,slug) VALUES ('d1','D1','d1'), ('d2','D2','d2')").run();
      const link = db.prepare('INSERT INTO condition_protocols (condition_id, protocol_id) VALUES (?, ?)');
      link.run('d1', 'p1'); link.run('d2', 'p1'); link.run('d1', 'p2'); // a protocol has many conditions; a condition has many protocols
      throwsMatching(() => link.run('d1', 'p1'), /UNIQUE constraint/i);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM condition_protocols').get().c, 3);
      throwsMatching(() => link.run('nope', 'p1'), /FOREIGN KEY/i);
      // deleting a condition or a (never-published) protocol removes only the links
      db.prepare("DELETE FROM conditions WHERE id='d1'").run();
      assert.equal(db.prepare('SELECT COUNT(*) c FROM condition_protocols').get().c, 1);
      db.prepare("DELETE FROM protocols WHERE id='p1'").run();
      assert.equal(db.prepare('SELECT COUNT(*) c FROM condition_protocols').get().c, 0);
    } finally { t.cleanup(); }
  });

  it('there are no patient-specific disease records: conditions and links carry no patient data', () => {
    const { t, db } = fresh();
    try {
      for (const table of ['conditions', 'condition_protocols', 'categories', 'protocol_search_terms']) {
        const cols = db.pragma(`table_info(${table})`).map((c) => c.name);
        assert.ok(!cols.some((c) => /patient|user/i.test(c)), `${table} has a patient/user column: ${cols}`);
      }
    } finally { t.cleanup(); }
  });

  it('a search term is unique per protocol (normalized text) but may repeat across protocols', () => {
    const { t, db, proto } = fresh();
    try {
      proto('p1', 'one'); proto('p2', 'two');
      const ins = db.prepare('INSERT INTO protocol_search_terms (id,protocol_id,term,term_normalized) VALUES (?,?,?,?)');
      ins.run('t1', 'p1', 'Migraine', 'migraine');
      throwsMatching(() => ins.run('t2', 'p1', 'MIGRAINE', 'migraine'), /UNIQUE constraint/i);
      ins.run('t3', 'p2', 'Migraine', 'migraine');
      throwsMatching(() => db.prepare("INSERT INTO protocol_search_terms (id,protocol_id,term,term_normalized,kind) VALUES ('t4','p1','x','x','bogus')").run(), /CHECK constraint/i);
    } finally { t.cleanup(); }
  });

  it('protocol_versions rows can never be UPDATED', () => {
    const { t, db, proto, version } = fresh();
    try {
      proto('p1', 'one'); version('v1', 'p1', 1);
      for (const sql of ["UPDATE protocol_versions SET snapshot_json = '{\"x\":1}'", "UPDATE protocol_versions SET checksum = 'z'", "UPDATE protocol_versions SET kind = 'published'", "UPDATE protocol_versions SET version = 9"]) {
        throwsMatching(() => db.prepare(sql).run(), /immutable/i);
      }
      assert.equal(db.prepare("SELECT snapshot_json FROM protocol_versions WHERE id='v1'").get().snapshot_json, '{}');
    } finally { t.cleanup(); }
  });

  it('a version cannot be deleted while its protocol exists; a never-published protocol can still be deleted with its history', () => {
    const { t, db, proto, version } = fresh();
    try {
      proto('p1', 'one'); version('v1', 'p1', 1); version('v2', 'p1', 2);
      throwsMatching(() => db.prepare("DELETE FROM protocol_versions WHERE id='v1'").run(), /cannot be deleted/i);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM protocol_versions').get().c, 2);
      db.prepare("DELETE FROM protocols WHERE id='p1'").run();
      assert.equal(db.prepare('SELECT COUNT(*) c FROM protocol_versions').get().c, 0);
    } finally { t.cleanup(); }
  });

  it('published_version_id must name a PUBLISHED version of the SAME protocol; status "published" requires it', () => {
    const { t, db, proto, version } = fresh();
    try {
      proto('p1', 'one'); proto('p2', 'two');
      version('cp', 'p1', 1, 'checkpoint'); version('pub1', 'p1', 2, 'published'); version('pub2', 'p2', 1, 'published');
      const point = (protocolId, versionId) => db.prepare('UPDATE protocols SET published_version_id = ? WHERE id = ?').run(versionId, protocolId);
      throwsMatching(() => point('p1', 'cp'), /published version of this protocol/i);
      throwsMatching(() => point('p1', 'pub2'), /published version of this protocol/i);
      throwsMatching(() => point('p1', 'does-not-exist'), /published version of this protocol|FOREIGN KEY/i);
      throwsMatching(() => db.prepare("UPDATE protocols SET status = 'published' WHERE id = 'p1'").run(), /CHECK constraint/i);
      db.prepare("UPDATE protocols SET status = 'published', published_version_id = 'pub1' WHERE id = 'p1'").run();
      assert.equal(db.prepare("SELECT status FROM protocols WHERE id='p1'").get().status, 'published');
      // cannot be inserted already-pointing at someone else's version either
      throwsMatching(() => db.prepare("INSERT INTO protocols (id,name,slug,doctor_id,protocol_type,published_version_id) VALUES ('p3','p3','three','u','hand','pub1')").run(), /published version of this protocol/i);
    } finally { t.cleanup(); }
  });

  it('a protocol that has been published cannot be deleted (directly, or by deleting its owner)', () => {
    const { t, db, proto, version } = fresh();
    try {
      proto('p1', 'one'); version('pub1', 'p1', 1, 'published');
      db.prepare("UPDATE protocols SET status='published', published_version_id='pub1' WHERE id='p1'").run();
      throwsMatching(() => db.prepare("DELETE FROM protocols WHERE id='p1'").run(), /cannot be deleted; archive it instead/i);
      throwsMatching(() => db.prepare("DELETE FROM users WHERE id='u'").run(), /cannot be deleted; archive it instead/i);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM protocol_versions').get().c, 1);
      // archiving is fine and keeps the pointer/history
      db.prepare("UPDATE protocols SET status='archived' WHERE id='p1'").run();
      assert.equal(db.prepare("SELECT published_version_id FROM protocols WHERE id='p1'").get().published_version_id, 'pub1');
    } finally { t.cleanup(); }
  });

  it('the status column accepts the four lifecycle values plus legacy "active" and nothing else', () => {
    const { t, db, proto } = fresh();
    try {
      proto('p1', 'one');
      for (const s of ['draft', 'in_review', 'archived', 'active']) db.prepare('UPDATE protocols SET status = ? WHERE id = ?').run(s, 'p1');
      throwsMatching(() => db.prepare("UPDATE protocols SET status = 'live' WHERE id = 'p1'").run(), /CHECK constraint/i);
    } finally { t.cleanup(); }
  });
});
