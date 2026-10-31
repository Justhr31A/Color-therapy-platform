/**
 * [DETERMINISTIC SOFTWARE TESTS — real SQLite source + real PostgreSQL target] the one-off SQLite -> PostgreSQL importer
 * (scripts/legacy-sqlite/importer.js): data integrity, publishing state, dry run, refusals and rollback.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const { missingReason, openTempDb } = require('./helpers/testDb');
const { openTestDatabase } = require('./helpers/pg');

const SKIP = missingReason('pg', 'better-sqlite3', 'uuid');
const importer = () => require('../scripts/legacy-sqlite/importer'); // eslint-disable-line global-require
const fileHash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const Z = 1761234567890; // a real builder z-index (Date.now())

/**
 * A SQLite file exactly as the current (pre-PostgreSQL) app would have left it — schema version 7 — with data in every
 * table: a published protocol (real schema-2 snapshot + checksum), a protocol archived after publishing, a draft with
 * terms and a condition, objects with full-precision coordinates and equal Date.now() z-indexes, payments and flags.
 */
function buildModernSqlite() {
  const { runMigrations } = require('../scripts/legacy-sqlite/migrate'); // eslint-disable-line global-require
  const { buildSnapshot, canonicalStringify, sha256Hex } = require('../src/protocol/snapshot'); // eslint-disable-line global-require
  const { serializeCanvasRow } = require('../src/utils/serialize'); // eslint-disable-line global-require
  const t = openTempDb();
  runMigrations(t.db, { dbFile: t.file, log: () => {} });
  const db = t.db;
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run("INSERT INTO users (id,name,email,password_hash,role,status,created_at,updated_at) VALUES ('adm','Admin','admin@example.com','h-a','admin','active','2025-01-01 09:00:00','2025-01-02 09:00:00')");
  run("INSERT INTO users (id,name,email,password_hash,role,status,created_at,updated_at) VALUES ('doc','Doc','doc@example.com','h-d','doctor','active','2025-01-03 09:00:00','2025-01-03 09:00:00')");
  run("INSERT INTO users (id,name,email,password_hash,role,status) VALUES ('pat','Pat','pat@example.com',NULL,'patient','pending')");
  run("INSERT INTO categories (id,name,slug,description,is_active,sort_order) VALUES ('cat','Head & Neck','head-and-neck','',1,3)");
  run("INSERT INTO categories (id,name,slug,description,is_active,sort_order) VALUES ('cat2','Old','old','',0,9)");
  run(`INSERT INTO conditions (id,name,slug,description,category_id,is_active,synonyms_json) VALUES ('cond','Migraine','migraine','','cat',1,'["sick headache"]')`);

  const mkProtocol = (id, name, slug, status) => {
    run("INSERT INTO protocols (id,name,slug,display_name,short_description,description,category_id,metadata_json,doctor_id,patient_id,protocol_type,status,current_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, name, slug, `${name} display`, 'short', null, 'cat', '{"public":{"note":"n"}}', 'doc', id === 'p-draft' ? 'pat' : null, 'hand', status, 1, '2025-02-01 10:00:00', '2025-02-02 11:00:00');
    ['left_front', 'right_front', 'left_back', 'right_back'].forEach((v, i) => run('INSERT INTO canvases (id,protocol_id,canvas_type,view_key,background_asset_key,width,height,sort_order) VALUES (?,?,?,?,?,?,?,?)', `${id}-${v}`, id, 'hand', v, v, 1586, 1982, i));
    // equal z-index (Date.now()) and ids that sort the OTHER way from insertion order
    run("INSERT INTO objects (id,canvas_id,object_type,x,y,width,height,rotation,color,thickness,opacity,finger,metadata_json,z_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      `${id}-zz`, `${id}-left_front`, 'dot', 0.4578123456789012, 0.5, 0.03, 0.03, 0, '#e5484d', 0, 1, 'pinky', '{}', Z);
    run("INSERT INTO objects (id,canvas_id,object_type,x,y,width,height,rotation,color,thickness,opacity,metadata_json,z_index) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      `${id}-aa`, `${id}-left_front`, 'ring', 0.25, 0.75, 0.08, 0.08, 15.5, '#1a73e8', 4, 0.8, '{}', Z);
  };
  mkProtocol('p-pub', 'Published One', 'published-one', 'draft');
  mkProtocol('p-arch', 'Archived One', 'archived-one', 'draft');
  mkProtocol('p-draft', 'Draft One', 'draft-one', 'draft');
  run("INSERT INTO protocol_search_terms (id,protocol_id,term,term_normalized,kind) VALUES ('t1','p-draft','Sick Headache','sick headache','synonym')");
  run("INSERT INTO condition_protocols (condition_id,protocol_id) VALUES ('cond','p-pub'), ('cond','p-draft')");

  // publish p-pub and p-arch with a REAL snapshot built by the app's own code from the rows above
  const publish = (id, version) => {
    const protocol = db.prepare('SELECT * FROM protocols WHERE id = ?').get(id);
    const working = {
      protocol,
      category: db.prepare('SELECT * FROM categories WHERE id = ?').get(protocol.category_id),
      conditions: db.prepare('SELECT c.* FROM conditions c JOIN condition_protocols cp ON cp.condition_id = c.id WHERE cp.protocol_id = ? ORDER BY c.slug').all(id),
      searchTerms: db.prepare('SELECT * FROM protocol_search_terms WHERE protocol_id = ? ORDER BY term_normalized').all(id),
      canvases: db.prepare('SELECT * FROM canvases WHERE protocol_id = ? ORDER BY sort_order, id').all(id)
        .map((c) => serializeCanvasRow(c, db.prepare('SELECT * FROM objects WHERE canvas_id = ? ORDER BY z_index, id').all(c.id))),
    };
    const json = canonicalStringify(buildSnapshot(working, { status: 'published', kind: 'published', versionNumber: version }));
    run("INSERT INTO protocol_versions (id,protocol_id,version,snapshot_json,kind,schema_version,created_by,checksum,created_at) VALUES (?,?,?,?,'published',2,'adm',?,'2025-03-01 12:00:00')",
      `${id}-v${version}`, id, version, json, sha256Hex(json));
    run("UPDATE protocols SET status = 'published', published_version_id = ?, published_at = '2025-03-01 12:00:00', current_version = ? WHERE id = ?", `${id}-v${version}`, version, id);
  };
  ['p-pub', 'p-arch', 'p-draft'].forEach((id) => run("INSERT INTO protocol_versions (id,protocol_id,version,snapshot_json,checksum,created_at) VALUES (?,?,1,'{\"canvases\":[]}',?,'2025-02-01 10:00:00')", `${id}-v1`, id, sha256Hex('{"canvases":[]}')));
  publish('p-pub', 2);
  publish('p-arch', 2);
  run("UPDATE protocols SET status = 'archived' WHERE id = 'p-arch'"); // archived AFTER publishing: keeps its pointer

  run("UPDATE feature_flags SET enabled = 1, updated_by = 'adm', updated_at = '2025-04-01 08:00:00' WHERE key IN ('CAMERA','AR','AI_ASSESSMENT')");
  run("UPDATE payment_settings SET amount_minor = 19950, updated_by = 'adm' WHERE id = 1");
  run("INSERT INTO payment_orders (id,user_id,protocol_id,protocol_version_id,amount_minor,currency,status,mode,provider,completed_at) VALUES ('ord1','pat','p-pub','p-pub-v2',0,'INR','free','FREE','free','2025-05-01T10:20:30.123Z')");
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return t;
}

describe('[DETERMINISTIC] importing a current-version SQLite database', { skip: SKIP }, () => {
  it('copies every table row-for-row, keeps publishing state (including an archived-after-publish protocol), and never touches the source', async () => {
    const src = buildModernSqlite();
    const target = await openTestDatabase({ migrated: false });
    try {
      const before = fileHash(src.file);
      const result = await importer().importSqliteToPostgres({ sourcePath: src.file, pool: target.pool, log: () => {} });
      assert.equal(result.committed, true);
      assert.deepEqual(result.warnings, []);
      assert.equal(fileHash(src.file), before, 'source unchanged');
      const rows = Object.fromEntries(result.report.map((r) => [r.table, r.rows]));
      assert.deepEqual(rows, {
        users: 3, categories: 2, protocols: 3, canvases: 12, objects: 6, protocol_versions: 5, conditions: 1,
        condition_protocols: 2, protocol_search_terms: 1, feature_flags: 11, payment_settings: 1, payment_orders: 1,
      });

      const p = Object.fromEntries((await target.rows('SELECT id, status, published_version_id, published_at, description, updated_at FROM protocols')).map((r) => [r.id, r]));
      assert.deepEqual(p['p-pub'], { id: 'p-pub', status: 'published', published_version_id: 'p-pub-v2', published_at: '2025-03-01 12:00:00', description: null, updated_at: '2025-02-02 11:00:00' });
      assert.equal(p['p-arch'].status, 'archived');
      assert.equal(p['p-arch'].published_version_id, 'p-arch-v2', 'an archived protocol keeps its published history (and stays undeletable)');
      await assert.rejects(target.run("DELETE FROM protocols WHERE id = 'p-arch'"), /archive it instead/);

      const objs = await target.rows("SELECT id, x, z_index, finger FROM objects WHERE canvas_id = 'p-pub-left_front' ORDER BY z_index, insert_seq");
      assert.deepEqual(objs.map((o) => o.id), ['p-pub-zz', 'p-pub-aa'], 'saved (rowid) order kept for equal z-index');
      assert.equal(objs[0].x, 0.4578123456789012);
      assert.equal(objs[0].z_index, Z);
      assert.equal(objs[0].finger, 'pinky');

      const flags = Object.fromEntries((await target.rows('SELECT key, enabled, updated_by FROM feature_flags')).map((f) => [f.key, f]));
      assert.deepEqual([flags.CAMERA.enabled, flags.AR.enabled, flags.AR.updated_by, flags.PAYMENTS.enabled], [1, 1, 'adm', 0]);
      assert.equal((await target.row('SELECT amount_minor FROM payment_settings')).amount_minor, 19950);
      assert.equal((await target.row("SELECT completed_at FROM payment_orders WHERE id = 'ord1'")).completed_at, '2025-05-01 10:20:30');
    } finally { await target.cleanup(); src.cleanup(); }
  });

  it('the imported data works in the application: the published protocol is served publicly and matches its working copy', async () => {
    const src = buildModernSqlite();
    const target = await openTestDatabase({ migrated: false });
    try {
      await importer().importSqliteToPostgres({ sourcePath: src.file, pool: target.pool, log: () => {} });
      const { createPublicProtocolService } = require('../src/services/publicProtocols'); // eslint-disable-line global-require
      const { createProtocolService } = require('../src/services/protocolService'); // eslint-disable-line global-require
      const pub = createPublicProtocolService(target.db);
      const detail = await pub.getDetail('published-one');
      assert.ok(detail, 'served: the checksum of the imported snapshot verifies');
      assert.equal(await pub.getDetail('archived-one'), null, 'archived stays private');
      assert.equal(await pub.getDetail('draft-one'), null);
      assert.deepEqual((await pub.list({})).items.map((i) => i.slug), ['published-one']);
      const full = await createProtocolService(target.db).getFull('p-pub');
      assert.equal(full.hasUnpublishedChanges, false, 'the imported working copy is byte-for-byte what was published (order and precision intact)');
      assert.deepEqual(full.searchTerms, []);
      // and it keeps working: a doctor-style save continues the version numbering
      const svc = createProtocolService(target.db);
      await svc.saveCanvases('p-draft', [{ id: 'p-draft-left_front', objects: full.canvases[0].objects.map((o) => ({ ...o, id: `copy-${o.id}` })) }], { id: 'doc', role: 'doctor' });
      assert.equal((await svc.getFull('p-draft')).currentVersion, 2);
    } finally { await target.cleanup(); src.cleanup(); }
  });

  it('a dry run copies and verifies everything, then rolls back: the target stays empty', async () => {
    const src = buildModernSqlite();
    const target = await openTestDatabase({ migrated: false });
    try {
      const result = await importer().importSqliteToPostgres({ sourcePath: src.file, pool: target.pool, dryRun: true, log: () => {} });
      assert.equal(result.committed, false);
      assert.equal(result.report.length, 12, 'every table was verified');
      for (const table of ['users', 'protocols', 'objects', 'protocol_versions', 'payment_orders']) {
        assert.equal((await target.row(`SELECT COUNT(*) n FROM ${table}`)).n, 0, table);
      }
      assert.equal((await target.row("SELECT enabled FROM feature_flags WHERE key = 'CAMERA'")).enabled, 0, 'seeded flags untouched');
      // and a real import afterwards still works
      assert.equal((await importer().importSqliteToPostgres({ sourcePath: src.file, pool: target.pool, log: () => {} })).committed, true);
    } finally { await target.cleanup(); src.cleanup(); }
  });
});

describe('[DETERMINISTIC] importer refusals and rollback', { skip: SKIP }, () => {
  it('refuses a target that already has data, or flags an admin has changed — and changes nothing', async () => {
    const src = buildModernSqlite();
    const target = await openTestDatabase();
    try {
      await target.run("INSERT INTO users (id,name,email,role) VALUES ('x','X','x@example.com','doctor')");
      await assert.rejects(importer().importSqliteToPostgres({ sourcePath: src.file, pool: target.pool, log: () => {} }), /users is not empty/);
      assert.equal((await target.row('SELECT COUNT(*) n FROM users')).n, 1);
      await target.run("DELETE FROM users WHERE id = 'x'");
      await target.run("UPDATE feature_flags SET updated_by = NULL, enabled = 1 WHERE key = 'CAMERA'");
      await target.run("INSERT INTO users (id,name,email,role) VALUES ('a','A','a@example.com','admin')");
      await target.run("UPDATE feature_flags SET updated_by = 'a' WHERE key = 'CAMERA'");
      await target.run("DELETE FROM users WHERE id = 'a'"); // updated_by -> NULL by FK, but the flag stays changed
      await target.run("UPDATE feature_flags SET updated_by = NULL WHERE key = 'CAMERA'");
      await target.run("INSERT INTO feature_flags (key, enabled, description) VALUES ('CUSTOM', 1, 'x')");
      await assert.rejects(importer().importSqliteToPostgres({ sourcePath: src.file, pool: target.pool, log: () => {} }), /feature_flags has been changed/);
      assert.equal((await target.row('SELECT COUNT(*) n FROM protocols')).n, 0);
    } finally { await target.cleanup(); src.cleanup(); }
  });

  it('any bad row rolls the WHOLE import back (nothing half-imported), and the error names the problem', async () => {
    const src = buildModernSqlite();
    const target = await openTestDatabase({ migrated: false });
    try {
      // SQLite's dynamic typing allowed text in a numeric column; PostgreSQL cannot store it
      const Database = require('better-sqlite3'); // eslint-disable-line global-require
      const db = new Database(src.file);
      db.prepare("UPDATE objects SET x = 'abc' WHERE id = 'p-draft-aa'").run();
      db.close();
      await assert.rejects(importer().importSqliteToPostgres({ sourcePath: src.file, pool: target.pool, log: () => {} }), /invalid input syntax for type double precision/);
      for (const table of ['users', 'categories', 'protocols', 'canvases', 'objects']) {
        assert.equal((await target.row(`SELECT COUNT(*) n FROM ${table}`)).n, 0, `${table} rolled back`);
      }
    } finally { await target.cleanup(); src.cleanup(); }
  });

  it('refuses a missing file, a source with an unknown table, broken references, or a newer SQLite schema', async () => {
    const target = await openTestDatabase({ migrated: false });
    const Database = require('better-sqlite3'); // eslint-disable-line global-require
    const made = [];
    try {
      await assert.rejects(importer().importSqliteToPostgres({ sourcePath: '/nonexistent/x.db', pool: target.pool, log: () => {} }), /not found/);

      const a = buildModernSqlite(); made.push(a);
      let db = new Database(a.file); db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)'); db.close();
      await assert.rejects(importer().importSqliteToPostgres({ sourcePath: a.file, pool: target.pool, log: () => {} }), /does not know: notes/);

      const b = buildModernSqlite(); made.push(b);
      db = new Database(b.file); db.pragma('foreign_keys = OFF'); db.prepare("UPDATE canvases SET protocol_id = 'ghost' WHERE id = 'p-draft-left_back'").run(); db.close();
      await assert.rejects(importer().importSqliteToPostgres({ sourcePath: b.file, pool: target.pool, log: () => {} }), /broken foreign-key/);

      const c = buildModernSqlite(); made.push(c);
      db = new Database(c.file); db.pragma('user_version = 99'); db.close();
      await assert.rejects(importer().importSqliteToPostgres({ sourcePath: c.file, pool: target.pool, log: () => {} }), /newer than this importer/);
      assert.equal((await target.row("SELECT to_regclass('public.users') AS t")).t === null || (await target.row('SELECT COUNT(*) n FROM users')).n === 0, true);
    } finally { await target.cleanup(); made.forEach((m) => m.cleanup()); }
  });
});
