# Architecture Notes

## Database schema

PostgreSQL (originally SQLite). The full, current DDL is the migration chain in `backend/src/db/postgres-migrations/`; the core tables are:

- **users** — doctors and patients in one table, distinguished by `role`.
  A patient row can exist with `password_hash = NULL` and `status =
  'pending'` — created automatically when a doctor assigns a protocol to an
  email that hasn't signed up yet. Real patient self-signup (Phase 2) just
  needs to let that person set a password on their existing row.
- **protocols** — the top-level record a doctor creates. Tracks
  `current_version`, `status`, and the `doctor_id`/`patient_id` relationship.
- **canvases** — the "live" editable canvases for a protocol. A hand
  protocol always has exactly 4 rows (one per view); an organ protocol has
  one row per organ/body diagram the doctor added. Each row stores a
  `background_asset_key` (never a raw file path — always looked up against
  the server-side asset registry) plus the reference `width`/`height` that
  every object's normalized coordinates are relative to.
- **objects** — every individual marking. One row per dot, ring, line, etc.
- **protocol_versions** — a full JSON snapshot taken on every save. This is
  what makes versioning real: the `canvases`/`objects` tables always hold
  the current working state, but nothing is ever overwritten in
  `protocol_versions` — each save just adds a new row with the next version
  number.

## Protocol object structure (the JSON shape the frontend actually uses)

```json
{
  "id": "uuid",
  "type": "ring",
  "x": 0.52,
  "y": 0.38,
  "width": 0.08,
  "height": 0.08,
  "rotation": 0,
  "color": "#e5484d",
  "thickness": 4,
  "opacity": 1,
  "points": null,
  "finger": "middle",
  "landmarkReference": null,
  "metadata": {},
  "zIndex": 1737400000000
}
```

- `points` is only populated for `freeline` objects — a structured array of
  `{x, y}` normalized points, never flattened into a raster image.
- `finger` and `landmarkReference` exist specifically for the future AR
  phase (see below) and are optional/nullable in Phase 1.
- `width`/`height` mean different things per type (diameter for dot/ring,
  length for hline/vline/arrow, bounding box for triangle/rectangle) — see
  `frontend/src/builder/objectDefaults.js` for the exact mapping.

## Normalized coordinates

Nothing is stored in screen pixels. Every `x`, `y`, `width`, `height` is a
fraction (0.0–1.0) of the canvas's **reference** dimensions — the real pixel
width/height of that view's background asset, stored once on the `canvases`
row/object (e.g. `left_front.png` is 1586×1982, so that canvas's reference
is `{width: 1586, height: 1982}`).

On screen, the Konva `Stage` is rendered at whatever size fits the doctor's
browser window, but it's given a uniform `scale = displayWidth /
referenceWidth`. Every shape inside it is positioned using
`normalizedX * referenceWidth`, `normalizedY * referenceHeight` — i.e. shapes
are placed and drawn in reference-pixel space, and Konva's own scale
transform handles shrinking/growing that to fit the screen. This means a
marking's stored position is identical whether it was placed on a laptop or
a phone, which is the whole point: the same protocol has to make sense on
whatever device eventually renders the AR overlay.

## Copy / paste / duplicate

Every object gets a new, independently-generated UUID the moment it's
created — by drawing, pasting, or duplicating. "Copy" (`copySelected` in
`frontend/src/builder/store.js`) stores a deep clone of the selected
object's data **without its id** in a `clipboard` slot. "Paste" takes that
clipboard data, generates a brand-new UUID, nudges the position slightly so
it doesn't sit exactly on top of the original, and inserts it as a new row
in the active canvas's object list. From that point on the two objects
share nothing — editing one only ever touches the array entry matching its
own id, so changing the pasted copy's colour can never mutate the original.
"Duplicate" is the same operation without the explicit copy step
(select → duplicate in one action). This mirrors backend behaviour too:
`POST /:id/duplicate` deep-clones every canvas and object row with fresh
UUIDs when an entire protocol is duplicated.

## Undo / redo

Snapshot-based, not diff-based (simpler and impossible to get subtly wrong).
Every mutating action — add, delete, a finished drag, a finished resize, a
committed property change, paste, duplicate — calls `_pushHistory()` first,
which clones the *current* `canvases` array onto a `past` stack, then
applies the change. `undo` pops the most recent snapshot off `past`, pushes
the current state onto `future`, and restores it; `redo` is the mirror
image. Live drag/resize feedback while the mouse is still down never touches
this stack — only the *end* of a gesture commits one history entry, so
dragging an object across the canvas is one undo step, not hundreds.

## How this connects to the future AR phase

Nothing in Phase 1 assumes a screen. The three things Phase 2's hand-tracking
system will need are already in place:

1. **Normalized coordinates** (above) — a landmark-tracking engine works in
   its own coordinate space (usually normalized to the detected hand's
   bounding box); mapping our 0–1 protocol coordinates onto that is a
   straightforward transform, not a redesign.
2. **`finger` and `landmarkReference` fields** on every object — currently
   only `finger` is set by the doctor (a simple dropdown); `landmarkReference`
   (e.g. `{start: 9, end: 10, relativeT: 0.35}`, referring to MediaPipe-style
   hand landmark indices) is left `null` deliberately. Phase 2 can populate
   it — either by having the doctor calibrate it explicitly, or by deriving
   it once from the fixed hand asset's known landmark positions — without
   changing the schema.
3. **`backgroundAssetKey` instead of a flattened image** — because every
   marking is a separate structured object rather than pixels burned into a
   picture, an AR renderer can redraw the same protocol data anchored to a
   live hand instead of a static picture.

Phase 1 deliberately does not implement any camera/MediaPipe/hand-tracking
code — see `backend/src/config/handAssets.js` and
`frontend/src/builder/objectDefaults.js` for where that future work will
plug in.
