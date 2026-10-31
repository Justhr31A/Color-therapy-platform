# Protocol Studio

The Studio is the authoring screen at `/builder/:id`. It replaced the old single-canvas builder.
**One protocol, four hand views on screen at once** (Left Front · Right Front · Left Back · Right Back), one shared toolbar,
one properties panel, one undo history, one Save.

> **Status of verification — read this first.**
> Everything below marked *tested* is covered by automated tests that run in Node (`npm test`, 524 tests).
> **Nothing here has been run in a real browser yet**: mouse dragging, resize handles, how Konva actually paints, and layout on real
> screen sizes are unverified. Section 9 is a checklist for that. Tests prove the logic, the data, the API and what each component
> asks Konva to draw; they do not prove what a person sees.

---

## 1. Scope

**In:** the 4-view workspace, 15 tools, size / thickness presets with custom scale, one colour palette, Dot + Ring, Finger Band,
Text, Eraser, full object operations (copy / paste / duplicate / delete / undo / redo), a properties panel, JSON import / export,
Preview, and a "Protocol" tab (name, description, category, conditions, search terms, status, publish, version history) wired to the
existing admin API.

**Out (unchanged, by design):** the public website, AI, payments, patient accounts, the patient camera / AR code, the four hand images,
the AR calibration files (`referenceHandPoints.js`, `similarityTransform.js`, `protocolMapper.js`, `drawProtocolOverlay.js`,
`handChirality.js`, `handedness.js`, `videoCover.js`), and the database schema. **No migration was added** — everything the Studio stores
fits the existing object columns and `metadata_json`. Migrations 001–005 are as before.

## 2. Using it

| Area | What it does |
| --- | --- |
| Top bar | protocol name, version, status, **Import JSON / Export JSON / Duplicate protocol / Preview / Save Protocol** |
| Left | the 15 tools: Select, Dot, Ring, Dot + Ring, Finger Band, H Line, V Line, Free Line, Inverted Triangle, Triangle, Rectangle, Square, Arrow, Text, Eraser |
| Centre | the four views (2×2). Click a view to work on it; **Enlarge** shows one view big, **Show all four** returns |
| Right | **Properties** tab (the selected object, on whichever view it is) and **Protocol** tab (details / publishing / versions) |
| Bottom | Undo, Redo, Copy, Paste, Duplicate, Delete, and a **Grid** switch (a view aid only — never saved) |

Keyboard: `Ctrl/Cmd+Z` undo · `Ctrl/Cmd+Y` or `Ctrl/Cmd+Shift+Z` redo · `Ctrl/Cmd+C/V/D` copy / paste / duplicate · `Delete` delete · `Esc` back to Select.
Shortcuts are ignored while typing in a field.

Clicking a view makes it the active view **and keeps the current tool**; an object is added to the view that was clicked. Paste goes onto the
active view. Selecting an object on any view brings its view forward and shows a label in the panel naming the view.
Save sends **all four views in one request**. The browser asks before closing the tab with unsaved changes.

**Eraser:** click an object to delete it (one undo step). It does not drag-erase. It never creates objects.
**Preview:** the same four views, read-only — no tools, no selection, nothing draggable.

## 3. Data model

All positions and sizes are **normalized (0–1) against the view's reference image**, as before. Object types are now 12: the original 10
plus `fingerBand` and `text` (appended; order of the originals unchanged). Every Studio-specific value lives in `metadata`, so old objects
and old code are unaffected. The Studio never rewrites an old object just by opening it.

### 3.1 Size and thickness

**Size** is exactly four choices — **Small / Medium / Large / Extra Large** (`sizePreset`: `small` · `medium` · `large` · `xl`):

| Size | small | medium | large | **xl (Extra Large)** |
| --- | --- | --- | --- | --- |
| dot / text (width) | 0.02 | 0.03 | 0.045 | 0.065 |
| ring (legacy single ring) | 0.05 | 0.08 | 0.12 | 0.17 |
| h/v line, arrow | 0.10 | 0.18 | 0.28 | 0.40 |
| triangle (either) | 0.08 | 0.12 | 0.18 | 0.26 |
| rectangle (w × h) | 0.10 × 0.06 | 0.16 × 0.10 | 0.24 × 0.15 | 0.34 × 0.22 |
| square | 0.07 | 0.10 | 0.15 | 0.22 |
| finger band (width) | 0.10 | 0.13 | 0.16 | 0.20 |

An unknown size (e.g. `xxl`) is rejected by the importer and by the server's publish validation. A custom scale multiplies the preset:
range **0.25 – 3.00**. Real geometry is `base × scale`; `metadata` records `sizePreset` and `scale`.
**Medium equals the default the builder always produced**, so nothing about default sizes changed. If an object's real width is changed
directly (dragging a resize handle) the recorded `scale` is **re-derived from the real geometry**, so the panel can never disagree with
what is drawn. Objects saved before the Studio read as *Medium* at a derived scale (e.g. a legacy 3 px line reads as Medium thickness at 75%).

### 3.1b Thickness — a free number, no maximum

**Size and thickness are separate.** Thickness is *not* a preset: it is the plain `thickness` column, a **finite number above 0 in reference
pixels, with no maximum** — a stroke thick enough to cover most or all of a hand is legitimate. The Studio shows it as a number field with −/+
steppers (`panels/ThicknessInput.jsx`); the importer (`importExport.js`) and the server (`protocol/validation.js`) accept any finite value
and reject only what is unusable (negative, non-numeric, NaN, Infinity). `0` stays valid for objects that have no stroke (a dot).
The older `metadata.thicknessPreset` / `thicknessScale` are only *read* from objects saved by earlier versions; setting a free thickness
removes them (a stale scale would be wrong, and the server caps scales at 10).

### 3.1c Outline — one structure for every shape

Any shape (dot, ring, h/v line, free line, triangle, inverted triangle, rectangle, square, arrow, finger band, and every ring of a dot —
not text) can carry an outline, independent of its fill:

```json
{ "metadata": { "outline": { "enabled": true, "color": "#000000", "thickness": 8 } } }
```

`enabled`, `color` and `thickness` are independent (thickness has no maximum). **An object saved without one has the outline OFF and renders
exactly as before** (guaranteed by a golden-file test against the previous renderer). The outline is drawn as an *underlay* — the same
geometry stroked `2 × outline.thickness` wider, in the outline colour, beneath the object — so the visible band is exactly the outline
thickness on every side. One shared function (`viewer/renderMarkings.js`) works this out for the public page, the PDF and the Studio
(`builder/shapes/OutlineUnderlay.jsx` converts the same primitives to Konva); there is no per-shape outline code. When an outline is on, the
white contrast halo normally drawn around a dot or finger band is dropped.

### 3.2 Colour

One list, `frontend/src/builder/config/palette.js`: 14 named colours (Red, Orange, Amber, Yellow, Green, Teal, Cyan, Blue, Indigo, Violet,
Magenta, Brown, Black, White) plus a custom picker. A test fails if any component re-declares a swatch list. The 8 most recently used
colours are remembered in the browser (`localStorage`, key `ctpp_recent_colors`) as a convenience only — it is not protocol data.

### 3.3 Dot + attached rings — one object, any number of rings, ZERO gap

A Dot + Rings is **one object of type `dot`** whose `metadata.rings` is an **array**, innermost ring first. There is **no maximum number of
rings** and **no gap setting of any kind**: every ring is attached to what is inside it.

```
dot  →  rings[0] (touches the dot)  →  rings[1] (touches rings[0])  →  rings[2] …
```

```json
{ "type": "dot", "x": 0.4, "y": 0.5, "width": 0.03, "color": "#e5484d",
  "metadata": { "sizePreset": "medium", "scale": 1,
    "outline": { "enabled": true, "color": "#ffffff", "thickness": 3 },
    "rings": [
      { "color": "#1a73e8", "thickness": 14, "outline": { "enabled": false, "color": "#000000", "thickness": 4 } },
      { "color": "#f5d90a", "thickness": 26, "outline": { "enabled": true,  "color": "#000000", "thickness": 4 } } ] } }
```

A ring stores only `{ color, thickness, outline }` — its position is **never stored**, always calculated
(`objectModel.compositeRingLayers`): `inner radius = previous layer's outer radius`, `outer radius = inner + thickness`, starting from the dot's
radius. That is the zero-gap guarantee, and tests check it in the model, as drawn by the Studio, in the public SVG, and in the PDF's own
content stream. Studio: select a dot → **+ Add Ring** (as many times as you like); each ring has its own colour, thickness (free number) and
outline, plus Remove. Drawing order: outermost ring first, then inward, the dot on top; each layer's outline is drawn around its outside edge,
over whatever it touches (so a very thick outline can cover a thin neighbouring ring — that is by design, and it never opens a gap).
Resizing the group on the canvas scales the dot and every ring/outline thickness by the same factor. Only a `dot` may carry rings (server-enforced).

**Older objects.** The earlier single spaced ring (`metadata.ring`, with a gap) is still read and **still rendered exactly as before** — nothing
rewrites it just by opening it. The panel shows it as "Ring (older format)" with **Convert to attached rings** (its colour and thickness become
ring 1; its old gap is dropped); **+ Add Ring** and editing a ring convert it first. Published snapshots are never modified.

### 3.4 Finger Band

```json
{ "type": "fingerBand", "finger": "ring", "x": 0.73, "y": 0.36, "width": 0.14, "rotation": 0.2, "thickness": 6,
  "landmarkReference": null,
  "metadata": { "band": { "type": "double", "position": 0.35, "rotationOffset": 5 } } }
```

`finger` ∈ thumb / index / middle / ring / **little** (the legacy name `pinky` is still read and shown as `little`; new data is always `little`).
`position` runs from the knuckle (0) to the fingertip (1). `type` is `plain` or `double`. `rotation` is "across the finger" in **pixel** space
(the images are not square) plus `rotationOffset`. A band is placed on the nearest finger to the click, is **held on the finger's axis while
dragging**, and a copy pasted onto another view lands on **that view's** same finger. It is only offered on hand protocols.
`landmarkReference` is **reserved and always `null`** — nothing maps a band to AR landmarks in this phase.

### 3.5 Text

`type: "text"`, content in `metadata.text` (1–200 characters, required at publish), size from the size presets (`width` is the font size as
a fraction of canvas width). Text is drawn and displayed as plain text; markup in it is shown verbatim and never interpreted.

## 4. Finger guides — approximate, Studio-only

`frontend/src/builder/config/fingerGuides.js` holds, per view and finger, a base point, a tip point and a width. They were **measured by
segmenting the four real hand images** and checked by drawing them over the images. They are used only to place and constrain Finger Bands.

* They are **approximate** (good for placing a band on the right finger and across it; not anatomical ground truth).
* They are **not** the AR calibration points. `referenceHandPoints.js` has a different purpose and was not touched.
* **If a hand image is replaced, the guides must be re-measured**, or bands will land in the wrong place. The Studio logs a console error if an
  image's size differs from the configured canvas size.

## 5. Saving, publishing, versions

* **Studio edits are draft only.** Markings save through the existing `POST /api/protocols/:id/save` (doctor or admin); protocol details use
  the existing `/api/admin/protocols/*`, `/api/admin/categories`, `/api/admin/conditions` endpoints. **No API was added or changed.**
  (`api/client.js` now also attaches `status`, `code` and `details` to thrown errors — additive; `.message` is unchanged.)
* **Save Protocol** saves the marking changes and any edited details together; each is a checkpoint version.
* **Publish** (admin) first offers to save pending edits, then calls the existing publish endpoint, which validates and freezes an **immutable
  version**. Problems are shown as a list. After publishing, further edits stay in the draft and the panel shows **unpublished changes**.
* **Restore** copies an older version into the draft (confirm first if there are unsaved edits); the old version itself never changes.
* **Duplicate protocol** creates a new draft with new ids for the protocol, views and every object, and no shared nested data.
* **Roles:** doctors can draw and save. The Protocol tab (details, publishing, versions) is **admin only**, matching the server. The old status
  dropdown and patient-assign box remain under *Legacy options*.

The server validates the new structures at publish (codes `SIZE_PRESET_INVALID`, `THICKNESS_PRESET_INVALID`, `SCALE_INVALID`, `RING_INVALID`,
`COLOR_INVALID`, `FINGER_REQUIRED`, `BAND_INVALID`, `TEXT_REQUIRED`, `TEXT_TOO_LONG`).

## 6. JSON import / export

Export downloads `<slug>.protocol.json`:

```json
{ "format": "colour-therapy-protocol", "version": 1, "exportedAt": "…",
  "protocol": { "name": "…", "protocolType": "hand" },
  "views": [ { "viewKey": "left_front", "width": 1586, "height": 1982, "objects": [ … ] }, … ] }
```

Import treats the file as **untrusted**: field-by-field validation (types, ranges, colours, presets, ring / band / text structure, finger names),
unknown fields dropped, at most 500 objects per view, files over 2 MB refused. **Every imported object gets a new id.** Only the views present
in the file are replaced. It is **all or nothing** — a single bad object rejects the whole file with a readable list of problems and changes
nothing. A successful import is **one undo step** and still needs **Save Protocol**. It never publishes and never touches published versions.

## 7. Where things are

```
frontend/src/builder/
  ProtocolStudio.jsx      orchestrator (load, save, publish, restore, duplicate, import/export, shortcuts)
  store.js                Zustand store — 4 canvases, one history, actions take an optional canvas id
  HandWorkspace.jsx       2x2 layout        HandCanvas.jsx  one Konva stage per view
  ToolPalette.jsx  PropertiesPanel.jsx  ProtocolMetadataPanel.jsx  StudioTopBar.jsx  StudioBottomBar.jsx  PreviewMode.jsx
  useProtocolMeta.js      hook over the admin endpoints
  model/  objectModel.js (all object logic)  fingerGeometry.js  importExport.js
  config/ palette.js  sizePresets.js  fingerGuides.js
  shapes/ DotRingShape.jsx  FingerBandShape.jsx  TextShape.jsx  (+ the 5 original shape files)
  panels/ ColorPalette  PresetScaleControl  SizeControl  ThicknessControl  CommittedRange
backend/src/protocol/  vocabulary.js (12 types)  validation.js (validateStudioData)
```

## 8. Tests

`npm test` at the project root: **backend 237 · frontend 287**. New this phase: 21 backend + 182 frontend.

| File | What it proves |
| --- | --- |
| `backend/tests/studio.data.test.js` | four views in one protocol; Dot + Ring / band / presets / text survive save→load in a real PostgreSQL database and over real HTTP; publish validation of every new field; published version immutable; restore; duplicate independence; role limits |
| `studioModel.test.mjs` | presets (four sizes incl. Extra Large, Medium = old defaults), scale, free thickness, outline, attached rings (zero gap), the legacy single ring, finger geometry (perpendicular in pixel space for all 20 finger/view pairs), text, copy placement |
| `studioStore.test.mjs` | four views, view association, one-object Dot + Ring, deep-independent copy / duplicate, undo/redo across views, eraser, one-request save, import/export |
| `studioImportExport.test.mjs` | validation of every rule + a 3,000-iteration deterministic fuzz with hostile input |
| `studioBackend.e2e.test.mjs` | the **real store's save()** through the **real backend service and database**, reload, publish, immutability |
| `studioPanels.render.test.mjs` | the real panels rendered to HTML (controls per object type, XSS-safe text, admin vs doctor) |
| `studioCanvas.render.test.mjs` | the real shapes / canvas / workspace rendered against a recording Konva stand-in, and their drag / resize handlers called with fake events |

**Mutation check:** 17 deliberate breakages of the real code (lost deep clone, shallow duplicate, unsynced scale, ring left behind on resize, wrong
view on click, saving one view, accepting XL in the importer and in server validation, keeping file ids, normalized-space band angle, Dot + Ring drawn
as a dot, missing ring section, one-view workspace, XL in config, band not held on finger, server dropping new types) — **all 17 were caught.**

**Limits of the tests:** they use a Konva *stand-in*, so they prove what is asked of Konva, not how it paints. No test clicks or drags.

## 9. Browser QA — to be run by a person (not yet done)

Run with `npm run dev` in both packages, logged in as admin, on a hand protocol. Tick each; note the browser and screen size.

**Layout**
- [ ] All four views visible at once, correctly labelled, images not stretched; usable at your normal window size and when narrowed
- [ ] **Enlarge** / **Show all four** work; clicking a view highlights it

**Placing and editing**
- [ ] Each of the 13 placing tools (all except Select and Eraser) places the right shape on the view you click (also on the *non-active* views)
- [ ] Drag to move; resize / rotate handles behave sensibly for each type; a circle shows no rotate handle
- [ ] Free line draws while dragging; Eraser deletes on click and never adds

**Dot + Ring**
- [ ] Dot + Ring appears as ring around dot; dragging moves both; resizing scales both; ring colour / size / thickness change only the ring
- [ ] Toggling the ring off / on works; copy, paste, duplicate, delete, undo behave as one object

**Finger Band** *(most important to eyeball — guides are approximate)*
- [ ] On **each of the four views**, place a band on **each finger**: it sits on the finger and is roughly across it
- [ ] Dragging keeps it on the finger; changing finger, position, plain / double, angle, "Fit width to finger" all work
- [ ] Paste a band onto a different view: it lands on the same finger of that hand

**Properties, presets, palette**
- [ ] Small / Medium / Large / Extra Large change the visible size; custom scale slider and − / + work
- [ ] Thickness accepts a very large number (e.g. 5000) and the stroke really gets that thick; − / + still work
- [ ] Outline: switch on for a line, a shape, a dot and a ring — colour and thickness change independently; while dragging, the outline steps aside and comes back on drop
- [ ] Select a dot → **+ Add Ring** several times: rings touch each other and the dot with no gap; each ring's colour / thickness / outline edits only that ring; Remove works
- [ ] Open an older Dot + Ring: it looks unchanged and offers **Convert to attached rings**
- [ ] Thickness presets / scale work; palette shows 14 colours + custom picker; recent colours appear

**Text**
- [ ] Add text, edit content, change size / colour / rotation; long text; a line break; text like `<b>x</b>` shows literally

**Save / reload / publish**
- [ ] Save, reload the page: everything on all four views is back exactly; closing the tab with unsaved changes warns
- [ ] Export JSON, import it into another protocol: objects appear (new ids), one Undo removes them; a hand-edited broken file is refused with a list
- [ ] Preview shows all four views read-only
- [ ] Protocol tab: edit details, add search term / condition, Save; Publish; edit a marking → "unpublished changes"; the public page still shows the published version; Restore an old version
- [ ] As a **doctor** account: can draw and save; Protocol tab explains it is admin-managed

## 10. Known limitations and follow-up

1. ~~AR does not show the new types.~~ **Superseded:** the camera now draws every Studio type — dots (with single or multiple rings and outlines), rings, finger bands, lines, arrows, free lines, triangles, rectangles, squares and text — in the protocol's own layer order. See `docs/CAMERA_AR.md` for what stays approximate.
2. **Finger guides are approximate** (section 4) and bands have no AR landmark mapping (`landmarkReference` is `null`).
3. **Browser behaviour is untested** (section 9). Konva painting, drag feel and responsive layout are the main residual risk.
4. Eraser is click-to-delete only. The grid is a view aid and is not saved.
5. Undo covers markings only. Protocol details are saved by the server on demand and are not part of the undo history; loading or restoring resets the history.
6. Publishing, versions and details are admin-only (the API is admin-only); doctors can author and save but not publish.
7. Importing replaces only the views present in the file, and never imports protocol details.
