# Doctor workflow, sharing a published protocol, and the PDF download

This describes how a practitioner takes a protocol from nothing to something a patient can open and print, and exactly how the shared
link and the PDF are produced. (Marking details — sizes, free thickness, outlines, attached rings — are in `docs/PROTOCOL_STUDIO.md`.)

## The doctor workflow

| Step | Where |
| --- | --- |
| 1. Register / log in (public doctor registration is currently open; admin accounts are only created by an operator with `npm run admin:create`) | `/register`, `/login` |
| 2. Choose the protocol's category and condition(s) from the existing lists (an admin creates new ones: `/admin/conditions`, see `docs/ADMIN_CONDITIONS.md`) | Studio → **Protocol** tab |
| 3. Create a protocol | Dashboard → **+ Create Protocol** (hand protocol = four views) |
| 4. Edit the four hand views, add markings | Studio, `/builder/:id` |
| 5–10. Outlines, multiple attached rings, colours, sizes (Small/Medium/Large/Extra Large), free thickness | Studio **Properties** tab |
| 11. Save the draft | **Save Protocol** (top bar) or **Save Draft** (Protocol tab) |
| 12. Preview | **Preview** (read-only, all four views) |
| 13. Publish your own protocol | **Protocol** tab → **Publish Protocol** (saves your latest edits, validates, then freezes an immutable version) |
| 14. Share / download | **Protocol** tab → **✓ Published** → **Copy Share Link** · **Open Public Protocol** · **Download PDF** |
| 15. Change it later | edit and save as usual: the live version stays as it was and the tab says there are unpublished changes; **Publish New Version** creates the next immutable version |

Nothing in steps 1–12 is public. Drafts and in-review protocols are never reachable by anyone who is not signed in as their owner (or an admin).

### What a doctor can and cannot do (all enforced by the server)

| A doctor CAN, for their OWN protocols | A doctor CANNOT |
| --- | --- |
| create, edit and save them; describe them (display name, descriptions, category, conditions, search terms); publish and re-publish them; copy the share link and download the PDF of the published version | touch another doctor's protocol (every attempt is a plain `404`); create or edit categories or conditions (they choose from the existing active ones); change a protocol's slug or status through the details endpoint; archive, restore versions or read version history; use anything under `/api/admin/*` |

Admins keep every administrative capability (all protocols, catalog management, archive, status changes, version history and restore).

### The doctor endpoints (all behind sign-in as doctor/admin and the `PROTOCOL_STUDIO` flag; ownership-checked, `404` for anyone else's protocol)

| Endpoint | Purpose |
| --- | --- |
| `POST /api/protocols/:id/publish` | publish (the one doctor publishing endpoint; same service as the admin one) |
| `GET /api/protocols/:id/details` | status, category, conditions, search terms, published version, `hasUnpublishedChanges` |
| `PUT /api/protocols/:id/details` | `name`, `displayName`, `shortDescription`, `description`, `categoryId` only — `slug`, `status`, `metadata` or anything else is refused with `400 FIELD_NOT_ALLOWED` |
| `POST /api/protocols/:id/search-terms` · `DELETE /api/protocols/:id/search-terms/:termId` | search terms |
| `POST /api/protocols/:id/conditions` `{conditionId}` · `DELETE /api/protocols/:id/conditions/:conditionId` | link / unlink an existing active condition |
| `GET /api/catalog/categories` · `GET /api/catalog/conditions` | read-only lists of ACTIVE categories / conditions (`id`, `name`, `slug`) to choose from |

These call the same service functions as the admin endpoints, so validation and the lifecycle rules are identical. Editing a published protocol
(markings, details, search terms or conditions) never changes the published snapshot; it only sets `hasUnpublishedChanges`.

## Sharing

After publishing, the Studio's **Protocol** tab shows **✓ Published** and a **Share** block with the public URL, **Copy Share Link** (with a visible message if the browser blocks clipboard access), **Open Public Protocol** and **Download PDF**.

* The link is the **existing public route** `/protocols/:slug` — the protocol's stable slug (`viewer/shareLink.js`: `publicProtocolUrl`). Nothing
  is generated or stored; the same function builds the link in the Studio and on the public page.
* It always serves the **published, immutable version**. The server answers `404` for anything not published, so a draft's link does not
  resolve, and editing the draft afterwards changes nothing until you publish again (the Share block says so while there are unpublished changes).
* The public page is read-only and offers **Download PDF**, **Copy link** and an **Offline copy (HTML)**.
* The Share block is only shown for a `published` protocol (draft, in-review and archived have no public link), to the owning doctor and to admins. **Download PDF** is built from the PUBLISHED version through the public render endpoint (`src/viewer/pdf/publishedPdf.js`), never from the draft or unsaved edits, and is named after the protocol.
* No social-media integration was added.

## The PDF

**Download PDF** produces a real PDF 1.7 file (built by `pdf-lib`; not an HTML page renamed). It is built in the browser, on demand, from the
public `/render` payload — the published snapshot — so the draft can never leak into it.

Contents: page 1 — protocol name, summary, category, condition(s), published version and date, the public link, the description (flowing onto
further pages if long) and the medical disclaimer; then a markings page with **Left Front, Right Front, Left Back, Right Back** (any number of
views for other protocol types), each on its real hand image, with a labelled frame; every page has a footer with its number. Document
properties (title, subject, author, keywords) are filled in.

**One source of truth.** `viewer/renderMarkings.js` turns a canvas's structured objects into neutral drawing *primitives* (circle, line,
polyline, polygon, rect, path, text, group). The public page serializes them to SVG; `viewer/pdf/primitivesToPdf.js` serializes the *same* primitives
to PDF drawing operators as vector graphics over the image. Colours, outlines, attached rings (zero gap), finger bands, text and very thick
strokes therefore come out the same as on the website; nothing about a marking is decided in the PDF code.

Files: `viewer/pdf/primitivesToPdf.js` (pure serializer), `viewer/pdf/buildPdf.js` (layout, fonts, images, metadata), `viewer/shareLink.js`.

**Dependency.** `pdf-lib` (`frontend/package.json`) — run `npm install` in `frontend/`. It is loaded on demand (dynamic import) so it is only
downloaded when someone requests a PDF.

**Behaviour worth knowing**
* Text uses the PDF standard fonts (Helvetica). Characters those fonts cannot show (emoji, non-Latin scripts) are printed as `?` rather than failing the download.
* If a hand image cannot be fetched, that view is still drawn — markings included — on a plain grey panel.
* Overlapping *translucent* strokes inside one object (e.g. a finger band's halo over its strip) can differ very slightly from the web, because PDF has no cheap equivalent of SVG's composited group opacity. Geometry and colours are identical.
* PNG export is not provided.

## Tests

* `publicPdf.test.mjs` — the serializer operator by operator (including that attached rings are zero-gap in the PDF's own content stream), and a real
  file: header/trailer, re-opened by `pdf-lib`, metadata, page text, four views with four embedded images, every curve drawn, colours, ring colours,
  outline widths, 1,000,000,000 px thickness, legacy ring, JPEG/PNG/missing/garbage images, long descriptions, unsupported characters, one-view and
  no-view protocols, determinism. Plus `qpdf --check`, `pdftotext` and `pdftoppm` run against the generated file **when those tools are installed** (they are skipped otherwise).
* `publicPdf.published.test.mjs` — real backend service + PostgreSQL: a draft has no public data; the PDF carries the published markings and is unchanged by
  later draft edits; publishing again is what changes it.
* `publicShare.test.mjs` — the link, clipboard behaviour, and that `/protocols/:slug` is a public, read-only route.
* `publicLegacyParity.test.mjs` — objects saved before this feature render exactly as before.
