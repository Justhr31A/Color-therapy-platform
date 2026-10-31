#!/usr/bin/env node
/**
 * Creates the first admin (or promotes an existing doctor account).
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-passphrase' npm run admin:create
 *   ADMIN_EMAIL=existing-doctor@example.com npm run admin:create -- --promote
 *
 * The password comes from the ADMIN_PASSWORD environment variable, on
 * purpose: a command-line argument would be saved in shell history and be
 * visible in the process list. It is never printed and never stored in
 * plain text. There is no default password anywhere in the code.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../src/db'); // PostgreSQL (DATABASE_URL)
const { createAdminAccount, AdminSeedError } = require('../src/services/adminSeed');

async function main() {
  const promoteExisting = process.argv.includes('--promote');
  try {
    await db.initDatabase({ log: () => {} }); // reachable + schema up to date before touching users
    const result = await createAdminAccount(db, {
      email: process.env.ADMIN_EMAIL,
      name: process.env.ADMIN_NAME,
      password: process.env.ADMIN_PASSWORD,
      promoteExisting,
    });
    const verb = result.action === 'promoted' ? 'promoted to admin' : 'created as admin';
    console.log(`OK: ${result.user.email} ${verb} (id ${result.user.id}).`);
    if (result.action === 'created') {
      console.log('Reminder: clear ADMIN_PASSWORD from this terminal session now (PowerShell: Remove-Item Env:ADMIN_PASSWORD).');
    }
    process.exitCode = 0;
  } catch (err) {
    process.exitCode = 1;
    if (err instanceof AdminSeedError) console.error(`Not done: ${err.message}`);
    else console.error(`Not done: ${err && err.message ? err.message : err}`);
  } finally {
    await db.close().catch(() => {});
  }
}

main();
