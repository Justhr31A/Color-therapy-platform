#!/usr/bin/env node
/**
 * Applies pending PostgreSQL migrations now (the server also does this on start unless
 * DB_MIGRATE_ON_START=false). Uses DATABASE_URL. Never drops or truncates anything.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { openPostgres, closePostgres } = require('../src/db/openPostgres');
const { runPostgresMigrations } = require('../src/db/postgres-migrate');

(async () => {
  try {
    const rows = await runPostgresMigrations({ pool: openPostgres() });
    console.log(`PostgreSQL schema version: ${rows.length ? rows[rows.length - 1].version : 0} (up to date)`);
    for (const row of rows) console.log(`  ${row.version}: ${row.name}`);
  } finally {
    await closePostgres();
  }
})().catch((error) => {
  // Deliberately never prints DATABASE_URL or the pool configuration.
  console.error(`[db:migrate] ${error.message}`);
  process.exitCode = 1;
});
