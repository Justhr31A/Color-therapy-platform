'use strict';

/**
 * One-off SQLite -> PostgreSQL data import (legacy tooling; the application runtime never loads this).
 *
 * WHAT IT DOES
 *  1. Opens the SQLite source READ-ONLY and runs PRAGMA quick_check (a corrupt source is never imported).
 *  2. Copies it to a temporary file and brings THE COPY to the latest SQLite schema with the original SQLite
 *     migrations (so a file from any older version of the app can be imported). The source file is never modified.
 *  3. Applies the PostgreSQL migrations to the target.
 *  4. In ONE PostgreSQL transaction: refuses any non-empty target table (except the migration-seeded
 *     feature_flags/payment_settings rows, which are overwritten with the source values), copies every row with
 *     its original ids and timestamps, restores publishing pointers, then VERIFIES every table row-by-row against
 *     the source (count + full content digest). Any problem -> ROLLBACK, nothing is left behind.
 *  5. With dryRun, everything above runs and is verified, then rolled back.
 *
 * Never drops, truncates or deletes anything in the target.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TABLE_ORDER = [
  'users', 'categories', 'protocols', 'canvases', 'objects', 'protocol_versions',
  'conditions', 'condition_protocols', 'protocol_search_terms', 'feature_flags', 'payment_settings', 'payment_orders',
];
const PRIMARY_KEYS = {
  users: ['id'], categories: ['id'], protocols: ['id'], canvases: ['id'], objects: ['id'], protocol_versions: ['id'],
  conditions: ['id'], condition_protocols: ['condition_id', 'protocol_id'], protocol_search_terms: ['id'],
  feature_flags: ['key'], payment_settings: ['id'], payment_orders: ['id'],
};
const SEEDED_TABLES = new Set(['feature_flags', 'payment_settings']);
const DEFAULT_FLAG_KEYS = [
  'WEBSITE', 'PROTOCOL_BROWSER', 'ADMIN', 'PROTOCOL_STUDIO', 'DOWNLOAD',
  'AI_ASSESSMENT', 'PAYMENTS', 'CAMERA', 'AR', 'PATIENT_ACCOUNTS', 'PATIENT_ASSIGNMENT',
];
const BATCH_ROWS = 200;
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/;

/** Comparable form of one value: timestamps as "YYYY-MM-DD HH:MM:SS" (both sides), everything else as-is. */
function normalizeValue(v) {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const m = TIMESTAMP_RE.exec(v);
    if (m && v.length <= 32) return `${m[1]} ${m[2]}`;
  }
  return v === undefined ? null : v;
}

const byteCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function digestRows(rows, columns, pk) {
  const keyed = rows.map((r) => ({ key: pk.map((c) => String(r[c])).join('\u0000'), r }));
  keyed.sort((a, b) => byteCompare(a.key, b.key)); // same deterministic order applied to both sides
  const hash = crypto.createHash('sha256');
  const lines = keyed.map(({ r }) => JSON.stringify(columns.map((c) => normalizeValue(r[c]))));
  lines.forEach((l) => hash.update(l).update('\n'));
  return { digest: hash.digest('hex'), lines, keys: keyed.map((k) => k.key) };
}

async function assertTargetSafe(client, table) {
  const { n } = (await client.query(`SELECT COUNT(*)::integer AS n FROM public."${table}"`)).rows[0];
  if (n === 0) return;
  if (!SEEDED_TABLES.has(table)) throw new Error(`Target table ${table} is not empty (${n} rows). Refusing to risk duplicates; use a fresh database.`);
  if (table === 'feature_flags') {
    const keys = (await client.query('SELECT key FROM public.feature_flags')).rows.map((r) => r.key).sort();
    const expected = [...DEFAULT_FLAG_KEYS].sort();
    const updatedBy = (await client.query('SELECT COUNT(*)::integer AS n FROM public.feature_flags WHERE updated_by IS NOT NULL')).rows[0].n;
    if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i]) || updatedBy > 0) {
      throw new Error('Target feature_flags has been changed since migration; refusing import. Use a fresh database.');
    }
  } else if (table === 'payment_settings') {
    const rows = (await client.query('SELECT id, updated_by FROM public.payment_settings')).rows;
    if (rows.length !== 1 || rows[0].id !== 1 || rows[0].updated_by !== null) {
      throw new Error('Target payment_settings has been changed since migration; refusing import. Use a fresh database.');
    }
  }
}

async function insertBatch(client, table, columns, rows, conflictClause) {
  if (!rows.length) return;
  const values = [];
  const tuples = rows.map((row) => {
    const base = values.length;
    columns.forEach((c) => values.push(row[c] === undefined ? null : row[c]));
    return `(${columns.map((_, i) => `$${base + i + 1}`).join(', ')})`;
  });
  await client.query(
    `INSERT INTO public."${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES ${tuples.join(', ')}${conflictClause}`,
    values
  );
}

/**
 * @param {object} opts
 *   sourcePath  SQLite file to import (opened read-only, never modified)
 *   pool        pg Pool for the TARGET database
 *   dryRun      verify everything, then roll back
 *   log         progress logger
 * @returns {Promise<{committed:boolean, report:object[], warnings:string[], sourceSchemaVersion:number}>}
 */
async function importSqliteToPostgres({ sourcePath, pool, dryRun = false, log = console.log }) {
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  // eslint-disable-next-line global-require
  const { runMigrations, loadMigrations } = require('./migrate');
  // eslint-disable-next-line global-require
  const { runPostgresMigrations } = require('../../src/db/postgres-migrate');

  if (!sourcePath) throw new Error('A SQLite source file path is required.');
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) throw new Error(`SQLite source file not found: ${resolved}`);

  const warnings = [];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctpp-import-'));
  const copyPath = path.join(workDir, 'source-copy.db');
  let source;
  let copy;
  try {
    // 1. integrity check + consistent copy (the backup API also captures pages still in the WAL file)
    source = new Database(resolved, { readonly: true, fileMustExist: true });
    const check = source.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new Error(`SQLite source failed its integrity check: ${check}`);
    const sourceSchemaVersion = source.pragma('user_version', { simple: true });
    await source.backup(copyPath);
    source.close();
    source = null;

    // 2. bring the COPY to the latest SQLite schema
    copy = new Database(copyPath);
    copy.pragma('foreign_keys = ON');
    const latestSqlite = loadMigrations().length;
    if (sourceSchemaVersion > latestSqlite) throw new Error(`SQLite source schema version ${sourceSchemaVersion} is newer than this importer understands (${latestSqlite}).`);
    const upgraded = runMigrations(copy, { dbFile: copyPath, backupDir: path.join(workDir, 'backups'), log: () => {} });
    if (upgraded.applied.length) log(`[import] upgraded a temporary copy of the source from SQLite schema ${upgraded.from} to ${upgraded.to}.`);
    const fkProblems = copy.prepare('PRAGMA foreign_key_check').all();
    if (fkProblems.length) throw new Error(`SQLite source has ${fkProblems.length} broken foreign-key reference(s); fix them before importing.`);

    const sourceTables = new Set(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));
    const unknown = [...sourceTables].filter((t) => !TABLE_ORDER.includes(t));
    if (unknown.length) throw new Error(`SQLite source has table(s) this importer does not know: ${unknown.join(', ')}. Refusing to drop their data.`);

    // 3. target schema
    await runPostgresMigrations({ pool, log });

    // 4. copy + verify, all in one transaction
    const client = await pool.connect();
    const report = [];
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      const tableColumns = {};
      const staged = []; // protocols whose publishing state is restored after their versions exist

      for (const table of TABLE_ORDER) {
        if (!sourceTables.has(table)) continue;
        await assertTargetSafe(client, table);
        const sourceColumns = copy.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
        const targetColumns = new Set((await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table]
        )).rows.map((r) => r.column_name));
        const missing = sourceColumns.filter((c) => !targetColumns.has(c));
        if (missing.length) throw new Error(`Target ${table} has no column(s) ${missing.join(', ')}: their data would be lost. Refusing.`);
        tableColumns[table] = sourceColumns;

        const pk = PRIMARY_KEYS[table];
        const updateCols = sourceColumns.filter((c) => !pk.includes(c));
        const conflictClause = SEEDED_TABLES.has(table)
          ? ` ON CONFLICT (${pk.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET ${updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}`
          : '';

        // rowid order = the order rows were written (objects keep their saved stacking order via insert_seq)
        const iter = copy.prepare(`SELECT ${sourceColumns.map((c) => `"${c}"`).join(', ')} FROM "${table}" ORDER BY rowid`).iterate();
        let batch = [];
        let processed = 0;
        for (const raw of iter) {
          const row = { ...raw };
          if (table === 'protocols' && row.published_version_id) {
            // The published pointer must reference a version row that is imported later; stage it.
            staged.push({ id: row.id, status: row.status, published_version_id: row.published_version_id, published_at: row.published_at });
            row.status = row.status === 'published' ? 'draft' : row.status;
            row.published_version_id = null;
          }
          batch.push(row);
          processed += 1;
          if (batch.length >= BATCH_ROWS) {
            await insertBatch(client, table, sourceColumns, batch, conflictClause);
            batch = [];
          }
        }
        await insertBatch(client, table, sourceColumns, batch, conflictClause);
        const sourceCount = copy.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
        if (processed !== sourceCount) throw new Error(`Row count mismatch while reading ${table}: ${processed} of ${sourceCount}.`);
        log(`[import] ${table}: ${processed} row(s) copied`);
      }

      for (const p of staged) {
        await client.query(
          'UPDATE public.protocols SET status = $1, published_version_id = $2, published_at = $3 WHERE id = $4',
          [p.status, p.published_version_id, p.published_at, p.id]
        );
      }
      await client.query('SET CONSTRAINTS ALL IMMEDIATE'); // deferred FKs are checked now, inside the transaction

      // 5. verification: every row of every table, value by value
      for (const table of TABLE_ORDER) {
        if (!sourceTables.has(table)) continue;
        const columns = tableColumns[table];
        const pk = PRIMARY_KEYS[table];
        const src = digestRows(copy.prepare(`SELECT * FROM "${table}"`).all(), columns, pk);
        const dst = digestRows((await client.query(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM public."${table}"`)).rows, columns, pk);
        if (src.lines.length !== dst.lines.length) {
          throw new Error(`Verification failed for ${table}: source has ${src.lines.length} row(s), target ${dst.lines.length}.`);
        }
        if (src.digest !== dst.digest) {
          const i = src.lines.findIndex((l, k) => l !== dst.lines[k] || src.keys[k] !== dst.keys[k]);
          throw new Error(`Verification failed for ${table}: row ${src.keys[i]} differs (source ${src.lines[i]} / target ${dst.lines[i]}).`);
        }
        report.push({ table, rows: src.lines.length, columns: columns.length, sha256: src.digest.slice(0, 16) });
      }

      // Version history integrity (reported, not "fixed": a damaged snapshot is never rewritten).
      const versions = (await client.query('SELECT id, snapshot_json, checksum FROM protocol_versions')).rows;
      const bad = versions.filter((v) => v.checksum && crypto.createHash('sha256').update(v.snapshot_json, 'utf8').digest('hex') !== v.checksum);
      if (bad.length) warnings.push(`${bad.length} protocol version(s) have a snapshot that does not match its stored checksum (already so in the source): ${bad.map((b) => b.id).join(', ')}`);

      // Relationship checks on the target itself
      const orphanChecks = [
        ['protocols without a doctor', 'SELECT COUNT(*)::integer AS n FROM protocols p LEFT JOIN users u ON u.id = p.doctor_id WHERE u.id IS NULL'],
        ['canvases without a protocol', 'SELECT COUNT(*)::integer AS n FROM canvases c LEFT JOIN protocols p ON p.id = c.protocol_id WHERE p.id IS NULL'],
        ['objects without a canvas', 'SELECT COUNT(*)::integer AS n FROM objects o LEFT JOIN canvases c ON c.id = o.canvas_id WHERE c.id IS NULL'],
        ['versions without a protocol', 'SELECT COUNT(*)::integer AS n FROM protocol_versions v LEFT JOIN protocols p ON p.id = v.protocol_id WHERE p.id IS NULL'],
        ['published pointers to a non-published version', "SELECT COUNT(*)::integer AS n FROM protocols p JOIN protocol_versions v ON v.id = p.published_version_id WHERE v.kind <> 'published' OR v.protocol_id <> p.id"],
      ];
      for (const [label, sql] of orphanChecks) {
        const { n } = (await client.query(sql)).rows[0];
        if (n !== 0) throw new Error(`Integrity validation failed: ${label} = ${n}`);
      }

      if (dryRun) {
        await client.query('ROLLBACK');
        log('[import] DRY RUN: everything was copied and verified, then rolled back. Nothing was written.');
      } else {
        await client.query('COMMIT');
        committed = true;
        log('[import] committed.');
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return { committed, report, warnings, sourceSchemaVersion };
  } finally {
    try { if (source) source.close(); } catch (_) { /* closed */ }
    try { if (copy) copy.close(); } catch (_) { /* closed */ }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { importSqliteToPostgres, TABLE_ORDER, normalizeValue };
