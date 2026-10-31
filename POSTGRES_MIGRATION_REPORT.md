# SQLite → PostgreSQL (Neon) runtime conversion — report (2026-10-22)

**Status: the conversion is complete in code. The runtime has been verified against a real PostgreSQL 16.15
server, including every backend and frontend test. It has NOT yet been run against Neon, and no production data has been
imported.** It is ready for a staging deployment on a Neon branch. Production cut-over still needs the external steps
in "Remaining external blockers". The live Render service and production data were not touched.

Operator guide: [`docs/POSTGRESQL.md`](docs/POSTGRESQL.md).

## 1. Starting point (verified before any change)

- The archive contained no `.git` directory, so there was no commit history to inspect. A new repository was created
  and the untouched archive was committed as the recoverable checkpoint **`08375fa`**. The conversion is commit `5b10c6c`
  and later commits.
- `backend/src/db/index.js` opened SQLite with `better-sqlite3` and ran the SQLite migrations. `backend/src/server.js`
  required it at start-up.
- The runtime was split between two databases:
  - **PostgreSQL:** auth routes, auth middleware, patient routes, payments, catalog reads and the feature-flag middleware.
  - **SQLite (synchronous `prepare/get/all/run`):** the builder routes (`protocols.routes.js`), public and AI routes,
    camera routes, admin AI/camera/conditions/protocols routes, `protocolService`, `publicProtocols`, the AI
    assistant's catalog lookups, and every CLI script.
- The baseline backend test run, with the real dependencies installed from the lockfile, was **375 passed, 46 failed,
  162 cancelled**. A request that touched both halves could not work.

## 2. Defects found in the existing PostgreSQL code (fixed)

| Defect | Effect | Fix |
|---|---|---|
| `objects.z_index INTEGER`, but the builder sends `zIndex: Date.now()` (≈1.7e12) | **Every real Studio save would fail** on PostgreSQL | migration 004: `DOUBLE PRECISION` (exact up to 2^53, same JSON numbers) |
| Coordinates and sizes stored as `REAL` (4-byte float in PostgreSQL, 8-byte in SQLite) | Silent rounding (0.4578123456789 → 0.45781234). Published snapshots would no longer match the working copy. | 004: `DOUBLE PRECISION` |
| `amount_minor INTEGER`, but values up to 1e10 are accepted | Overflow (500) for large future prices | 004: `BIGINT` |
| `protocols.description NOT NULL` (nullable in SQLite); missing defaults on `objects` | A faithful import of legacy rows would fail | 004: same rules as SQLite |
| `CURRENT_TIMESTAMP` into `TIMESTAMP` columns, and `pg` returning `Date` objects | Timestamps followed the session time zone; every `createdAt`/`updatedAt` in the API would change format | UTC defaults (`now() AT TIME ZONE 'UTC'`); values returned as `"YYYY-MM-DD HH:MM:SS"`, as before |
| `COUNT(*)` returned as a string | `protocolCount` etc. would become strings | bigint parsed to number |
| `protocols.pg.repo` skipped `canonicalFinger` | The legacy `pinky` would not be rewritten as `little` | Merged into one repository that keeps it |
| Ordering depended on the database locale, and ties had no stable order | Lists and snapshot order could differ from SQLite, falsely flagging "unpublished changes" | `COLLATE "C"` (SQLite `BINARY`); `objects.insert_seq` keeps the saved order for equal z-index |
| Concurrent writes: SQLite serialised them, PostgreSQL (READ COMMITTED) does not | Simultaneous saves could collide on version numbers (500); simultaneous same-name creates could collide on slug | Protocol row lock (`FOR UPDATE`) in write transactions; transaction-scoped advisory lock for slug allocation |
| Async auth handlers had no error forwarding | A database error during login or registration was an unhandled rejection, which crashes the process on Node 22 | Every route wrapped with `asyncRoute` |
| Importer: only `status = 'published'` protocols kept their published pointer | Archived-after-publish protocols lost their history link and became deletable | Every pointer is staged and restored |
| Importer: silently dropped source columns missing from the target; could not import older-schema files; checked counts only | Data loss risk; old installations could not be imported | Rebuilt (see §4) |
| Migration runner: no concurrency guard, no newer-schema refusal | Two instances starting together could double-apply | Transaction-level advisory lock (safe behind Neon's PgBouncer); refuses a newer schema |

## 3. What the runtime is now

- **`src/db/index.js`**: PostgreSQL only. It provides `query`/`one`/`many`, and `transaction(fn)` on one pinned client
  with ROLLBACK on any throw; the client is always released. A nested `transaction()` joins the outer one.
  `initDatabase()` proves the connection and applies migrations. **There is no SQLite import and no fallback.**
- **`src/server.js`**: awaits `initDatabase()` before listening and exits with code 1 if the database is missing or
  unreachable. Verified: an unset `DATABASE_URL` and an unreachable host both exit 1. It closes the pool on
  SIGTERM/SIGINT. A PostgreSQL data exception (class 22) becomes a 400 rather than a 500.
- **Repositories** (one per domain, all async, parameterised `$n` SQL): `users`, `protocols`, `catalog`,
  `featureFlags`, `payments`. The duplicate `*.pg.repo.js` / `*.pg.js` files were merged into these and removed.
- **Services** (async): `protocolService` handles create, metadata, status, publish, builder save, duplicate,
  versions, restore, search terms, condition links and delete. Every multi-step write runs in one transaction, and
  every read inside it uses the same client. `publicProtocols`, `catalogService`, `featureFlags` (original error
  messages restored), `adminSeed`, `paymentService` and the AI `assistantService` are all async.
- **Routes**: all 14 database-backed routers are async, with errors forwarded. The builder `PUT /:id` (metadata plus status) and the
  patient assignment each run in one transaction. The camera switch changes CAMERA and AR atomically.
- **CLI**: `db:status`, `db:migrate` (`db:pg:*` are aliases), `admin:create` and `flags` all run on `DATABASE_URL`.
- **Migrations**: `src/db/postgres-migrations/001–004`. 004 is new and brings both fresh and already-migrated
  databases to the same final schema.

## 4. SQLite importer (`npm run db:import-sqlite [-- --dry-run]`)

`scripts/legacy-sqlite/importer.js` (CLI: `scripts/import-sqlite-to-postgres.js`):

1. Opens the source read-only, runs `quick_check`, and copies it with SQLite's backup API, which includes WAL pages.
2. Upgrades **the copy** with the original SQLite migrations, so a file from any older version of the app can be
   imported. It refuses broken foreign keys and unknown tables.
3. Applies the PostgreSQL migrations to the target.
4. Runs one transaction:
   - refuses a non-empty target;
   - copies all rows in saved order;
   - restores every publishing pointer;
   - checks every row of every table value by value against the source;
   - checks relationships;
   - reports any snapshot whose checksum does not match.

   Any problem rolls the whole import back. `--dry-run` does all of this, then rolls back.

The source file is never modified, which is verified by hashing it before and after. The SQLite runner and
migrations now live in `scripts/legacy-sqlite/` and are used only by this tool. `better-sqlite3` moved to
`optionalDependencies`, so the runtime does not need it.

## 5. API behaviour changes (intentional, all small)

1. A **non-numeric** value in a numeric object field (e.g. `thickness: "thick"`) is now refused when the draft is
   **saved** (400 `INVALID_INPUT`). SQLite stored it as text and refused it only at publish. Numeric strings (`"7"`) are
   still accepted and stored as numbers, as before. The one test that encoded the old timing was updated, and it states
   why.
2. Values a request cannot fit in a column give a 400 rather than being stored loosely.
3. Errors in async handlers reach the JSON error handler instead of crashing the process. Non-string `patientName` and
   `password` inputs get a clean response (fallback name or 400) rather than a 500.
4. Feature flags and payment settings now **persist across Render redeploys**. On SQLite's temporary disk they reset.
5. Database TLS verifies the server certificate by default (`PGSSL_REJECT_UNAUTHORIZED=true`). Neon URLs with
   `sslmode=require` already do this.

Unchanged: every route, status code and JSON shape; authentication and authorisation; timestamp format; the version
numbering (create = v1, first save = v2, …); slugs; publish rules; and immutable history, which is still enforced by
database triggers.

## 6. Tests — commands and actual results

Environment: Node 22.22.0, npm 10.9.4, **PostgreSQL 16.15** (local, disposable; each test uses its own `ctpp_test_*`
database cloned from a migrated template, dropped afterwards; verified 0 left over).

| Command | Result |
|---|---|
| `cd backend && npm ci` / `cd frontend && npm ci` (existing lockfiles) | installed (backend lockfile changed only to mark `better-sqlite3` optional) |
| **Before:** `cd backend && npm test` (checkpoint, deps installed) | 583 tests: **375 pass, 46 fail, 162 cancelled** |
| **After:** `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres npm test` in `backend` | **607 tests: 607 pass, 0 fail, 0 cancelled, 0 skipped** (29 files, ~2 min) |
| After, **without** `TEST_DATABASE_URL` | 256 pass, **145 fail**, 206 cancelled, **0 skipped**: a missing database can never look like a pass |
| `cd frontend && npm test` (checkpoint) | 841 pass, 0 fail |
| `cd frontend && npm test` (after, with `TEST_DATABASE_URL`) | **841 pass, 0 fail, 0 skipped** (two suites drive the real backend services on PostgreSQL) |
| `cd frontend && npm run build` | **succeeds** (Vite; existing chunk-size warning only) |

What the PostgreSQL suites cover:

- **Migrations:** fresh database, idempotent re-run, two concurrent runners, failing migration rolled back, newer
  schema refused, final types/defaults/constraints/triggers, and refusal to start without `DATABASE_URL`.
- **Transactions:** commit, rollback, joined nesting, connection release after 25 failures, a finished handle refused,
  and isolation.
- **Precision and format:** full double precision, `Date.now()` z-index, and the timestamp format.
- **Concurrency:** 6 parallel same-name creates give unique slugs; 5 parallel saves give versions 1–6 with no mixing.
- **CRUD and authentication over real HTTP:** every role and flag gate, cookie policy in 6 configurations, signup races.
- **Import:**
  - a full current-schema SQLite file, every table compared row by row;
  - the published protocol is served publicly with `hasUnpublishedChanges = false`;
  - an archived protocol keeps its pointer;
  - dry run, refusals, and full rollback on a bad row;
  - a legacy schema-0 file imported, then served over HTTP (old passwords work, coordinates exact, legacy finger
    readable).

## 7. Final SQLite runtime audit

- **Static (`backend/src/`):** no `better-sqlite3` import, no `prepare/get/all/run/exec/pragma`, no `?` placeholders,
  no `datetime('now')`, no `INSERT OR`, no `sqlite_master`, no `DATABASE_FILE`. The word "SQLite" appears only in
  comments that explain parity decisions.
- **Who requires `better-sqlite3`:** only `scripts/legacy-sqlite/*`, `scripts/import-sqlite-to-postgres.js`, and the
  import/legacy test helpers. It is an `optionalDependency`.
- **Live process:** the real server was started on PostgreSQL and every route group was exercised over HTTP:
  - register and `me`;
  - create, then save with a `Date.now()` z-index, then publish;
  - list, versions, details and catalog;
  - public list, detail, render and categories;
  - AI, camera and payment status, the AI assistant, and protocol access;
  - an admin route requested as a doctor (403).

  All gave the expected status. The process had loaded **326 modules, 0 of them SQLite-related**, and nothing from
  `scripts/`.

## 8. Remaining external blockers (could not be done here)

1. **Neon not verified.** No Neon credentials were available. To verify: create a Neon branch, then run
   `npm run db:status`, then `npm run db:migrate`, and start a staging service on it. Optionally run the suite against
   it with `ALLOW_REMOTE_TEST_DATABASE=1 TEST_DATABASE_URL=<branch URL>`; it creates and drops its own databases there.
2. **Production data not migrated.** No production SQLite file was supplied. Production apparently ran on Render's
   temporary disk, so the file must be downloaded from the running instance (Render Shell or persistent disk) **before**
   any redeploy. Then run `--dry-run` and then the real import into a fresh Neon branch (docs/POSTGRESQL.md §4).
3. **Render not changed (not authorised).** Cut-over means setting `DATABASE_URL` (the Neon pooled URL) on the backend
   service and redeploying. `DATABASE_FILE` is no longer read. Keep the previous build and the SQLite copy for rollback.
4. Browser and real-device checks (Studio drawing, camera/AR) remain manual, as before (docs/REAL_DEVICE_VALIDATION.md).

## 9. Files changed (relative to checkpoint `08375fa`)

108 paths (A = added, M = modified, D = deleted, R = moved):

**Runtime:**

- `backend/src/db/`: index.js (M), openPostgres.js (M), postgres-migrate.js (M), errors.js (A),
  postgres-migrations/004_sqlite_parity.sql (A), postgresRuntime.js (D).
- `backend/src/repositories/`: catalog, featureFlags, payments, protocols and users `.repo.js` (M); every `*.pg.repo.js` (D).
- `backend/src/services/`: protocolService, publicProtocols, catalogService, featureFlags, adminSeed, slug (M);
  adminSeed.pg, catalogService.pg, featureFlags.pg (D).
- `backend/src/routes/`: all 14 database-backed routers (M).
- `backend/src/`: server.js, middleware/auth.js, middleware/flags.js, payments/paymentService.js, ai/assistantService.js (M).

**Tooling:**

- backend/package.json and package-lock.json (M); .env.example (M).
- scripts/db-migrate.js, db-status.js, create-admin.js, flags.js, import-sqlite-to-postgres.js (M);
  db-pg-migrate.js, db-pg-status.js (D).
- scripts/legacy-sqlite/importer.js (A).
- scripts/legacy-sqlite/{open.js, migrate.js, migrations/*} (R, from src/db/).

**Tests:**

- backend/tests/helpers/pg.js (A); httpHarness, publishingEnv, testDb, banner (M).
- New suites (A): postgres.migrations, postgres.runtime, sqlite-import.
- Renamed (R): legacy-sqlite.migrations, legacy-sqlite.publishing-migration, users.repo.
- Converted to async PostgreSQL (M): adminSeed, ai.admin-flag.http, ai.assistant.http, ai.provider-service,
  ai.stage2.http, ai.stage2.matching, auth.cookies, camera.http, catalog, doctor.studio, featureFlags,
  http.integration, payments.http, payments.service, publishing.http, publishing.lifecycle, publishing.versions,
  studio.data.
- frontend/tests/publicPdf.published.test.mjs and studioBackend.e2e.test.mjs (M).

**Docs:**

- docs/POSTGRESQL.md (A) and this report (A).
- README.md, ARCHITECTURE.md, docs/FOUNDATION.md, AI_PROTOCOL_ASSISTANT.md, CAMERA_AR.md, PAYMENTS_AND_ACCESS.md,
  PROTOCOL_STUDIO.md, SHARING_AND_PDF.md (M).
- The superseded POSTGRES_CONVERSION_STATUS.md (both copies) and POSTGRES_RUNTIME_BLOCKERS.md (D).

The exact list: `git diff --name-status -M 08375fa HEAD`.
