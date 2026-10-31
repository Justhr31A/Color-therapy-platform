#!/usr/bin/env node
/**
 * Read-only: proves the PostgreSQL connection (DATABASE_URL) and shows the schema version and any
 * pending migration. Never creates or modifies anything.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { openPostgres, closePostgres } = require('../src/db/openPostgres');
const { getPostgresMigrationStatus } = require('../src/db/postgres-migrate');

(async () => {
  const pool = openPostgres();
  try {
    const ping = await pool.query('SELECT current_database() AS database, current_schema() AS schema, version() AS version');
    console.log('PostgreSQL connection: OK');
    console.log(`Database: ${ping.rows[0].database} (schema ${ping.rows[0].schema})`);
    console.log(`Server: ${String(ping.rows[0].version).split(' on ')[0]}`);
    const s = await getPostgresMigrationStatus({ pool });
    console.log(`Schema version: ${s.current} (this application expects ${s.latest})`);
    if (s.newerThanApp) console.log('WARNING: the database is NEWER than this application. Do not run the server against it.');
    else if (s.upToDate) console.log('Up to date.');
    else console.log(`Pending migrations (run \`npm run db:migrate\`, or start the server): ${s.pending.join(', ')}`);
  } finally {
    await closePostgres();
  }
})().catch((error) => {
  console.error(`[db:status] Connection/status check failed: ${error.message}`);
  process.exitCode = 1;
});
