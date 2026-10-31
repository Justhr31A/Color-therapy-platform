'use strict';

/**
 * Disposable PostgreSQL databases for the backend tests.
 *
 * TEST_DATABASE_URL must point at a PostgreSQL SERVER the tests may create databases on, e.g.
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres
 * The database named in the URL is only used to issue CREATE/DROP DATABASE; every test gets its OWN fresh
 * database named ctpp_test_<random>, cloned from a migrated template, and dropped afterwards. Nothing else on
 * the server is touched. A non-local host is refused unless ALLOW_REMOTE_TEST_DATABASE=1 (so a production
 * DATABASE_URL can never be used by accident).
 *
 * If TEST_DATABASE_URL is missing, every database test FAILS with that explanation. It is never reported as a
 * skip, so a run without a database can not be mistaken for a passing one.
 */
const crypto = require('crypto');

const PREFIX = 'ctpp_test_';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

function adminUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. Database tests need a disposable PostgreSQL server, e.g. '
      + 'TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres (see backend/README section "Tests").');
  }
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && process.env.ALLOW_REMOTE_TEST_DATABASE !== '1') {
    throw new Error(`TEST_DATABASE_URL points at a non-local host (${host}). Refusing; set ALLOW_REMOTE_TEST_DATABASE=1 only for a disposable server.`);
  }
  return url;
}

function urlFor(dbName) {
  const u = new URL(adminUrl());
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** Environment for a child server process / pool talking to a test database. */
function pgEnv(url) {
  return { DATABASE_URL: url, PGSSL: process.env.TEST_PGSSL || 'false', PGPOOL_MAX: '4', DB_MIGRATE_ON_START: 'true' };
}

let adminPool = null;
function admin() {
  if (!adminPool) {
    // eslint-disable-next-line global-require
    const { Pool } = require('pg');
    // allowExitOnIdle: an idle admin connection must not keep the test process alive (cleanup runs on beforeExit).
    adminPool = new Pool({ connectionString: adminUrl(), ssl: process.env.TEST_PGSSL === 'true' ? { rejectUnauthorized: false } : false, max: 2, allowExitOnIdle: true });
    adminPool.on('error', () => {});
  }
  return adminPool;
}

const created = new Set();
let templateName = null;
let templatePromise = null;

async function createEmptyDatabase(template = null) {
  const name = `${PREFIX}${crypto.randomBytes(6).toString('hex')}`;
  await admin().query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ''}`);
  created.add(name);
  return name;
}

async function dropDatabase(name) {
  if (!name || !name.startsWith(PREFIX)) throw new Error(`refusing to drop ${name}`);
  await admin().query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  created.delete(name);
}

/** A migrated database to clone from (built once per test process). */
function migratedTemplate() {
  if (!templatePromise) {
    templatePromise = (async () => {
      // eslint-disable-next-line global-require
      const { createPool } = require('../../src/db/openPostgres');
      // eslint-disable-next-line global-require
      const { runPostgresMigrations } = require('../../src/db/postgres-migrate');
      templateName = await createEmptyDatabase();
      const pool = createPool(urlFor(templateName), { PGSSL: process.env.TEST_PGSSL || 'false' });
      try {
        await runPostgresMigrations({ pool, log: () => {} });
      } finally {
        await pool.end();
      }
      return templateName;
    })();
  }
  return templatePromise;
}

/**
 * A fresh database for one test.
 *   { name, url, env, db (app database API: query/one/many/transaction), pool, row(), rows(), run(), cleanup() }
 * migrated: true (default) -> at the latest schema; false -> completely empty (no tables).
 */
async function openTestDatabase({ migrated = true } = {}) {
  // eslint-disable-next-line global-require
  const { createPool } = require('../../src/db/openPostgres');
  // eslint-disable-next-line global-require
  const { createDatabase } = require('../../src/db');
  const name = migrated ? await createEmptyDatabase(await migratedTemplate()) : await createEmptyDatabase();
  const url = urlFor(name);
  const pool = createPool(url, { PGSSL: process.env.TEST_PGSSL || 'false', PGPOOL_MAX: '4' });
  const db = createDatabase(pool);
  let closed = false;
  return {
    name,
    url,
    env: pgEnv(url),
    pool,
    db,
    row: (sql, ...params) => db.one(sql, params),
    rows: (sql, ...params) => db.many(sql, params),
    run: (sql, ...params) => db.query(sql, params),
    async cleanup() {
      if (closed) return;
      closed = true;
      // pg-pool's end() resolves before its sockets have finished closing; the forced DROP below may then terminate
      // them, which is expected here and must not be reported as an application error.
      pool.removeAllListeners('error');
      pool.on('error', () => {});
      await pool.end().catch(() => {});
      await dropDatabase(name);
    },
  };
}

// Drop everything this process created once the test file has finished (node --test runs each file in its own
// process). `beforeExit` (not node:test's after()) so it is process-wide however lazily this helper was loaded.
let cleaning = false;
process.on('beforeExit', async () => {
  if (cleaning || !adminPool) return;
  cleaning = true;
  for (const name of [...created]) {
    if (name !== templateName) await dropDatabase(name).catch(() => {});
  }
  if (templateName) await dropDatabase(templateName).catch(() => {});
  templateName = null;
  templatePromise = null;
  await adminPool.end().catch(() => {});
  adminPool = null;
});

module.exports = { openTestDatabase, adminUrl, urlFor, pgEnv, PREFIX };
