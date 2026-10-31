# Colour Therapy Protocol Platform — Phase 1

> **Current state:** see [`docs/FOUNDATION.md`](docs/FOUNDATION.md) (migrations, admin role, feature flags, commands, upgrade steps) and
> [`docs/REAL_DEVICE_VALIDATION.md`](docs/REAL_DEVICE_VALIDATION.md), [`docs/PROTOCOL_PUBLISHING.md`](docs/PROTOCOL_PUBLISHING.md) (protocol lifecycle, publishing, public/admin API), and [`docs/PROTOCOL_STUDIO.md`](docs/PROTOCOL_STUDIO.md) (the 4-view authoring Studio: tools, presets, data model, import/export, browser QA checklist), and [`docs/PUBLIC_WEBSITE.md`](docs/PUBLIC_WEBSITE.md) / [`docs/ADMIN_CONDITIONS.md`](docs/ADMIN_CONDITIONS.md) (the public site and admin condition management), and [`docs/AI_PROTOCOL_ASSISTANT.md`](docs/AI_PROTOCOL_ASSISTANT.md) (the public AI Protocol Assistant, Stages 1–2 — off by default, switched on and off by an administrator at `/admin/ai`), and [`docs/PAYMENTS_AND_ACCESS.md`](docs/PAYMENTS_AND_ACCESS.md) (free-launch protocol access and the payment-ready architecture — nothing is charged; switch at `/admin/payments`), and [`docs/SHARING_AND_PDF.md`](docs/SHARING_AND_PDF.md) (the doctor workflow, shareable links and the PDF download), and [`docs/CAMERA_AR.md`](docs/CAMERA_AR.md) (the public Camera option: live AR markings on the visitor's own hand — off by default, switched at `/admin/camera`), and [`docs/HAND_AR_ACCURACY.md`](docs/HAND_AR_ACCURACY.md) (how markings attach to the hand, measured accuracy, and the real-camera validation procedure). Registration is now admin-created only; `npm test` at the project root runs all tests.
> The text below is the original Phase 1 description and is partly out of date.

A real, two-tier web application (separate backend API + frontend SPA) for the
Doctor/Admin Protocol Builder described in the Phase 1 spec. No existing
project was supplied, so this is a fresh build using a standard, boring
stack chosen specifically so it's easy to run locally and easy to hand off:

- **Backend:** Node.js + Express + **PostgreSQL** (Neon in production, via `pg`), JWT auth in
  an httpOnly cookie, bcrypt password hashing. (The app originally used SQLite; see
  [`docs/POSTGRESQL.md`](docs/POSTGRESQL.md) for the runtime, migrations and the one-off SQLite import.)
- **Frontend:** React (Vite) + `react-konva` (Konva.js canvas engine) +
  Zustand for state/undo-redo, `react-router-dom`, `axios`.

Patient accounts, the camera, and AR hand-landmark mapping are **not**
implemented in Phase 1 — see `PHASE2.md` for what's been added since.

---

## 1. Prerequisites

- Node.js 20.6+ and npm
- A PostgreSQL database: a Neon database/branch, or a local PostgreSQL 14+ server. The server applies its own
  migrations on start. There is no file-database fallback: without `DATABASE_URL` the backend refuses to start.

## 2. Running it locally

Open two terminals.

**Terminal 1 — backend**
```bash
cd backend
cp .env.example .env        # set DATABASE_URL (and JWT_SECRET before doing this for real)
npm ci
npm run db:status           # optional: proves the connection, shows the schema version
npm run dev                 # http://localhost:4000 (applies pending migrations first)
```

**Terminal 2 — frontend**
```bash
cd frontend
cp .env.example .env        # points at http://localhost:4000 by default
npm install
npm run dev                 # http://localhost:5173
```

Open `http://localhost:5173`. Register a doctor account, then you're on the
dashboard.

## 3. Testing the Phase 1 acceptance flow

This walks through the 21 acceptance tests from the spec, in order:

1. **Register / log in** as a doctor (this is Test 0, implicit).
2. Click **+ Create Protocol**, name it, choose **Hand**, submit. You land in
   the Protocol Studio, which shows **all four hand views at once** (Left
   Front, Right Front, Left Back, Right Back); work on any view by clicking
   it (Tests 1–2).
3. Select the **Dot** tool, click on the hand → red dot appears (Test 3).
   Select the **Ring** tool, click elsewhere, then use the colour picker in
   the right panel to make it blue (Test 4).
4. Add a **Horizontal Line** and a **Vertical Line** from the tool palette on
   the left (Tests 5–6).
5. Add an **Inverted Triangle** (Test 7).
6. Click **Select**, drag any object to move it, drag a corner/edge handle to
   resize it (Test 8).
7. With an object selected, change its colour in the right panel (Test 9).
8. Select the red dot → bottom-bar **Copy** → bottom-bar **Paste**. A second
   dot appears offset from the first (Tests 10–11).
9. Select the pasted dot, change its colour to green. The original stays red
   — they're independent objects with independent IDs (Test 12).
10. Click **Undo** a few times, then **Redo** (Tests 13–14) — or use
    `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z`.
11. Click **Save Protocol** (Test 15).
12. Click **← Dashboard** (Test 16).
13. Click the protocol's name to reopen it (Test 17) — every object should
    be exactly where you left it.
14. Click the **Right Front** tab (Test 18) — it starts empty; markings you
    made on Left Front do not appear there.
15. Back on the dashboard, create a new protocol, this time choosing
    **Organ / Body** (Test 19). Note: only a placeholder body outline ships
    with this build (see §5 below) — it's there so this flow is testable,
    not as a real diagram.
16. Place a dot, horizontal line, vertical line, inverted triangle, and ring
    on it (Test 20).
17. Save, leave, and reopen it — everything should still be there (Test 21).

Keyboard shortcuts (with nothing focused in a text field): `Ctrl/Cmd+Z` undo,
`Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` redo, `Ctrl/Cmd+C` copy, `Ctrl/Cmd+V`
paste, `Ctrl/Cmd+D` duplicate selected, `Delete`/`Backspace` delete selected.

## 4. What I could not actually test, and why

**I was not able to run `npm install` or launch either server in this
environment** — the sandbox this was built in has no outbound network
access to the npm registry (confirmed: requests are blocked with
`host_not_allowed`). So I cannot honestly tell you "I ran it and it works."

What I *did* do to de-risk that:
- Every `.js`/`.jsx` file (backend and frontend) was run through esbuild in
  transform-only mode, which parses full JS/JSX syntax — this catches typos,
  mismatched brackets, bad JSX, etc. All files pass.
- I read through the data flow end-to-end by hand (client → API → SQLite →
  API → client) for create, save, reopen, duplicate, and assign, checking
  types and normalized-coordinate math at each hop.
- The four hand assets were cropped and pixel-verified (see §5) before
  wiring them in.

What this does **not** catch: runtime/dependency issues that only show up
once real npm packages are installed (e.g. a react-konva prop name that
changed between minor versions), browser-only behaviour, or CSS layout
quirks you'd only see with your own eyes. Please run it locally and treat
the acceptance walkthrough above as your real Test 1–21 — if something
doesn't work, it's almost certainly a small, fixable thing (wrong prop name,
a CSS tweak), not a structural problem, but I'd rather tell you this plainly
than claim a test pass I didn't actually get to observe.

## 5. About the image assets

- `backend/assets/hands/{left_front,right_front,left_back,right_back}.png`
  are cropped **directly** from the reference sheet you provided — pixel
  data untouched, nothing redrawn, redrawn, traced, regenerated, or
  converted to SVG. One crop (`right_back`) had a sliver of your logo
  bleeding into its corner from the sheet layout; those few stray pixels
  were whited out (nothing else in the artwork was touched).
- `backend/assets/organs/body_front_placeholder.png` is a **crude placeholder
  I drew** — a generic wireframe silhouette — because no real organ/body
  diagram was supplied. It exists only so the organ/body canvas type is
  wired up and testable end-to-end. The app labels it "placeholder" in the
  UI and the API flags it with `isPlaceholder: true`. Swap it for a real
  asset before this is used with real patients — see the comment block at
  the top of `backend/src/config/organAssets.js` for the two-step process
  (drop in the file, add a registry entry). The asset pipeline (static file
  serving, the frontend's image loader) works from a plain URL and file
  extension, so it accepts PNG, JPG, or **SVG** for future organ/body
  diagrams with no code changes.

## 6. Project structure

```
backend/
  src/
    db/            PostgreSQL pool + transactions (index.js), migration runner, postgres-migrations/
    middleware/     requireAuth, requireRole
    routes/         auth, protocols, assets
    config/         hand + organ asset registries
    utils/          jwt, password hashing, DB-row → API-JSON serializers
  assets/hands/     the four provided hand diagrams (cropped, untouched)
  assets/organs/    placeholder body outline (see §5)

frontend/
  src/
    auth/           AuthContext, ProtectedRoute
    builder/        the Protocol Studio: Zustand store (with undo/redo), the
                     object model + config (presets, palette, finger guides),
                     Konva shape components, 2x2 workspace, tool palette,
                     properties / protocol-details panels, JSON import/export
                     (see docs/PROTOCOL_STUDIO.md)
    pages/          Login, Register, Dashboard, ProtocolStudioPage
```

See `ARCHITECTURE.md` for the data model, the copy/paste implementation, the
normalized-coordinate system, and how this connects to the future AR phase.
