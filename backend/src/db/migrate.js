/**
 * Database migration runner (SQLite, using PRAGMA user_version).
 *
 * WHY THIS EXISTS: the app used to run `CREATE TABLE IF NOT EXISTS ...` on
 * every start. That creates missing tables but can never CHANGE an existing
 * one, so any schema change (e.g. adding the `admin` role) would silently
 * not apply to a database that already exists. This runner replaces that.
 *
 * HOW IT WORKS
 *  - Migrations live in ./migrations as `NNN_name.js` files, each exporting
 *    `{ version, name, up(db) }`. Versions must be 1..N with no gaps.
 *  - The database's current version is stored in SQLite's own
 *    `PRAGMA user_version` (a header integer that is transactional).
 *  - Pending migrations run in order, EACH IN ITS OWN TRANSACTION together
 *    with the user_version bump: a migration either fully applies or leaves
 *    the database exactly as it was.
 *  - An existing pre-migration database has user_version 0 but already has
 *    tables. The baseline migration (001) is written with IF NOT EXISTS so
 *    it is a harmless no-op there and simply "adopts" the database.
 *
 * SAFETY RULES
 *  - Before applying anything to a database that already contains tables, a
 *    consistent backup is written (VACUUM INTO, which — unlike copying the
 *    .db file — also captures data still sitting in the WAL file).
 *  - A quick integrity check runs first; a corrupt database is never
 *    migrated.
 *  - A database whose version is NEWER than this code knows about is
 *    refused (never downgraded or modified).
 *  - Nothing here ever deletes data, drops the database, or removes old
 *    backups.
 *
 * DIALECT NOTE: migrations receive the raw better-sqlite3 handle and contain
 * SQLite SQL. A future PostgreSQL deployment gets its own migrations folder
 * and runner; application code that goes through ../repositories does not
 * need to change (see docs/FOUNDATION.md).
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const pad = (n) => String(n).padStart(3, '0');

/**
 * Loads and validates migration modules from `dir`. Throws on gaps,
 * duplicates, or a filename/version mismatch, so a bad migration set fails
 * loudly at startup instead of half-applying.
 */
function loadMigrations(dir = MIGRATIONS_DIR) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{3,}_.+\.js$/.test(f))
    .sort();

  const migrations = files.map((file) => {
    const fileVersion = parseInt(file.match(/^(\d+)_/)[1], 10);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(path.join(dir, file));
    if (mod.version !== fileVersion) {
      throw new Error(`Migration ${file}: exported version (${mod.version}) does not match the filename number (${fileVersion}).`);
    }
    if (typeof mod.up !== 'function') {
      throw new Error(`Migration ${file}: must export an up(db) function.`);
    }
    return {
      version: mod.version,
      name: mod.name || file.replace(/^\d+_|\.js$/g, ''),
      up: mod.up,
      // Table rebuilds (e.g. widening a CHECK constraint) must run with
      // foreign keys switched off, per SQLite's documented procedure.
      requiresForeignKeysOff: mod.requiresForeignKeysOff === true,
      // A migration that only touches data may opt out of the backup.
      modifiesSchema: mod.modifiesSchema !== false,
      file,
    };
  });

  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `Migrations must be numbered 1..N with no gaps or duplicates; expected ${pad(i + 1)} but found ${m.file}.`
      );
    }
  });
  return migrations;
}

function hasUserTables(db) {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get();
  return row.c > 0;
}

function timestampForFilename(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

/**
 * Writes a consistent copy of the live database and returns its path.
 * VACUUM INTO produces a fully consistent snapshot including WAL contents.
 */
function createBackup(db, { dbFile, backupDir, from, to, now }) {
  const dir = backupDir || path.join(path.dirname(dbFile), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(dbFile, path.extname(dbFile));
  const stamp = timestampForFilename(now());

  let candidate;
  let counter = 0;
  do {
    const suffix = counter === 0 ? '' : `-${counter}`;
    candidate = path.join(dir, `${base}.pre-migration-v${from}-to-v${to}.${stamp}${suffix}.db`);
    counter += 1;
  } while (fs.existsSync(candidate)); // VACUUM INTO refuses to overwrite; never overwrite a backup either

  db.exec(`VACUUM INTO '${candidate.replace(/'/g, "''")}'`);

  if (!fs.existsSync(candidate) || fs.statSync(candidate).size === 0) {
    throw new Error(`Backup was requested but ${candidate} was not created correctly. Aborting before any migration runs.`);
  }
  return candidate;
}

function applyOne(db, migration, log) {
  log(`[migrate] applying ${pad(migration.version)}_${migration.name} ...`);

  const body = () => {
    migration.up(db);
    // user_version is transactional: it is rolled back together with the
    // schema changes if anything in this migration throws.
    db.pragma(`user_version = ${migration.version}`);
  };

  if (migration.requiresForeignKeysOff) {
    // PRAGMA foreign_keys is a no-op inside a transaction, so it must be
    // toggled outside of it.
    const wasOn = db.pragma('foreign_keys', { simple: true }) === 1;
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        body();
        const violations = db.pragma('foreign_key_check');
        if (violations.length > 0) {
          const sample = JSON.stringify(violations.slice(0, 3));
          throw new Error(
            `Migration ${pad(migration.version)}_${migration.name} would leave ${violations.length} foreign-key violation(s) ` +
              `(first: ${sample}). Rolled back; the database is unchanged.`
          );
        }
      })();
    } finally {
      if (wasOn) db.pragma('foreign_keys = ON');
    }
  } else {
    db.transaction(body)();
  }
}

/**
 * Applies all pending migrations. Safe to call on every start: when nothing
 * is pending it does nothing at all.
 *
 * @returns {{from:number,to:number,applied:string[],backupPath:string|null}}
 */
function runMigrations(db, options = {}) {
  const {
    dbFile = null,
    backupDir = null,
    migrations = loadMigrations(),
    log = (msg) => console.log(msg), // eslint-disable-line no-console
    now = () => new Date(),
  } = options;

  const current = db.pragma('user_version', { simple: true });
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;

  if (current > latest) {
    throw new Error(
      `This database is at schema version ${current}, but this version of the application only knows up to ${latest}. ` +
        'Refusing to touch it. Update the application code instead of running it against a newer database.'
    );
  }

  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) {
    return { from: current, to: current, applied: [], backupPath: null };
  }

  let backupPath = null;
  const existingData = hasUserTables(db);
  if (existingData) {
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') {
      throw new Error(`Database integrity check failed ("${check}"). Refusing to migrate a damaged database.`);
    }
    if (pending.some((m) => m.modifiesSchema)) {
      if (!dbFile || dbFile === ':memory:') {
        log('[migrate] in-memory database: skipping backup.');
      } else {
        backupPath = createBackup(db, { dbFile, backupDir, from: current, to: latest, now });
        log(`[migrate] backup written: ${backupPath}`);
      }
    }
  } else {
    log('[migrate] new empty database: nothing to back up.');
  }

  const applied = [];
  for (const m of pending) {
    applyOne(db, m, log);
    applied.push(`${pad(m.version)}_${m.name}`);
  }
  log(`[migrate] database is now at schema version ${latest} (was ${current}).`);
  return { from: current, to: latest, applied, backupPath };
}

/** Read-only status, used by the `db:status` script. Never modifies anything. */
function getMigrationStatus(db, migrations = loadMigrations()) {
  const current = db.pragma('user_version', { simple: true });
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  return {
    current,
    latest,
    upToDate: current === latest,
    newerThanApp: current > latest,
    hasExistingTables: hasUserTables(db),
    pending: migrations.filter((m) => m.version > current).map((m) => `${pad(m.version)}_${m.name}`),
  };
}

module.exports = { runMigrations, getMigrationStatus, loadMigrations, MIGRATIONS_DIR };
