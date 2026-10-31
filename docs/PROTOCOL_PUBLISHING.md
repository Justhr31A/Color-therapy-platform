# Protocol data + publishing foundation

This layer makes **one structured protocol** the single source of truth that the Protocol Studio, the public
website, downloads, the AI recommendation layer and AR can all read. No UI, AI, payment or AR behaviour was
added here — only the database, services and APIs underneath them.

```
Protocol Studio ──edits──▶ working copy (draft rows)
                                │  Publish (validated, transactional)
                                ▼
                     immutable published version (frozen snapshot)  ◀── protocols.published_version_id
                                │
        ┌───────────────────────┼───────────────────────┐
   Public viewer            Download                 Future AR
   GET /api/public/protocols/:slug[/render]  — the SAME data for all of them
                                │
                  later: AI assessment ──▶ recommended protocol (same published source)
```

## Migrations (existing databases are backed up first, then upgraded in place)

| # | Name | What it does |
|---|---|---|
| 004 | `catalog_tables` | adds `categories`, `conditions`, `condition_protocols`, `protocol_search_terms` (purely additive) |
| 005 | `protocol_publishing` | rebuilds `protocols` (slug, lifecycle, metadata, published pointer); adds columns to `protocol_versions`; back-fills slugs and checksums; installs the database-level guards |

Migrations 001–003 are untouched (a test pins their SHA-256). Existing protocols, canvases, objects, versions and users
survive unchanged: every original column of every original row is verified identical by the tests, legacy `active` status
is preserved, nothing becomes public by migrating, and a failure rolls back and leaves the database at its previous version.

## Tables

**protocols** (rebuilt; original columns kept) — new: `slug` (unique, lowercase), `display_name`, `short_description`,
`category_id → categories`, `metadata_json` (free-form, extensible), `published_version_id → protocol_versions`, `published_at`.
`description` is the detailed description. `status` ∈ `draft | in_review | published | archived`, plus legacy `active`.
*CHECK: status = 'published' requires a published_version_id.*

**protocol_versions** (columns added, rows never modified) — `kind` (`checkpoint` | `published`), `schema_version`
(1 = older partial snapshots, 2 = complete), `created_by`, `restored_from_version`, `checksum` (SHA-256 of `snapshot_json`), `note`.

**categories** — `id` (UUID), `name`, `slug` (unique), `description`, `is_active`, `sort_order`, timestamps.
**conditions** — `id`, `name`, `slug` (unique), `description`, `category_id` (optional), `is_active`, timestamps. No patient data.
**condition_protocols** — `(condition_id, protocol_id)` as the PRIMARY KEY: the same link cannot exist twice; many-to-many.
**protocol_search_terms** — `id`, `protocol_id`, `term`, `term_normalized` (lowercase, spaces collapsed), `kind` (`keyword|synonym|phrase`);
`UNIQUE(protocol_id, term_normalized)`. Independent of the protocol title.

**Enforced by the database itself** (not only by application code):
`protocol_versions` rows cannot be UPDATEd; cannot be DELETEd while their protocol exists; `published_version_id` must reference a
`published` version **of the same protocol**; a protocol that has been published cannot be deleted (archive it).

## Lifecycle

| From → To | How | Allowed |
|---|---|---|
| draft ↔ in_review | `POST /status` | yes |
| draft / in_review → archived | `POST /status` or `/archive` | yes |
| draft / in_review / active / published → **published** | `POST /publish` **only** | yes (after validation) |
| published → archived | `/archive` | yes (leaves public view immediately) |
| published → draft / in_review | — | **refused (409)**: it would silently unpublish |
| archived → draft | `POST /status` | yes (still not public until published again) |
| archived → published | — | refused: move to draft first |

* New protocols start as **draft**. Editing content of an `in_review` protocol sends it back to `draft`.
* `active` is the **legacy** patient-flow status; it is never public and only the old builder dropdown uses it.
* A protocol is public only when `status = published` **and** it has a published version.
* **Editing never affects the public version.** A published protocol whose draft was edited stays `published` and reports
  `hasUnpublishedChanges: true` until it is published again.

## Versioning model
* The `protocols/canvases/objects` rows (+ conditions, search terms) are the editable **working copy**.
* Every content change (create, canvas save, metadata edit, search-term/condition change, restore) records an immutable
  **checkpoint**; publishing records one of kind **published**. Status moves are not content and record nothing.
  Version numbers are consecutive (create = v1, first save = v2 …).
* A **schema-2 snapshot** contains: `schemaVersion`, protocol metadata (name, displayName, shortDescription, description, slug,
  type, free metadata), category, conditions, search terms, `lifecycle` (status, kind, version number, restoredFromVersion, time),
  and every canvas with every object property (normalized coordinates, rotation, colour, thickness, opacity, points, finger,
  `landmarkReference`, `metadata`, zIndex). Text is stored with sorted keys, so identical content gives identical bytes and checksum.
* Older schema-1 snapshots stay readable and restorable (they hold views and markings only).
* Checksums are re-verified whenever a version is restored or served publicly; a mismatch is refused, never served.

## Publishing flow (`POST /api/admin/protocols/:id/publish` for admins, `POST /api/protocols/:id/publish` for the owning doctor — the same service function, one transaction)
1. Build the exact snapshot that would be frozen and **validate** it — all problems are reported at once (422).
2. Store it as a new immutable version of kind `published`.
3. In **one UPDATE**: set `published_version_id`, `status = published`, `published_at`, version counter.
4. Commit. If anything fails, everything rolls back and the previous public version stays live.

### Validation rules (error `code`s)
| Area | Rule |
|---|---|
| Metadata | name required ≤120 (`NAME_REQUIRED`/`NAME_TOO_LONG`); valid slug (`SLUG_INVALID`); displayName ≤120; shortDescription ≤300; description ≤20 000; metadata is an object |
| Views | at least one (`NO_CANVAS`); known & unique (`VIEW_UNKNOWN`/`VIEW_DUPLICATE`); not a placeholder background (`PLACEHOLDER_ASSET`); valid size |
| Content | at least one object overall (`NO_OBJECTS`); ≤500 objects; unique object ids |
| Objects | known type (`OBJECT_TYPE_UNKNOWN`); `x`,`y` numbers within 0–1 (`COORDINATE_INVALID`); width (and height for triangle/rectangle/square types) > 0 and ≤ 1 (`SIZE_INVALID`); hex colour (`COLOR_INVALID`); thickness 0–1000; opacity 0–1; numeric rotation/zIndex; free line ≥ 2 in-range points (`POINTS_INVALID`); finger known (legacy `pinky` accepted); landmarkReference/metadata are objects |
| References | category and conditions exist **and are active** (`CATEGORY_MISSING/INACTIVE`, `CONDITION_INACTIVE`) |
| Serialization | snapshot serializes (no NaN/Infinity/BigInt/functions) and is < 1 MB (`SNAPSHOT_NOT_SERIALIZABLE`/`SNAPSHOT_TOO_LARGE`) |

Drafts may be incomplete; these rules apply only at publish. Failure response: `422 {"error","code":"VALIDATION_FAILED","details":[{"code","path","message"}]}`.

## Public API (no login; read-only; published protocols only)
Gated by feature flags `WEBSITE` and `PROTOCOL_BROWSER` (404 when off). Everything is built from the **frozen published snapshot**,
never from draft rows. A draft, in-review, archived, unpublished or unknown protocol returns the identical `404 {"error":"Protocol not found."}`.

| Endpoint | Returns |
|---|---|
| `GET /api/public/protocols?q=&category=<slug>&condition=<slug>&limit=&offset=` | `{total, limit, offset, items:[{slug,name,displayName,shortDescription,category,conditions,version}]}`. `q` matches search terms first, then names, conditions, short description. Filters use active categories/conditions. Limit ≤ 100. |
| `GET /api/public/protocols/:slug` | details of the currently published version |
| `GET /api/public/protocols/:slug/render` | `protocol-render/1`: structured data for viewer / download / AR |

There are no public endpoints for version history, drafts, or any mutation. **Never exposed:** internal ids (protocol, canvas, version),
owner/doctor/patient data, status/lifecycle, checksums, other versions, and any protocol metadata outside `metadata.public`.
Object ids are exposed (renderers/AR need a stable id per drawn object). Future size-preset/scale, Dot+Ring, Finger Band and AR fields
travel inside each object's `metadata` and `landmarkReference`, so adding them changes no contract.

`GET /api/public/protocols/headache-relief-protocol` (real output):
```json
{
  "slug": "headache-relief-protocol",
  "name": "Headache Relief Protocol",
  "displayName": "Headache Relief",
  "shortDescription": "A colour protocol for recurring headaches.",
  "description": "Place the markings shown on the left palm.",
  "protocolType": "hand",
  "category": {
    "slug": "head-and-neck",
    "name": "Head & Neck",
    "description": "Headaches and neck tension"
  },
  "conditions": [
    {
      "slug": "migraine",
      "name": "Migraine",
      "description": ""
    }
  ],
  "searchTerms": [
    "migraine",
    "one-sided headache",
    "severe headache"
  ],
  "metadata": {
    "audience": "adults"
  },
  "version": {
    "number": 3,
    "publishedAt": "2026-09-28T10:57:21Z"
  },
  "views": [
    {
      "viewKey": "left_front",
      "label": "Left Front",
      "handSide": "left",
      "objectCount": 2
    },
    {
      "viewKey": "right_front",
      "label": "Right Front",
      "handSide": "right",
      "objectCount": 0
    },
    {
      "viewKey": "left_back",
      "label": "Left Back",
      "handSide": "left",
      "objectCount": 0
    },
    {
      "viewKey": "right_back",
      "label": "Right Back",
      "handSide": "right",
      "objectCount": 0
    }
  ],
  "links": {
    "render": "/api/public/protocols/headache-relief-protocol/render"
  }
}
```
`GET /api/public/protocols/headache-relief-protocol/render` (real output; views 2–4 shown without objects):
```json
{
  "contract": "protocol-render/1",
  "protocol": {
    "slug": "headache-relief-protocol",
    "name": "Headache Relief Protocol",
    "displayName": "Headache Relief",
    "shortDescription": "A colour protocol for recurring headaches.",
    "description": "Place the markings shown on the left palm.",
    "protocolType": "hand",
    "category": {
      "slug": "head-and-neck",
      "name": "Head & Neck",
      "description": "Headaches and neck tension"
    },
    "conditions": [
      {
        "slug": "migraine",
        "name": "Migraine",
        "description": ""
      }
    ],
    "searchTerms": [
      "migraine",
      "one-sided headache",
      "severe headache"
    ],
    "metadata": {
      "audience": "adults"
    },
    "version": {
      "number": 3,
      "publishedAt": "2026-09-28T10:57:21Z"
    }
  },
  "canvases": [
    {
      "viewKey": "left_front",
      "canvasType": "hand",
      "label": "Left Front",
      "handSide": "left",
      "background": {
        "assetKey": "left_front",
        "url": "/static/hands/left_front.png"
      },
      "width": 1586,
      "height": 1982,
      "sortOrder": 0,
      "objects": [
        {
          "id": "obj-dot-1",
          "type": "dot",
          "x": 0.4578,
          "y": 0.4983,
          "width": 0.03,
          "height": 0.03,
          "rotation": 0,
          "color": "#e5484d",
          "thickness": 0,
          "opacity": 1,
          "points": null,
          "finger": null,
          "landmarkReference": null,
          "metadata": {},
          "zIndex": 1
        },
        {
          "id": "obj-ring-1",
          "type": "ring",
          "x": 0.5,
          "y": 0.55,
          "width": 0.08,
          "height": 0.08,
          "rotation": 0,
          "color": "#1a73e8",
          "thickness": 4,
          "opacity": 0.8,
          "points": null,
          "finger": null,
          "landmarkReference": null,
          "metadata": {},
          "zIndex": 2
        }
      ]
    },
    {
      "viewKey": "right_front",
      "canvasType": "hand",
      "label": "Right Front",
      "handSide": "right",
      "background": {
        "assetKey": "right_front",
        "url": "/static/hands/right_front.png"
      },
      "width": 1585,
      "height": 1983,
      "sortOrder": 1,
      "objects": []
    },
    {
      "viewKey": "left_back",
      "canvasType": "hand",
      "label": "Left Back",
      "handSide": "left",
      "background": {
        "assetKey": "left_back",
        "url": "/static/hands/left_back.png"
      },
      "width": 1585,
      "height": 1981,
      "sortOrder": 2,
      "objects": []
    },
    {
      "viewKey": "right_back",
      "canvasType": "hand",
      "label": "Right Back",
      "handSide": "right",
      "background": {
        "assetKey": "right_back",
        "url": "/static/hands/right_back.png"
      },
      "width": 1971,
      "height": 2010,
      "sortOrder": 3,
      "objects": []
    }
  ]
}
```

## Admin API (admin role required for **every** route, reads included; feature flag `ADMIN`)
Unauthenticated → 401, doctor/patient → 403, flag off → 404. Errors: `{"error", "code"?, "details"?}` (`details` only for 4xx).

| Area | Endpoints |
|---|---|
| Categories `/api/admin/categories` | `GET /` · `POST /` · `GET /:id` · `PUT /:id` · `POST /:id/activate` · `POST /:id/deactivate` |
| Conditions `/api/admin/conditions` | same six, plus `GET /:id/protocols` · `POST /:id/protocols {protocolId}` (attach; duplicate → 409) · `DELETE /:id/protocols/:protocolId` (detach) |
| Protocols `/api/admin/protocols` | `GET /?status&categoryId&q&limit&offset` · `POST /` · `GET /:id` · `PUT /:id` (metadata; slug changes only if `slug` is sent) · `POST /:id/status {status}` · `POST /:id/publish {note?}` · `POST /:id/archive` · `POST /:id/duplicate` |
| Versions | `GET /:id/versions` · `GET /:id/versions/:n` (full snapshot + integrity) · `POST /:id/versions/:n/restore` |
| Search terms | `GET /:id/search-terms` · `POST /:id/search-terms {term, kind?}` · `DELETE /:id/search-terms/:termId` |

Editing the draft's views/objects uses the existing builder endpoint `POST /api/protocols/:id/save` (open to admins), so there is one save path.
No delete endpoints exist for categories, conditions or published protocols.

Slugs: derived from the name ("Headache Relief Protocol" → `headache-relief-protocol`), lowercase, URL-safe, deterministic, with `-2`, `-3` … on collision.
An **explicit** slug that is invalid is 400, one already taken is 409 — never silently altered. Renaming never changes a slug.

## Restore (`POST /:id/versions/:n/restore`)
Copies an old snapshot **into the editable working copy** and records that as a **new checkpoint** (`restoredFromVersion = n`).
* The historical version row is never modified or deleted (verified byte-for-byte in the tests).
* Restores views/objects and (schema 2) name, display name, descriptions, metadata, category, conditions, search terms.
  Never restores slug, status or the published pointer. Categories/conditions that are gone or inactive are skipped with a `warnings` entry.
* A published protocol stays published and its public data does not move (restoring older content shows `hasUnpublishedChanges: true`).
  A protocol in review returns to draft. Archived protocols must be moved back to draft first (409). Old schema-1 versions restore views/markings only (with a warning).

## Duplicate (`POST /:id/duplicate`, also the legacy builder route)
A new protocol: new UUID, new slug (`…-copy`, `-copy-2` …), **draft**, **no published pointer**, version 1, no patient assignment;
deep-copied metadata, category, conditions and search terms (new term rows); new canvas ids; **every object gets a new id**; geometry and all
properties preserved exactly. The source (and its published version) is untouched.

## Existing builder/patient APIs
`/api/protocols/*` keeps its contracts. Changes: responses gain `slug`, `displayName`, `shortDescription`, `categoryId`, `metadata`, `publishedVersionId`,
`publishedAt`; saves record complete schema-2 checkpoints; creation/duplication also assign slugs; a status change follows the lifecycle rules above
(`published` only via publish; a published protocol can only be archived — 409 otherwise); a published protocol cannot be deleted (409).
Patient responses are byte-for-byte unchanged (no new fields).

## Tests
Run `npm test` at the project root (Node 20.6+). See `docs/FOUNDATION.md` for what the tests do and do not prove.
* Backend: **216 / 216** (68 existing + 148 new); Frontend: **105 / 105** (unchanged); **321 / 321** total.
* Existing assertions that hard-coded "schema version 3", or compared whole rows of tables that gained columns, were updated to
  compare the original columns / the latest version; no test was removed.
* Mutation-checked: 12 deliberate regressions of the new logic (public API serving archived protocols, no transaction, no validation,
  restore not recording a checkpoint, duplicate reusing ids, metadata leakage, slug regeneration, missing admin check …) are each caught.

## Known limitations
* Public list/search parses published snapshots in memory (fine for hundreds of protocols); add an index table when it grows. No typo tolerance.
* Changing a published protocol's slug (explicit admin action) breaks its old public URL; no redirects yet.
* The existing builder's status dropdown does not list `in_review`/`published`; the Studio UI replaces it.
* Legacy patient routes still require status `active` and are unchanged; publishing does not affect them.
* The frontend was not changed and no UI was built. Real-browser/real-device behaviour is unverified here (`docs/REAL_DEVICE_VALIDATION.md`).
