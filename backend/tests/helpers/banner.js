console.log('\n=== Deterministic software tests (backend, PostgreSQL) ===');
console.log('Database tests need TEST_DATABASE_URL pointing at a DISPOSABLE PostgreSQL server (each test creates and drops its');
console.log('own ctpp_test_* database). Without it those tests FAIL — they are never silently skipped.');
console.log(`TEST_DATABASE_URL: ${process.env.TEST_DATABASE_URL ? 'set' : 'NOT SET'}`);
console.log('These verify migrations, roles, feature flags, the importer and server behaviour. They do NOT replace checking');
console.log('your own database (npm run db:status) or real-device validation (docs/REAL_DEVICE_VALIDATION.md).\n');
