# PostgreSQL (Neon): running, migrating, importing, testing

The backend runs on **PostgreSQL only** (Neon in production). There is no SQLite code path in the runtime and no
fallback: if `DATABASE_URL` is missing or the database is unreachable, `npm start` exits with an error instead of
starting. The old SQLite code is kept in `backend/scripts/legacy-sqlite/` solely for the one-off import below.

## 1. Configuration

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. For Neon, use the console's string (it includes `sslmode=require`, which node-postgres treats as *verify-full*). Prefer the **pooled** host (`…-pooler…`) for the web service. |
| `PGSSL` | no (default `true`) | `false` only for a local server without TLS. Ignored when the URL sets `sslmode`. |
| `PGSSL_REJECT_UNAUTHORIZED` | no (default `true`) | Certificate verification. Leave on for Neon. |
| `PGPOOL_MAX` | no (default 5, max 20) | Connections per server process. |
| `PG_CONNECT_TIMEOUT_MS` / `PG_IDLE_TIMEOUT_MS` | no | 10000 / 30000. Neon scales to zero; the first connection after idling can take a few seconds. |
| `DB_MIGRATE_ON_START` | no (default `true`) | `true`: the server applies pending migrations before listening. `false`: it refuses to start while migrations are pending (run `npm run db:migrate` as a separate step). |

Everything in the transaction/locking layer is transaction-scoped (no session state), so the Neon pooled
(PgBouncer, transaction-mode) endpoint is safe for the app, the migration runner and the importer.

## 2. Commands (`backend/`)

| Command | What it does |
|---|---|
| `npm run db:status` | Read-only: proves the connection, prints server version, schema version and pending migrations. |
| `npm run db:migrate` | Applies pending migrations (also `db:pg:migrate`). Idempotent; never drops anything. |
| `npm start` / `npm run dev` | Starts the API; applies pending migrations first (unless `DB_MIGRATE_ON_START=false`). |
| `npm run admin:create` | Creates/promotes an admin in the database named by `DATABASE_URL`. |
| `npm run flags` | Lists/changes feature flags in that database. |
| `npm run db:import-sqlite -- --dry-run` | Copies + verifies an SQLite file into PostgreSQL, then rolls back (writes nothing). |
| `npm run db:import-sqlite` | The same, committed. |

## 3. Schema

`backend/src/db/postgres-migrations/`, applied in order and recorded in `app_schema_migrations`:

1. `001_baseline.sql` — users, protocols, canvases, objects, protocol_versions.
2. `002_catalog_flags_payments.sql` — categories, conditions, condition↔protocol links, search terms, feature flags
   (seeded with the same defaults as before), payment settings (FREE/INR) and payment orders.
3. `003_protocol_publishing.js` — slugs, publishing columns, version metadata + checksums, and the database-enforced
   rules: versions are immutable and undeletable while their protocol exists, a published protocol cannot be
   deleted, the published pointer must name a *published* version of the same protocol.
4. `004_sqlite_parity.sql` — makes the schema behave like the SQLite one the app was written for: 8-byte doubles
   for coordinates (PostgreSQL `REAL` is only 4 bytes), `z_index` wide enough for the builder's `Date.now()` values,
   64-bit payment amounts, SQLite's defaults/NULL rules, UTC timestamp defaults, the missing `objects` index, and
   `objects.insert_seq` so objects with an equal z-index keep their saved order.

Each migration runs in its own transaction, under a transaction-level advisory lock (two instances starting
together cannot double-apply), and a database newer than the code is refused.

API values are unchanged from the SQLite era: timestamps are returned as `"YYYY-MM-DD HH:MM:SS"` (UTC), counts as
numbers, and text sorts use byte order (`COLLATE "C"`, = SQLite `BINARY`) regardless of the database's locale.

## 4. Moving an existing SQLite installation to Neon (one-off)

The importer (`backend/scripts/legacy-sqlite/importer.js`) never modifies the source file. It:

1. opens the SQLite file read-only and runs `PRAGMA quick_check`;
2. copies it to a temporary file and upgrades **the copy** with the original SQLite migrations, so a file from any
   older version of the app can be imported; refuses broken foreign keys and unknown tables;
3. applies the PostgreSQL migrations to the target;
4. in **one** transaction: refuses any non-empty target table (only the migration-seeded flags/payment settings may
   be present, and they are overwritten with the source's values), copies every row with its original ids and
   timestamps (objects in their saved order), restores publishing pointers (also for archived-after-publish
   protocols), then verifies **every row of every table** against the source and checks relationships. Any problem →
   ROLLBACK; nothing is left behind.

Procedure (needs `better-sqlite3`, an optional dependency installed by `npm ci` on supported platforms):

```bash
cd backend
# 1. A FRESH Neon database (or branch) as the target; never the one serving traffic.
export DATABASE_URL='postgres://…neon.tech/neondb?sslmode=require'
# 2. Stop writes to the old SQLite app (or take a copy of its .db file while it is stopped).
export SQLITE_SOURCE_FILE=/path/to/protocol_platform.db
npm run db:import-sqlite -- --dry-run     # copies + verifies everything, writes nothing
npm run db:import-sqlite                  # import + verify + commit
npm run db:status
```

PowerShell: `$env:DATABASE_URL='…'; $env:SQLITE_SOURCE_FILE='C:\path\protocol_platform.db'; npm run db:import-sqlite -- --dry-run`

Then point a staging deployment at that database and check: log in as an existing doctor/admin, open protocols in
the Studio, the public pages and PDFs of published protocols, and `/admin` flags/payments.

**Getting the production SQLite file.** The project notes say production ran SQLite on Render's *temporary* disk: the
file lives only inside the running instance and is lost on the next deploy or restart. Download it from the running
service (Render Shell, or the attached persistent disk if one exists) **before** deploying this build, and keep a copy.

**Cut-over / rollback.** Set `DATABASE_URL` on the Render service and redeploy. Keep the downloaded SQLite file and the
previous build: rolling back means redeploying the previous build with that file restored. Data written to PostgreSQL
after cut-over is not in the SQLite file.

## 5. Render

Set on the backend service: `DATABASE_URL` (Neon pooled string), `JWT_SECRET`, `CORS_ORIGIN`, and optionally
`DB_MIGRATE_ON_START`. Build command `npm ci`, start command `npm start` (unchanged). The previous `DATABASE_FILE`
variable is no longer read. Feature flags and payment settings now persist across redeploys.

## 6. Tests

```bash
# a DISPOSABLE PostgreSQL server; each test creates and drops its own ctpp_test_* database on it
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres
npm test            # project root: backend + frontend
```

Without `TEST_DATABASE_URL` the database tests **fail** (they are never reported as skipped). The helper refuses a
non-local host unless `ALLOW_REMOTE_TEST_DATABASE=1`, so a production URL cannot be used by accident. Quick local
server: `docker run --rm -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:16`.
