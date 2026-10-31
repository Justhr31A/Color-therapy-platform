'use strict';

const { Pool, types } = require('pg');

/*
 * Value parsing — keeps the API's JSON exactly as it was under SQLite.
 *
 *  - TIMESTAMP (without time zone, OID 1114): SQLite stored `datetime('now')` text such as
 *    "2026-10-22 13:40:05" and every API response returned that string. node-postgres would
 *    otherwise return a JS Date (serialised as "2026-10-22T13:40:05.123Z"), silently changing
 *    every createdAt/updatedAt/publishedAt in the API. Values are stored in UTC (see migration 004
 *    and NOW_UTC below) and returned as "YYYY-MM-DD HH:MM:SS".
 *  - BIGINT (OID 20): COUNT(*) returns bigint, which node-postgres returns as a STRING. SQLite
 *    returned a number. Counts in this app are far below 2^53, so they are parsed as numbers.
 *  TIMESTAMPTZ (only app_schema_migrations.applied_at) keeps node-postgres' Date parsing.
 */
const TIMESTAMP_OID = 1114;
const INT8_OID = 20;
types.setTypeParser(TIMESTAMP_OID, (value) => (value === null ? null : String(value).slice(0, 19)));
types.setTypeParser(INT8_OID, (value) => {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`bigint value ${value} exceeds the safe integer range`);
  return n;
});

/** SQL expression for "now" in UTC, for TIMESTAMP (without time zone) columns. Independent of the session TimeZone. */
const NOW_UTC = "(now() AT TIME ZONE 'UTC')";

function parseBoolean(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePositiveInt(value, fallback, max = Infinity) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

/**
 * Builds a pg Pool for a connection string. DATABASE_URL is mandatory for the app; there is
 * NO SQLite (or any other) fallback anywhere in the runtime.
 *
 * TLS: on by default (Neon requires it) and the server certificate is VERIFIED by default.
 * If the URL itself carries `sslmode=...` (Neon's URLs do), node-postgres applies that and it
 * takes precedence over these options. PGSSL=false disables TLS (local/disposable databases only).
 */
function createPool(connectionString, env = process.env) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for PostgreSQL. Set it in the service environment; no database fallback is available.');
  }
  const sslEnabled = parseBoolean(env.PGSSL, true);
  const rejectUnauthorized = parseBoolean(env.PGSSL_REJECT_UNAUTHORIZED, true);
  const pool = new Pool({
    connectionString,
    ssl: sslEnabled ? { rejectUnauthorized } : false,
    max: parsePositiveInt(env.PGPOOL_MAX, 5, 20),
    connectionTimeoutMillis: parsePositiveInt(env.PG_CONNECT_TIMEOUT_MS, 10000),
    idleTimeoutMillis: parsePositiveInt(env.PG_IDLE_TIMEOUT_MS, 30000),
    application_name: env.PGAPPNAME || 'colour-therapy-platform',
  });
  // An idle client can emit an error asynchronously (e.g. Neon scaling to zero). Surface it without
  // ever logging the connection string or credentials; the pool replaces the client on next use.
  pool.on('error', (error) => {
    console.error('[postgres] idle pool client error:', error && error.message ? error.message : 'unknown error');
  });
  return pool;
}

let pool;

/** The process-wide pool, created on first use from DATABASE_URL. */
function openPostgres() {
  if (!pool) pool = createPool(process.env.DATABASE_URL);
  return pool;
}

async function closePostgres() {
  if (!pool) return;
  const currentPool = pool;
  pool = null;
  await currentPool.end();
}

async function checkPostgres(poolOverride) {
  const client = poolOverride || openPostgres();
  const result = await client.query('SELECT 1 AS ok');
  return Boolean(result.rows[0]) && Number(result.rows[0].ok) === 1;
}

module.exports = { createPool, openPostgres, closePostgres, checkPostgres, NOW_UTC };
