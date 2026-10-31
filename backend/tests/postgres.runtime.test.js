/**
 * [DETERMINISTIC SOFTWARE TESTS — real PostgreSQL] the database layer the whole runtime uses (src/db):
 * transactions (commit, rollback, nesting, client release), value parsing that keeps the API's JSON unchanged,
 * precision, and service-level atomicity/concurrency against a real server.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { missingReason } = require('./helpers/testDb');
const { openTestDatabase } = require('./helpers/pg');

const SKIP = missingReason('pg', 'uuid');

describe('[DETERMINISTIC] db.transaction', { skip: SKIP }, () => {
  it('commits on success, rolls back everything on a throw, and joins (does not nest) an inner transaction', async () => {
    const t = await openTestDatabase();
    try {
      const { db } = t;
      await db.transaction(async (tx) => {
        await tx.query("INSERT INTO categories (id,name,slug) VALUES ('c1','One','one')");
        await tx.transaction(async (inner) => {
          assert.equal(inner, tx, 'the inner call joins the same transaction');
          await inner.query("INSERT INTO categories (id,name,slug) VALUES ('c2','Two','two')");
        });
      });
      assert.equal((await t.row('SELECT COUNT(*) n FROM categories')).n, 2);

      await assert.rejects(db.transaction(async (tx) => {
        await tx.query("INSERT INTO categories (id,name,slug) VALUES ('c3','Three','three')");
        await tx.transaction(async (inner) => { await inner.query("INSERT INTO categories (id,name,slug) VALUES ('c4','Four','four')"); });
        throw new Error('boom');
      }), /boom/);
      assert.equal((await t.row('SELECT COUNT(*) n FROM categories')).n, 2, 'both the outer and the joined inner writes were rolled back');

      // a statement error inside the transaction also rolls back the earlier writes
      await assert.rejects(db.transaction(async (tx) => {
        await tx.query("INSERT INTO categories (id,name,slug) VALUES ('c5','Five','five')");
        await tx.query("INSERT INTO categories (id,name,slug) VALUES ('c6','Dup','one')");
      }), (e) => e.code === '23505');
      assert.equal((await t.row("SELECT COUNT(*) n FROM categories WHERE id = 'c5'")).n, 0);
    } finally { await t.cleanup(); }
  });

  it('always releases its connection: many failing transactions never exhaust the pool', async () => {
    const t = await openTestDatabase(); // pool max = 4
    try {
      for (let i = 0; i < 25; i += 1) {
        await assert.rejects(t.db.transaction(async (tx) => { await tx.query('SELECT 1/0'); }), /division by zero/);
      }
      assert.equal(t.pool.totalCount <= 4, true);
      assert.equal((await t.row('SELECT 1 AS ok')).ok, 1, 'the pool still serves queries');
    } finally { await t.cleanup(); }
  });

  it('a transaction handle cannot be used after the transaction finished (no stray writes outside it)', async () => {
    const t = await openTestDatabase();
    try {
      let leaked;
      await t.db.transaction(async (tx) => { leaked = tx; });
      await assert.rejects(leaked.query('SELECT 1'), /already finished/);
    } finally { await t.cleanup(); }
  });

  it('reads inside a transaction see its own uncommitted writes; other connections do not', async () => {
    const t = await openTestDatabase();
    try {
      await t.db.transaction(async (tx) => {
        await tx.query("INSERT INTO categories (id,name,slug) VALUES ('c1','One','one')");
        assert.equal((await tx.one('SELECT COUNT(*) n FROM categories')).n, 1);
        assert.equal((await t.row('SELECT COUNT(*) n FROM categories')).n, 0, 'not visible outside until COMMIT');
      });
      assert.equal((await t.row('SELECT COUNT(*) n FROM categories')).n, 1);
    } finally { await t.cleanup(); }
  });
});

describe('[DETERMINISTIC] values come back exactly as the SQLite-era API returned them', { skip: SKIP }, () => {
  it('timestamps as "YYYY-MM-DD HH:MM:SS" text, counts as numbers, doubles at full precision', async () => {
    const t = await openTestDatabase();
    try {
      await t.run("INSERT INTO users (id,name,email,role,created_at) VALUES ('u','U','u@x.com','doctor','2024-01-05 10:00:00')");
      const u = await t.row('SELECT created_at, (SELECT COUNT(*) FROM users) AS n FROM users');
      assert.equal(u.created_at, '2024-01-05 10:00:00');
      assert.equal(typeof u.n, 'number');
      await t.run("INSERT INTO protocols (id,name,slug,doctor_id,protocol_type) VALUES ('p','P','p','u','hand')");
      await t.run("INSERT INTO canvases (id,protocol_id,canvas_type,view_key,background_asset_key,width,height) VALUES ('c','p','hand','left_front','left_front',1586,1982)");
      const x = 0.4578123456789012;
      const z = 1761234567890;
      await t.run("INSERT INTO objects (id,canvas_id,object_type,x,z_index) VALUES ('o','c','dot',$1,$2)", x, z);
      const o = await t.row('SELECT x, z_index FROM objects');
      assert.equal(o.x, x, 'no 4-byte float rounding');
      assert.equal(o.z_index, z, 'a Date.now() z-index fits');
      const c = await t.row('SELECT width, height FROM canvases');
      assert.deepEqual(c, { width: 1586, height: 1982 });
    } finally { await t.cleanup(); }
  });
});

describe('[DETERMINISTIC] services on PostgreSQL: atomicity and concurrency', { skip: SKIP }, () => {
  it('the builder save keeps saved stacking order for equal zIndex values and real Date.now() zIndex values', async () => {
    const e = await require('./helpers/publishingEnv').makeEnv(); // eslint-disable-line global-require
    try {
      const id = await e.protocols.create({ name: 'Order' }, e.actor);
      const full = await e.protocols.getFull(id);
      const now = Date.now();
      const objects = ['zz', 'aa', 'mm'].map((oid) => e.dot({ id: oid, zIndex: now }));
      await e.protocols.saveCanvases(id, [{ id: full.canvases[0].id, objects }], e.actor);
      const { createProtocolRepository } = require('../src/repositories/protocols.repo'); // eslint-disable-line global-require
      const rows = await createProtocolRepository(e.db).getObjectsInSavedOrder(full.canvases[0].id);
      assert.deepEqual(rows.map((r) => r.id), ['zz', 'aa', 'mm'], 'ties keep the order they were saved in');
      assert.ok(rows.every((r) => r.z_index === now));
    } finally { await e.cleanup(); }
  });

  it('concurrent creates of the same name ALL succeed with distinct slugs (same-name, -2, -3 ...), as under SQLite', async () => {
    const e = await require('./helpers/publishingEnv').makeEnv(); // eslint-disable-line global-require
    try {
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => e.protocols.create({ name: 'Same Name' }, e.actor)));
      assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => String(r.reason)), []);
      const slugs = (await e.rows("SELECT slug FROM protocols WHERE name = 'Same Name'")).map((r) => r.slug).sort();
      assert.deepEqual(slugs, ['same-name', 'same-name-2', 'same-name-3', 'same-name-4', 'same-name-5', 'same-name-6']);
      const cats = await Promise.all(Array.from({ length: 4 }, () => e.catalog.createCategory({ name: 'Twin' })));
      assert.deepEqual(cats.map((c) => c.slug).sort(), ['twin', 'twin-2', 'twin-3', 'twin-4']);
      // every created protocol is complete: 4 canvases and a v1 checkpoint (nothing half-created)
      for (const { id } of await e.rows("SELECT id FROM protocols WHERE name = 'Same Name'")) {
        assert.equal((await e.row('SELECT COUNT(*) n FROM canvases WHERE protocol_id = $1', id)).n, 4);
        assert.equal((await e.row('SELECT COUNT(*) n FROM protocol_versions WHERE protocol_id = $1', id)).n, 1);
      }
    } finally { await e.cleanup(); }
  });

  it('concurrent saves of one protocol ALL succeed, one after another: consecutive versions, no duplicates, no mixing', async () => {
    const e = await require('./helpers/publishingEnv').makeEnv(); // eslint-disable-line global-require
    try {
      const id = await e.protocols.create({ name: 'Busy' }, e.actor);
      const canvasId = (await e.protocols.getFull(id)).canvases[0].id;
      const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => e.protocols.saveCanvases(id, [{ id: canvasId, objects: [e.dot({ id: `o${i}` })] }], e.actor)));
      assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => String(r.reason)), []);
      const versions = (await e.rows('SELECT version FROM protocol_versions WHERE protocol_id = $1 ORDER BY version', id)).map((r) => r.version);
      assert.deepEqual(versions, [1, 2, 3, 4, 5, 6], 'consecutive, no duplicates');
      assert.equal((await e.row('SELECT current_version FROM protocols WHERE id = $1', id)).current_version, 6);
      const objects = await e.rows('SELECT o.id FROM objects o JOIN canvases c ON c.id = o.canvas_id WHERE c.protocol_id = $1', id);
      assert.equal(objects.length, 1, 'the canvas holds exactly one save\'s objects, never a mix');
    } finally { await e.cleanup(); }
  });
});
