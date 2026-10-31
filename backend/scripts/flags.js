#!/usr/bin/env node
/**
 * Feature flag control (no admin UI exists yet).
 *
 *   npm run flags                 # list all flags
 *   npm run flags -- enable CAMERA
 *   npm run flags -- disable AR
 *
 * Dependency rules are enforced (AR needs CAMERA, PATIENT_ASSIGNMENT needs
 * PATIENT_ACCOUNTS). The running server reads the flag on each request, so
 * no restart is needed.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../src/db'); // PostgreSQL (DATABASE_URL)
const { createFeatureFlagService, FeatureFlagError } = require('../src/services/featureFlags');

const service = createFeatureFlagService(db);
const [command = 'list', key] = process.argv.slice(2);

async function printAll() {
  const rows = await service.listFlags();
  const width = Math.max(...rows.map((r) => r.key.length));
  rows.forEach((f) => {
    const state = f.enabled ? 'ON ' : 'OFF';
    const note = f.stored && !f.enabled ? `  (set on, but inactive: requires ${f.blockedBy.join(', ')})` : '';
    console.log(`${state}  ${f.key.padEnd(width)}  ${f.description}${note}`);
  });
}

async function main() {
  try {
    await db.initDatabase({ log: () => {} });
    if (command === 'list') {
      await printAll();
    } else if ((command === 'enable' || command === 'disable') && key) {
      await service.setFlag(key.toUpperCase(), command === 'enable');
      await printAll();
    } else {
      console.error('Usage: npm run flags [-- list | enable KEY | disable KEY]');
      process.exitCode = 1;
    }
  } catch (err) {
    process.exitCode = 1;
    if (err instanceof FeatureFlagError) console.error(`Not changed: ${err.message}`);
    else console.error(`Not changed: ${err && err.message ? err.message : err}`);
  } finally {
    await db.close().catch(() => {});
  }
}

main();
