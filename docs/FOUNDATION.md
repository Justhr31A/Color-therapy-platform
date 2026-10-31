# Foundation phase — what changed and how to use it

> **Database update (PostgreSQL):** the application now runs on PostgreSQL (Neon) only. The SQLite upgrade steps,
> backups and file paths below are kept as history; for running, migrating and importing an old SQLite database see
> [`POSTGRESQL.md`](POSTGRESQL.md). `npm run db:status`, `db:migrate`, `admin:create` and `flags` now act on `DATABASE_URL`.

> Next layer: protocol lifecycle, publishing, versions, public API — see [`PROTOCOL_PUBLISHING.md`](PROTOCOL_PUBLISHING.md).

This phase made the existing app safe to build the website-first architecture on. It added a database
migration system, feature flags, an `admin` role, closed public registration, and put the tests inside the
repository. It did **not** add the Studio, public website, AI, payments or any new AR behaviour, and it did
not touch `tracking/`, `camera/`, the camera page, the hand PNGs, the patient routes or the Builder UI.

## Upgrading your existing project (Windows / PowerShell)

The new build has a `.git` folder. **Extract it into a NEW folder — never over an existing project** (that could
overwrite an existing repository's history).

1. **Back up your database by hand first** (belt and braces; the app also makes its own backup):
   `Copy-Item -Recurse <old-project>\backend\data <somewhere-safe>\data-backup`
2. Copy your secrets and data from the old project into the new one:
   - `<old>\backend\.env` → `<new>\backend\.env`
   - `<old>\backend\data\` → `<new>\backend\data\`   (this folder holds your database)
   - `<old>\frontend\.env` (if you have one) → `<new>\frontend\.env`
3. Install dependencies in **both** `backend` and `frontend`: `npm install` (no dependency versions changed).
4. See what will happen to your database, without changing anything: `cd backend; npm run db:status`
   (an existing database shows *version 0, pending 001…003*).
5. Start normally (`npm run dev` in `backend`). On first start the runner **backs up the database to
   `backend\data\backups\`**, then applies the migrations. Your accounts and protocols are kept as they are.

### Restoring from a backup
Stop the server. In `backend\data`, delete `protocol_platform.db-wal` and `protocol_platform.db-shm` if present,
then copy the chosen file from `backups\` over `protocol_platform.db`. Backups are never deleted automatically.

## Commands

| Command | Where | What it does |
|---|---|---|
| `npm test` | project root | all backend + frontend deterministic tests (Node **20.6+**) |
| `npm run test:backend` / `test:frontend` | project root | one half only |
| `npm run db:status` | `backend` | read-only: PostgreSQL connection, schema version and pending migrations |
| `npm run db:migrate` | `backend` | apply pending PostgreSQL migrations now (the server does this on start too) |
| `npm run db:import-sqlite` | `backend` | one-off copy of an old SQLite file into a fresh PostgreSQL database (see POSTGRESQL.md) |
| `npm run admin:create` | `backend` | create the first admin, or promote an existing doctor (below) |
| `npm run flags` | `backend` | list feature flags; `-- enable KEY` / `-- disable KEY` to change one |

## Creating the first admin
The password is read from an environment variable so it never lands in shell history or source code.
Use **single quotes** in PowerShell (a `$` inside double quotes would be expanded):
```powershell
cd backend
$env:ADMIN_EMAIL='you@example.com'
$env:ADMIN_NAME='Your Name'
$env:ADMIN_PASSWORD='a-long-passphrase-at-least-12-chars'
npm run admin:create
Remove-Item Env:ADMIN_PASSWORD
```
To make your **existing doctor account** an admin instead (keeps its password and all its protocols — no password variable needed):
```powershell
$env:ADMIN_EMAIL='your-existing-doctor@example.com'
npm run admin:create -- --promote
```
Patients can never be made admins. Role changes take effect on the next request (the role is read from the database, not from the login token).

## Roles
| Role | Can do |
|---|---|
| `admin` | everything in the protocol builder, on **all** protocols |
| `doctor` (legacy) | the builder, on **their own** protocols only — unchanged |
| `patient` (legacy) | read their assigned protocol and use the camera — unchanged |

**Public registration is disabled.** `POST /api/auth/register` now answers 403 and never touches the database.
(Previously anyone could create a full doctor account.) The Register page still exists and shows that message;
removing it is left for the admin-UI phase. Existing accounts log in exactly as before.

## Feature flags
Stored in the `feature_flags` table; definitions and dependencies live in `backend/src/services/featureFlagDefinitions.js`.
A flag counts as ON only if it **and everything it requires** is ON — enforced whenever it is read.

| Flag | Initial | Requires | Enforced by the backend today? |
|---|---|---|---|
| WEBSITE, PROTOCOL_BROWSER | ON | – | **yes** — the public protocol API (`/api/public/*`) answers 404 when either is off |
| DOWNLOAD | ON | – | not yet (no download API exists) |
| ADMIN | ON | – | **yes** — all `/api/admin/*` routes answer 404 when it is off |
| PROTOCOL_STUDIO | ON | – | **yes** — all `/api/protocols/*` routes answer 404 when it is off |
| AI_ASSESSMENT | OFF | – | the AI Protocol Assistant (Stage 1, `docs/AI_PROTOCOL_ASSISTANT.md`) — public, read-only, stays OFF until switched on |
| PAYMENTS | OFF | – | latch for REAL charging only; stays OFF. Free-launch access works without it (`docs/PAYMENTS_AND_ACCESS.md`) |
| CAMERA | OFF | – | **yes** — together with AR it decides `GET /api/public/camera/status`; admins switch both at `/admin/camera` (`docs/CAMERA_AR.md`) |
| AR | OFF | CAMERA | **yes** — see CAMERA |
| PATIENT_ACCOUNTS | OFF | – | **deliberately not yet** (see below) |
| PATIENT_ASSIGNMENT | OFF | PATIENT_ACCOUNTS | **deliberately not yet** (see below) |

When a flag is off its API answers **404 "Not found"** (a 403 would reveal the feature exists); unauthenticated callers still get 401 first.
The frontend never decides — UI checks are convenience only.

**Legacy patient routes are not gated yet, on purpose.** The patient flags start OFF as you specified, but the patient system still
works today and you asked that it not be switched off. So the flags exist and are enforced by the middleware, but `/api/patient/*`,
`/api/auth/patient/activate` and `POST /api/protocols/:id/assign` do not use them yet. Plan for the next phase:
`router.use(requireFlag('PATIENT_ACCOUNTS'))` on the patient router and the activation route, and
`requireFlag('PATIENT_ASSIGNMENT')` on the assign route — done together with turning those two flags ON for as long as the legacy system is in use.

## Design notes
- **Database access (now PostgreSQL).** All data access goes through `backend/src/repositories/*` (async, `pg`); the SQLite runner and
  migrations described next were moved to `backend/scripts/legacy-sqlite/` and are used only by the SQLite importer. See POSTGRESQL.md.
- **(Historical) SQLite migrations** (now `backend/scripts/legacy-sqlite/migrations/`): `001_baseline` (the old schema, unchanged; a no-op on an existing database),
  `002_users_admin_role` (table rebuild to allow `admin`, with foreign keys checked before commit), `003_feature_flags`.
  Each runs in its own transaction with the version bump; a failure leaves the database exactly as it was. Existing databases are backed up first
  (using `VACUUM INTO`, which includes data still in the WAL file — a plain file copy would not). A database newer than the code is refused.
- **Finger names.** Canonical: thumb, index, middle, ring, **little**. An old saved `pinky` is still read correctly (the dropdown shows it as
  "little") and is rewritten as `little` the next time that protocol is saved. Nothing is rewritten in bulk.

## Decisions recorded and their status
| # | Decision | Status |
|---|---|---|
| 1 | SQLite now, Postgres-ready | **superseded**: the runtime is PostgreSQL (Neon) only — see POSTGRESQL.md |
| 2 | `admin` role | done |
| 3 | protocol ↔ condition many-to-many | **done** in the publishing phase (`condition_protocols`, see PROTOCOL_PUBLISHING.md) |
| 4 | finger names | done (canonical `little`, legacy `pinky` readable) |
| 5 | rectangle/square as one shape | recorded; **no change yet**, both legacy types still valid |
| 6 | SPA, clean slugs later | recorded; no change |
| 7 | no PNG/PDF export yet | none added |
| 8 | English only | no i18n added |
| 9 | Small/Medium/Large presets, configurable | recorded; **not built** (Studio phase; will live in a settings table, not in code) |
| 10 | Mon–Fri schedule | n/a to the code |

## Known remaining issues (not fixed here, by design)
- No rate limiting, security headers or CSRF protection; JWTs last 7 days and cannot be revoked. `JWT_SECRET` may still be the placeholder (only warns).
- Patient activation still doesn't verify email ownership (documented limitation).
- The Register page and the builder's "assign to patient" box are still in the UI.
- (Resolved in the publishing phase: versions are now complete immutable snapshots and there is an explicit publish action — see PROTOCOL_PUBLISHING.md.)
- (Historical test caveat for this phase, now resolved: the suite runs with the real packages against a real PostgreSQL server — see POSTGRESQL.md "Tests".)
