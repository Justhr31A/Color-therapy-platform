# Public Website (Phase 1)

Four public, unauthenticated pages that let a visitor browse, read and download **published** colour therapy
protocols. AI, payments, camera/AR and patient accounts stay off (`AI_ASSESSMENT`, `PAYMENTS`, `CAMERA`, `AR`,
`PATIENT_ACCOUNTS`, `PATIENT_ASSIGNMENT` all default `false` — unchanged by this phase).

## Pages and routes

| Route | Page | Purpose |
| --- | --- | --- |
| `/` | `pages/public/HomePage.jsx` | Hero, "How it works", published categories, up to 6 featured protocols, disclaimer |
| `/protocols` | `pages/public/ProtocolBrowserPage.jsx` | Search, category filter, condition filter, protocol cards |
| `/protocols/:slug` | `pages/public/ProtocolDetailsPage.jsx` | Full details, all hand views with markings, Download PDF, Copy link |
| `/protocols/:slug/camera/:viewKey` | `pages/public/PublicCameraPage.jsx` | Live camera AR for one published protocol view (only offered while the camera is switched on; see `docs/CAMERA_AR.md`) |
| `/find-protocol` | `pages/public/FindProtocolPage.jsx` | "Find a Relevant Protocol" — the AI Protocol Assistant (only linked, and only usable, while the `AI_ASSESSMENT` flag is on; see `docs/AI_PROTOCOL_ASSISTANT.md`) |

`/` now always renders the public home page, for anyone, logged in or not — it no longer redirects to `/login`.
Every existing route (`/login`, `/register`, `/dashboard`, `/builder/:id`, `/patient/*`) is unchanged.

Each page has its markup split into a plain, prop-driven `*View` component (`HomePageView`, `ProtocolBrowserView`,
`ProtocolDetailsView`) and a thin data-fetching wrapper. The `*View` half can be rendered directly in a test with
any combination of loading/empty/error/populated data — `useEffect` never runs during that kind of render, so
only the split-out half is actually testable that way.

## One source of truth

Every public page reads **only** the existing public API, which reads **only** a protocol's frozen published
snapshot — never the editable draft:

```
GET /api/public/categories           categories with ≥1 published protocol   (NEW, see below)
GET /api/public/protocols            search/filter, published only            (already existed)
GET /api/public/protocols/:slug      name, category, conditions, description  (already existed)
GET /api/public/protocols/:slug/render   the structured objects to draw       (already existed)
```

A draft or in-review edit is invisible on the public site until it is published (`backend/src/services/publicProtocols.js`
verifies each snapshot's checksum and only ever reads `protocols.published_version_id`); publishing again is what
makes the public site's copy change. No protocol data is hard-coded anywhere in the frontend.

**The one thing added to the backend this phase**: `publicProtocolService.listCategories()` and its route,
`GET /api/public/categories`. Nothing else existed for "which categories currently have a published protocol",
so the home page and the browser's category filter had no way to populate themselves. It reads the exact same
published-snapshot rows `list()` already reads — not a second query path, not a second representation.

## One renderer, two places it's embedded

`frontend/src/viewer/renderMarkings.js` is a pure, framework-free module that draws all 13 object types (Dot,
Ring, Dot + Ring, Finger Band, H/V line, Free line, Triangle, Inverted Triangle, Rectangle, Square, Arrow, Text)
as an SVG string, ported from the exact same geometry the Doctor/Admin Protocol Studio's Konva shapes use
(`src/builder/shapes/*.jsx`) — same formulas, same fields, just SVG markup instead of Konva nodes. Dot + Ring and
Finger Band specifically reuse the Studio's own `getRing`/`hasActiveRing`/`effectiveRingGapPx`/`getBand`
functions from `src/builder/model/objectModel.js`, so the public site can never silently disagree with the
Studio about what a ring's colour or gap means.

- `HandViewsViewer.jsx` embeds this SVG **inline, on the page**, for the live on-screen details view.
- `buildDownload.js` embeds the **same** SVG into a downloadable file.

Neither one draws anything on its own; both call `svgForCanvas`. That is the whole of "do not create a second
protocol renderer" in practice.

## Download

The primary download is a **PDF** (`viewer/pdf/buildPdf.js`, see `docs/SHARING_AND_PDF.md`); the earlier self-contained HTML page
(`buildProtocolDownloadHtml`) is kept as a secondary "Offline copy (HTML)". Both are built from `/render` — the published snapshot — never
the draft, and both draw markings with the same `svgForCanvas` / primitives as the page.

## What's still admin-only

The Protocol Studio (`/builder/:id`), `/dashboard`, and every `/api/protocols/*` and `/api/admin/*` route are
unchanged and still require a doctor/admin session — nothing on the public site can create, edit, save, publish,
duplicate, delete, or manage versions. `PublicHeader.jsx`'s only link into the authenticated app is
"Practitioner Login", which goes to the existing `/login` page.

## Tests

`npm test` at the project root: **backend 245 · frontend 382**. New this phase: 2 backend (the categories route)
+ 54 frontend (`publicRenderMarkings.test.mjs` 17, `publicDownload.test.mjs` 7, `publicPages.render.test.mjs` 30).

`publicPages.render.test.mjs` covers, per page: loading/empty/error states, published-only content (nothing
invented when the database is empty), search and category filtering, read-only (no edit/save/admin controls
anywhere), all four hand views rendering from the published structured snapshot, Dot + Ring and Finger Band
specifically, no raw search terms shown, the Download button's disabled/error states, and an unpublished/unknown
slug producing a clean not-found state rather than a crash.

## Known limitations

- Download: PDF (primary) and HTML. No PNG export.
- The condition filter's options come from whatever protocols are currently loaded in the browser (not a
  separate `/api/public/conditions` endpoint), so it may only show conditions actually reachable by search or
  the current category — deliberately simpler than adding another backend list for a "where appropriate" filter.
- Manual browser QA (does it actually look like the target "clean premium" design, is it responsive on a real
  phone) has not been performed — only automated rendering tests.
