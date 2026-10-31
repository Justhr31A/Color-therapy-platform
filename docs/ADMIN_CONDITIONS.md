# Admin Conditions / Diseases Management

An admin-only page, `/admin/conditions`, for managing the conditions that protocols can be linked to — so real
conditions can be added one at a time later without any further database change.

## What already existed vs. what this phase added

The `conditions` and `condition_protocols` tables, and the full condition CRUD + activate/deactivate + protocol
attach/detach API, were **already built** (Foundation phase) and already used by Protocol Studio's "Protocol"
tab. This phase added:

1. **One new column**: `conditions.synonyms_json` (migration `006_condition_synonyms.js`) — see below.
2. **One new page**: `frontend/src/pages/admin/AdminConditionsPage.jsx` at `/admin/conditions` — nothing existed
   here before; there was an API but no admin screen to use it from.
3. **A nav link** to it from the doctor/admin dashboard, shown only to admins.

No new API route was added. No existing endpoint's behaviour changed except that `POST /api/admin/conditions`
and `PUT /api/admin/conditions/:id` now also accept a `synonyms` field.

## Data model

```
conditions                          condition_protocols (many-to-many)
  id, name, slug, description,        condition_id, protocol_id, created_at
  category_id, is_active,             PRIMARY KEY (condition_id, protocol_id)
  synonyms_json,                      ON DELETE CASCADE both ways
  created_at, updated_at
```

A protocol can have zero, one, or many conditions (via `condition_protocols`) — unchanged, and this phase did not
touch `protocols` or `protocol_versions` in any way.

### The "Display name" field

The task's mockup lists **Condition name** and **Display name** as two separate form fields. The schema — like
`categories`, which has the same shape — only has one `name` column; there was never a `display_name` for
conditions the way `protocols.display_name` exists. Rather than add a second field that would either duplicate
`name` or sit unused, the admin form has **one** field, labelled **"Name"**, with a hint that it is shown
publicly and used to generate the URL slug. If a genuine need for a distinct internal-vs-public name surfaces
later, that is a small, isolated migration (one more column, same pattern as `synonyms_json` below) — deferred
here rather than built speculatively.

### Search terms / synonyms

Protocols already have their own per-protocol search terms in a dedicated table, `protocol_search_terms`
(migration 004) — built for exact-match, weighted search scoring. A condition's synonyms are a much smaller
thing: a handful of alternate names an admin wants remembered against the condition itself. Migration 006 adds
one column, `synonyms_json` (a JSON array of strings, default `'[]'`), rather than a second table mirroring one
built for a different job. Existing rows are unaffected — every condition created before this migration simply
gains an empty synonym list.

Synonyms are validated in `catalogService.js` (`optionalSynonyms`): each entry trimmed, empties dropped,
case-insensitively deduplicated, capped at 80 characters each and 30 entries total. **Updating a condition's
synonyms REPLACES the list**, it does not merge into it — leaving `synonyms` out of an update request leaves the
existing list untouched.

## Archiving (status / lifecycle)

Conditions already had exactly the lifecycle this task needed: `is_active` (boolean), with
`POST /api/admin/conditions/:id/activate` and `.../deactivate`. **Archiving never deletes a condition or any of
its protocol links** — it only flips `is_active` to `0`. A condition already linked to protocols can be archived
and reactivated freely; `condition_protocols` rows are untouched either way (covered by a dedicated test: see
below). No schema change was needed for this — the "smallest compatible solution" the task asked for, for
archiving specifically, turned out to already exist.

## API (unchanged routes, all under `/api/admin/conditions`, admin-only)

| Method & path | Purpose |
| --- | --- |
| `GET /` | List, with `protocolCount` per condition and (optional) `?categoryId=` filter |
| `POST /` | Create — `{ name, description?, categoryId?, synonyms?, isActive? }` |
| `GET /:id` | One condition |
| `PUT /:id` | Update any of the same fields |
| `POST /:id/activate` / `.../deactivate` | Archive / restore, never deletes |
| `GET /:id/protocols` | Protocols currently linked to this condition |
| `POST /:id/protocols` `{ protocolId }` | Link (409 if already linked, 404 if the protocol doesn't exist) |
| `DELETE /:id/protocols/:protocolId` | Unlink |

All require an authenticated admin session (`requireAuth, requireRole('admin'), requireFlag('ADMIN')`) —
enforced server-side and covered by the existing generic admin-authorization test, which already runs anonymous/
doctor/patient callers against every one of these routes and asserts they're refused and nothing changes.

## Protocol Studio

Studio's "Protocol" tab already lists conditions from `GET /api/admin/conditions` and lets a doctor/admin attach
one, detach one, or create-and-attach a new one inline (`useProtocolMeta.js`, `ProtocolMetadataPanel.jsx`) — this
was already fully working and **was not changed**. A condition created on the new `/admin/conditions` page shows
up there automatically, with no code change needed, because both pages read the same endpoint.

## Public website

Nothing here changes what the public site shows. A condition only ever becomes publicly visible by being
attached to a protocol at the moment that protocol is **published** — the published snapshot freezes a copy of
each attached condition's name at that time (see `docs/PUBLIC_WEBSITE.md`). Archiving a condition, or editing its
name/synonyms afterward, does not retroactively change an already-published snapshot — the same way editing a
category or a protocol's own description after publishing doesn't. This is existing, unmodified behaviour.

## Admin workflow: adding a real condition

1. Open `/admin/conditions` (link in the dashboard header, admin accounts only).
2. **Add Condition** → fill in Name, Description, and any synonyms patients might search for → Create.
3. Open the protocol in Protocol Studio → Protocol tab → link the condition (or create it inline there instead —
   either page reaches the same data).
4. Publish the protocol. The condition now appears on the public protocol's details page and in search.
5. To retire a condition without breaking history, use **Archive** — its existing protocol links, and any
   already-published protocol data, are unaffected.

## Demo protocol safety

This phase did not touch `protocols`, `protocol_versions`, canvases, objects, or any publishing/versioning code
path — only `conditions` gained one new column, and no row in any table was rewritten by the migration. The
"Back Pain — Website Test Protocol" demo protocol (and any other existing protocol) is therefore structurally
unaffected regardless of its condition links. This project's sandbox has no copy of that live database to query
directly — this guarantee is by construction (no code that touches protocol data was changed), not by having
inspected that specific row.

## Tests

Backend (`backend/tests/publishing.http.test.js`): required-field validation, explicit-slug conflict (a
repeated **name** is allowed and gets its own auto-suffixed slug — only an explicit duplicate slug is refused,
the same rule categories already follow), synonyms create/replace-on-update/validation, a condition with no
synonyms reading back `[]` (never `null`), archiving-and-reactivating a linked condition preserving the protocol
link, and editing a condition's description/synonyms never disturbing its protocol links. Three pre-existing
tests that hard-coded "the newest migrations are 004 and 005" were updated to include 006 — a required, correct
update, not a weakened one (they now assert exactly what has always been true, with the new migration present).

Frontend (`frontend/tests/adminConditions.render.test.mjs`): pure-logic tests for `filterConditions`,
`parseSynonyms` and `toFormFromCondition`, and rendering tests for every page state (loading, error, empty vs.
no-search-results empty, populated table with status pill/protocol count/actions, active vs. archived rows,
the create form and the pre-filled edit form, a saving/error state, and confirmation the page has no
protocol-editing or publishing controls of any kind).
