#!/usr/bin/env node
/**
 * One-time, explicit SQLite -> PostgreSQL data import. See scripts/legacy-sqlite/importer.js for exactly
 * what is checked. Target = DATABASE_URL (use a FRESH database, e.g. a new Neon branch).
 *
 *   SQLITE_SOURCE_FILE=/path/to/protocol_platform.db npm run db:import-sqlite -- --dry-run   # verify only, writes nothing
 *   SQLITE_SOURCE_FILE=/path/to/protocol_platform.db npm run db:import-sqlite                # import + verify + commit
 *
 * PowerShell: $env:SQLITE_SOURCE_FILE="C:\path\to\protocol_platform.db"; npm run db:import-sqlite -- --dry-run
 *
 * Requires the optional dependency better-sqlite3 (installed by `npm ci` on supported platforms).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { openPostgres, closePostgres } = require('../src/db/openPostgres');

(async () => {
  let importer;
  try {
    // eslint-disable-next-line global-require
    importer = require('./legacy-sqlite/importer');
    require.resolve('better-sqlite3');
  } catch (e) {
    throw new Error('better-sqlite3 is not installed; it is only needed for this import. Run `npm install better-sqlite3` in backend/.');
  }
  const dryRun = process.argv.includes('--dry-run');
  try {
    const result = await importer.importSqliteToPostgres({ sourcePath: process.env.SQLITE_SOURCE_FILE, pool: openPostgres(), dryRun });
    console.table(result.report);
    result.warnings.forEach((w) => console.warn(`WARNING: ${w}`));
    console.log(result.committed
      ? 'Import committed and verified. Check the application against this database before switching production traffic.'
      : 'Dry run complete: all rows copied and verified, then rolled back. Re-run without --dry-run to import.');
  } finally {
    await closePostgres();
  }
})().catch((error) => {
  console.error(`[sqlite->pg] IMPORT FAILED (nothing was committed): ${error.message}`);
  process.exitCode = 1;
});
