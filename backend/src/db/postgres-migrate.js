'use strict';

/**
 * PostgreSQL migration runner.
 *
 *  - Migrations live in ./postgres-migrations as NNN_name.sql or NNN_name.js (exporting async up(client)),
 *    numbered 1..N with no gaps.
 *  - Applied versions are recorded in app_schema_migrations.
 *  - Each migration runs in its OWN transaction together with its history row: it either fully applies or
 *    leaves the database exactly as it was.
 *  - A TRANSACTION-level advisory lock (pg_advisory_xact_lock) serialises runners, so two instances starting at the
 *    same time cannot apply the same migration twice. Transaction-scoped on purpose: it is safe through a
 *    transaction-mode pooler such as Neon's PgBouncer endpoint (a session lock could outlive its transaction there).
 *  - A database that records a version this code does not know about is refused (never downgraded).
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'postgres-migrations');
const LOCK_KEY = 728461; // arbitrary constant, unique to this application's migration runner

function listMigrationFiles(dir = MIGRATIONS_DIR) {
  const files = fs.readdirSync(dir).filter((file) => /^\d{3,}_.+\.(sql|js)$/.test(file)).sort();
  files.forEach((file, i) => {
    const expected = String(i + 1).padStart(3, '0');
    if (!file.startsWith(`${expected}_`)) throw new Error(`Migration sequence gap: expected ${expected}, found ${file}`);
  });
  return files.map((file) => ({ version: Number(file.split('_')[0]), file }));
}

const HISTORY_DDL = `
  CREATE TABLE IF NOT EXISTS app_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;

async function appliedVersions(client) {
  const exists = await client.query("SELECT to_regclass('public.app_schema_migrations') AS t");
  if (!exists.rows[0].t) return [];
  const rows = await client.query('SELECT version FROM app_schema_migrations ORDER BY version');
  return rows.rows.map((r) => Number(r.version));
}

async function applyOne(client, { version, file }, dir) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const already = await client.query('SELECT 1 FROM app_schema_migrations WHERE version = $1', [version]);
    if (already.rowCount > 0) {
      await client.query('COMMIT');
      return false;
    }
    const full = path.join(dir, file);
    if (file.endsWith('.js')) {
      delete require.cache[require.resolve(full)];
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const migration = require(full);
      if (!migration || typeof migration.up !== 'function') throw new Error(`${file} must export an async up(client) function`);
      await migration.up(client);
    } else {
      let sql = fs.readFileSync(full, 'utf8');
      sql = sql.replace(/^\s*BEGIN\s*;\s*/i, '').replace(/\s*COMMIT\s*;\s*$/i, '');
      await client.query(sql);
    }
    await client.query('INSERT INTO app_schema_migrations (version, name) VALUES ($1, $2)', [version, file]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    throw new Error(`Migration ${file} failed: ${error.message}`);
  }
}

async function runPostgresMigrations(options = {}) {
  // eslint-disable-next-line global-require
  const pool = options.pool || require('./openPostgres').openPostgres();
  const log = options.log || console.log;
  const dir = options.dir || MIGRATIONS_DIR;
  const migrations = listMigrationFiles(dir);
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;

  const client = await pool.connect();
  try {
    let applied;
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      await client.query(HISTORY_DDL);
      applied = await appliedVersions(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    const unknown = applied.filter((v) => v > latest);
    if (unknown.length) {
      throw new Error(`Database schema version ${Math.max(...unknown)} is NEWER than this application (latest ${latest}). Refusing to run.`);
    }
    for (const m of migrations) {
      if (applied.includes(m.version)) continue;
      if (await applyOne(client, m, dir)) log(`[pg-migrate] applied ${m.file}`);
    }
    const status = await client.query('SELECT version, name, applied_at FROM app_schema_migrations ORDER BY version');
    return status.rows;
  } finally {
    client.release();
  }
}

/** Read-only: never creates or changes anything. */
async function getPostgresMigrationStatus(options = {}) {
  // eslint-disable-next-line global-require
  const pool = options.pool || require('./openPostgres').openPostgres();
  const migrations = listMigrationFiles(options.dir || MIGRATIONS_DIR);
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  const applied = await appliedVersions(pool);
  const current = applied.length ? Math.max(...applied) : 0;
  const pending = migrations.filter((m) => !applied.includes(m.version)).map((m) => m.file);
  return { current, latest, applied, pending, upToDate: pending.length === 0 && current <= latest, newerThanApp: current > latest };
}

module.exports = { runPostgresMigrations, getPostgresMigrationStatus, listMigrationFiles, MIGRATIONS_DIR };
