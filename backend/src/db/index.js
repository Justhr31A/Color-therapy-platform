'use strict';

/**
 * The application's database: PostgreSQL only (Neon in production), via node-postgres.
 *
 * There is deliberately NO SQLite code path and NO fallback. If DATABASE_URL is missing or the
 * database is unreachable, start-up fails loudly (see initDatabase and server.js). The legacy
 * SQLite code lives in scripts/legacy-sqlite/ and is used only by the one-off importer.
 *
 * API (every method is asynchronous):
 *   db.query(text, values)       -> pg result ({ rows, rowCount })
 *   db.one(text, values)         -> first row or null
 *   db.many(text, values)        -> rows
 *   db.transaction(async (tx) => ...)
 *       Runs the callback on ONE pinned client between BEGIN and COMMIT; ROLLBACK on any throw.
 *       `tx` has the same API. Calling tx.transaction(fn) JOINS the current transaction (it does not
 *       open a second one), so a service called inside a route-level transaction stays atomic with it.
 */
const { createPool, openPostgres, closePostgres, checkPostgres } = require('./openPostgres');

function assertQueryArgs(text, values) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('SQL query text is required');
  if (!Array.isArray(values)) throw new TypeError('SQL query values must be an array');
}

function bindHelpers(target) {
  target.one = async (text, values = []) => (await target.query(text, values)).rows[0] || null;
  target.many = async (text, values = []) => (await target.query(text, values)).rows;
  return target;
}

/** A transaction-scoped handle around a checked-out client. */
function createTransactionHandle(client) {
  let finished = false;
  const tx = {
    inTransaction: true,
    query(text, values = []) {
      if (finished) return Promise.reject(new Error('This transaction has already finished; the query was not run.'));
      assertQueryArgs(text, values);
      return client.query(text, values);
    },
    // Nested call: join the surrounding transaction.
    transaction(work) {
      if (typeof work !== 'function') throw new TypeError('transaction requires a callback');
      return Promise.resolve().then(() => work(tx));
    },
  };
  bindHelpers(tx);
  return { tx, finish() { finished = true; } };
}

/**
 * Wraps a pg Pool (or anything with query/connect) in the application database API.
 * `getPool` is a function so the process-wide pool can be created lazily.
 */
function createDatabase(getPool) {
  const resolvePool = typeof getPool === 'function' ? getPool : () => getPool;
  const db = {
    inTransaction: false,
    query(text, values = []) {
      assertQueryArgs(text, values);
      return resolvePool().query(text, values);
    },
    async transaction(work) {
      if (typeof work !== 'function') throw new TypeError('transaction requires a callback');
      const client = await resolvePool().connect();
      const handle = createTransactionHandle(client);
      let releaseError;
      try {
        await client.query('BEGIN');
        const result = await work(handle.tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // The connection is in an unknown state: destroy it instead of returning it to the pool.
          releaseError = rollbackError;
          error.rollbackError = rollbackError;
        }
        throw error;
      } finally {
        handle.finish();
        client.release(releaseError);
      }
    },
    check: () => checkPostgres(resolvePool()),
    close: async () => {
      const p = resolvePool();
      if (p && typeof p.end === 'function') await p.end();
    },
  };
  return bindHelpers(db);
}

/** The process-wide database (pool created from DATABASE_URL on first use). */
const db = createDatabase(openPostgres);
db.close = closePostgres;

/**
 * Called once by server.js before it accepts requests: proves the database is reachable and
 * brings the schema up to date (unless DB_MIGRATE_ON_START=false, in which case it refuses to
 * start against a schema that is behind). Throws on any problem — the caller exits.
 */
async function initDatabase({ log = console.log, migrate = process.env.DB_MIGRATE_ON_START !== 'false' } = {}) {
  // eslint-disable-next-line global-require
  const { runPostgresMigrations, getPostgresMigrationStatus } = require('./postgres-migrate');
  const pool = openPostgres();
  await checkPostgres(pool);
  if (migrate) {
    await runPostgresMigrations({ pool, log });
  } else {
    const status = await getPostgresMigrationStatus({ pool });
    if (!status.upToDate) {
      throw new Error(`Database schema is behind (pending: ${status.pending.join(', ')}). Run \`npm run db:migrate\` first.`);
    }
  }
}

module.exports = db;
module.exports.db = db;
module.exports.createDatabase = createDatabase;
module.exports.createPool = createPool;
module.exports.initDatabase = initDatabase;
