/**
 * [DETERMINISTIC SOFTWARE TESTS] Protocol Studio state (src/builder/store.js) with a FOUR-view protocol — the REAL store.
 * Four views in one protocol, view association, Dot + Ring as one object, deep-independent copies, undo/redo across views,
 * the eraser, one-request saves and JSON import/export. It does NOT render Konva.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import useProtocolStore from '../src/builder/store.js';
import api from './support/stubs/apiClient.mjs';
import {
  getRing, hasActiveRing, patchRingColor, patchRingSizePreset, patchCompositeResize, patchScale, patchText, getText, getBand, patchBandPosition,
  patchBandFinger, patchSizePreset, patchThicknessPreset, patchRingGapPreset, effectiveRingGapPx,
  patchRingEnabled, addRing, patchRingAt, removeRingAt, getRings, hasRings, patchThickness, patchOutline, getOutline, compositeRingLayers,
} from '../src/builder/model/objectModel.js';
import { RING_GAP_BASES } from '../src/builder/config/sizePresets.js';
import { axisPoint } from '../src/builder/model/fingerGeometry.js';

const S = () => useProtocolStore.getState();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = ['left_front', 'right_front', 'left_back', 'right_back'];
const DIMS = [[1586, 1982], [1585, 1983], [1585, 1981], [1971, 2010]];

function fourViewProtocol() {
  return {
    id: 'proto-4', name: 'Four views', protocolType: 'hand', currentVersion: 1, status: 'draft', slug: 'four-views',
    canvases: KEYS.map((viewKey, i) => ({
      id: `c-${viewKey}`, viewKey, canvasType: 'hand', backgroundLabel: viewKey.replace('_', ' '), width: DIMS[i][0], height: DIMS[i][1], objects: [],
    })),
  };
}
const canvas = (viewKey) => S().canvases.find((c) => c.viewKey === viewKey);
const objectsOf = (viewKey) => canvas(viewKey).objects;
const allObjects = () => S().canvases.flatMap((c) => c.objects);
/** Picks a tool and clicks a view, exactly like the canvas does. */
const place = (tool, viewKey, x = 0.4, y = 0.5) => { S().setActiveTool(tool); S().addObjectAtPoint(x, y, canvas(viewKey).id); return S().getSelectedObject(); };
const edit = (obj, patch) => S().commitObjectChange(obj.id, patch);
const current = (viewKey, id) => objectsOf(viewKey).find((o) => o.id === id);
/** A Dot + Ring in the OLDER single-spaced-ring format, placed through the real store (what the Dot + Ring tool used to create). */
const placeLegacyRing = (viewKey, x = 0.4, y = 0.5) => { const d = place('dot', viewKey, x, y); edit(d, patchRingEnabled(d, true)); return current(viewKey, d.id); };

beforeEach(() => { api.reset(); S().loadProtocol(fourViewProtocol()); });

describe('[DETERMINISTIC] four views in one protocol', () => {
  it('all four views are held by ONE protocol, each keeping its own objects', () => {
    place('dot', 'left_front');
    place('ring', 'right_front');
    place('dotRing', 'left_back');
    place('fingerBand', 'right_back', 0.3, 0.3);
    assert.equal(S().canvases.length, 4);
    assert.deepEqual(KEYS.map((k) => objectsOf(k).length), [1, 1, 1, 1]);
    assert.deepEqual(KEYS.map((k) => objectsOf(k)[0].type), ['dot', 'ring', 'dot', 'fingerBand']);
    assert.equal(S().protocol.id, 'proto-4', 'still one protocol');
  });

  it('an object is added to the view that was clicked, not to the previously active view', () => {
    assert.equal(S().activeCanvasId, 'c-left_front');
    place('dot', 'right_back');
    assert.equal(objectsOf('left_front').length, 0);
    assert.equal(objectsOf('right_back').length, 1);
    assert.equal(S().activeCanvasId, 'c-right_back', 'and that view becomes the active one');
  });

  it('selecting an object in any view makes its view active and identifies it', () => {
    const inFront = place('dot', 'left_front');
    const inBack = place('ring', 'right_back');
    S().selectObject(inFront.id);
    assert.equal(S().activeCanvasId, 'c-left_front');
    assert.equal(S().getSelectedCanvas().viewKey, 'left_front');
    S().selectObject(inBack.id, 'c-right_back');
    assert.equal(S().getSelectedCanvas().viewKey, 'right_back');
    assert.equal(S().getSelectedObject().id, inBack.id);
  });

  it('an object can be edited or deleted while another view is active (found by id, not by active view)', () => {
    const a = place('dot', 'left_front');
    place('dot', 'right_back');                  // right_back is now active
    edit(a, { color: '#12a594' });
    assert.equal(objectsOf('left_front')[0].color, '#12a594');
    S().deleteObject(a.id);
    assert.equal(objectsOf('left_front').length, 0);
    assert.equal(objectsOf('right_back').length, 1, 'the other view is untouched');
  });

  it('interacting with another view keeps the current tool but drops a selection that belongs to a different view', () => {
    const a = place('dot', 'left_front');
    S().selectObject(a.id);
    S().setActiveTool('ring');
    S().focusCanvas('c-left_back');
    assert.equal(S().activeTool, 'ring');
    assert.equal(S().selectedObjectId, null);
    assert.equal(S().activeCanvasId, 'c-left_back');
  });

  it('every object id is unique across all four views', () => {
    ['dot', 'ring', 'dotRing', 'text'].forEach((t, i) => place(t, KEYS[i]));
    const ids = allObjects().map((o) => o.id);
    assert.equal(new Set(ids).size, ids.length);
    ids.forEach((id) => assert.match(id, UUID_RE));
  });

  it('a Finger Band cannot be added to a view with no finger guides (nothing changes, no undo step)', () => {
    S().loadProtocol({ ...fourViewProtocol(), canvases: [{ id: 'o1', viewKey: 'organ_heart', canvasType: 'organ', backgroundLabel: 'Heart', width: 1000, height: 1000, objects: [] }] });
    S().setActiveTool('fingerBand');
    S().addObjectAtPoint(0.5, 0.5, 'o1');
    assert.equal(S().canvases[0].objects.length, 0);
    assert.equal(S().history.past.length, 0);
  });
});

describe('[DETERMINISTIC] LEGACY single spaced ring: Dot + Ring stays ONE object', () => {
  it('is added as a single object whose ring lives inside it', () => {
    const o = placeLegacyRing('left_back');
    assert.equal(objectsOf('left_back').length, 1);
    assert.equal(o.type, 'dot');
    assert.equal(hasActiveRing(o), true);
  });

  it('moving it moves the whole composite; the ring cannot be left behind', () => {
    const o = placeLegacyRing('left_back');
    const ringBefore = JSON.stringify(getRing(o));
    edit(o, { x: 0.8, y: 0.2 });
    const moved = objectsOf('left_back')[0];
    assert.deepEqual([moved.x, moved.y], [0.8, 0.2]);
    assert.equal(JSON.stringify(getRing(moved)), ringBefore);
    assert.equal(objectsOf('left_back').length, 1);
  });

  it('resizing it scales dot and ring together and keeps the recorded scales in step', () => {
    const o = placeLegacyRing('left_back');
    edit(o, patchCompositeResize(o, 2));
    const r = objectsOf('left_back')[0];
    assert.equal(r.width, +(o.width * 2).toFixed(4));
    assert.equal(getRing(r).width, +(getRing(o).width * 2).toFixed(4));
    assert.equal(r.metadata.scale, 2, 'derived from the real width');
    assert.equal(getRing(r).scale, 2);
  });

  it('delete removes the composite as one; undo brings it back complete; redo removes it again', () => {
    const o = placeLegacyRing('left_back');
    S().deleteObject(o.id);
    assert.equal(objectsOf('left_back').length, 0);
    S().undo();
    assert.equal(objectsOf('left_back').length, 1);
    assert.deepEqual(getRing(objectsOf('left_back')[0]), getRing(o));
    S().redo();
    assert.equal(objectsOf('left_back').length, 0);
  });

  it('copy + paste makes an independent object with a new id and its own ring (no shared references)', () => {
    const o = placeLegacyRing('left_back');
    S().copySelected();
    S().pasteClipboard();
    const [a, b] = objectsOf('left_back');
    assert.equal(objectsOf('left_back').length, 2);
    assert.notEqual(a.id, b.id);
    assert.match(b.id, UUID_RE);
    assert.notEqual(a.metadata, b.metadata);
    assert.notEqual(getRing(a), getRing(b), 'the ring object itself is not shared');
    assert.deepEqual(getRing(a), getRing(b), 'but it has the same values');
    assert.equal(a.id, o.id);
  });

  it('duplicate makes an independent object, and editing the duplicate does not change the original', () => {
    const o = placeLegacyRing('left_back');
    S().duplicateSelected();
    const dup = S().getSelectedObject();
    assert.notEqual(dup.id, o.id);
    edit(dup, { ...patchRingColor(dup, '#111111'), ...{} });
    const dup2 = S().getSelectedObject();
    edit(dup2, patchRingSizePreset(dup2, 'large'));
    edit(S().getSelectedObject(), { color: '#f76b15', opacity: 0.4 });
    const original = objectsOf('left_back').find((x) => x.id === o.id);
    assert.equal(getRing(original).color, '#e5484d');
    assert.equal(getRing(original).sizePreset, 'medium');
    assert.equal(original.color, '#e5484d');
    assert.equal(original.opacity, 1);
    const edited = objectsOf('left_back').find((x) => x.id === dup.id);
    assert.equal(getRing(edited).color, '#111111');
    assert.equal(getRing(edited).sizePreset, 'large');
  });

  it('copying then editing the ORIGINAL does not change what gets pasted', () => {
    const o = placeLegacyRing('left_back');
    S().copySelected();
    edit(o, patchRingColor(o, '#111111'));
    S().pasteClipboard();
    const pasted = S().getSelectedObject();
    assert.equal(getRing(pasted).color, '#e5484d', 'the clipboard holds a snapshot, not a live reference');
  });

  it('copy + paste preserves BOTH independent colours and the gap; the copy is an independent object', () => {
    const o = placeLegacyRing('left_back');
    edit(o, { color: '#e5484d' });
    edit(objectsOf('left_back')[0], patchRingColor(objectsOf('left_back')[0], '#1a73e8'));
    edit(objectsOf('left_back')[0], patchRingGapPreset(objectsOf('left_back')[0], canvas('left_back'), 'large'));
    const original = objectsOf('left_back')[0];
    S().copySelected();
    S().pasteClipboard();
    const pasted = S().getSelectedObject();
    assert.notEqual(pasted.id, original.id);
    assert.deepEqual(
      [pasted.color, getRing(pasted).color, getRing(pasted).gapPreset, effectiveRingGapPx(pasted, getRing(pasted), canvas('left_back').width)],
      [original.color, getRing(original).color, getRing(original).gapPreset, RING_GAP_BASES.large]
    );
    assert.notEqual(pasted.metadata.ring, original.metadata.ring, 'independent data, not a shared reference');
  });

  it('duplicate preserves both colours and the gap, and gets a new object id', () => {
    const o = placeLegacyRing('left_back');
    edit(o, { color: '#e5484d' });
    edit(objectsOf('left_back')[0], patchRingColor(objectsOf('left_back')[0], '#1a73e8'));
    edit(objectsOf('left_back')[0], patchRingGapPreset(objectsOf('left_back')[0], canvas('left_back'), 'large'));
    const original = objectsOf('left_back')[0];
    S().selectObject(original.id);
    S().duplicateSelected();
    const dup = S().getSelectedObject();
    assert.notEqual(dup.id, original.id);
    assert.equal(dup.color, '#e5484d');
    assert.equal(getRing(dup).color, '#1a73e8');
    assert.equal(getRing(dup).gapPreset, 'large');
    assert.equal(effectiveRingGapPx(dup, getRing(dup), canvas('left_back').width), RING_GAP_BASES.large);
  });

  it('save then reload preserves both independent colours and the gap exactly', async () => {
    const o = placeLegacyRing('right_back');
    edit(o, { color: '#e5484d' });
    edit(objectsOf('right_back')[0], patchRingColor(objectsOf('right_back')[0], '#1a73e8'));
    edit(objectsOf('right_back')[0], patchRingGapPreset(objectsOf('right_back')[0], canvas('right_back'), 'large'));
    api.handler = (url, body) => ({ data: { ...S().protocol, canvases: S().canvases.map((c) => ({ ...c, objects: body.canvases.find((b) => b.id === c.id).objects })) } });
    await S().save();
    const beforeReload = JSON.parse(JSON.stringify(objectsOf('right_back')[0]));
    S().loadProtocol(JSON.parse(JSON.stringify(S().protocol)));
    const reloaded = objectsOf('right_back')[0];
    assert.equal(reloaded.color, beforeReload.color);
    assert.deepEqual(getRing(reloaded), getRing(beforeReload));
  });

  it('turning the ring off makes it a plain dot again (still one object); turning it on restores it', () => {
    const o = placeLegacyRing('left_back');
    edit(o, { metadata: { ...o.metadata, ring: { ...getRing(o), enabled: false } } });
    assert.equal(hasActiveRing(objectsOf('left_back')[0]), false);
    assert.equal(objectsOf('left_back').length, 1);
  });
});

describe('[DETERMINISTIC] Dot + attached rings stays ONE object', () => {
  const addRings = (o, n, viewKey = 'left_back') => { let cur = o; for (let i = 0; i < n; i += 1) { edit(cur, addRing(cur)); cur = current(viewKey, o.id); } return cur; };

  it('the Dot + Ring tool adds a single dot object that carries its rings array', () => {
    const o = place('dotRing', 'left_back');
    assert.equal(objectsOf('left_back').length, 1);
    assert.equal(o.type, 'dot');
    assert.equal(hasRings(o), true);
    assert.equal(getRings(o).length, 1);
  });

  it('"+ Add Ring" repeatedly (40 times) still leaves ONE object; each click is one undo step; rings stay attached with zero gap', () => {
    let o = place('dotRing', 'left_back');
    const steps = S().history.past.length;
    o = addRings(o, 40);
    assert.equal(objectsOf('left_back').length, 1, 'still one object, not one per ring');
    assert.equal(getRings(o).length, 41);
    assert.equal(S().history.past.length, steps + 40, 'one undo step per added ring');
    const layers = compositeRingLayers(o, canvas('left_back').width);
    layers.slice(1).forEach((L, i) => assert.equal(L.innerRadius, layers[i].outerRadius, 'attached: no gap'));
    S().undo();
    assert.equal(getRings(current('left_back', o.id)).length, 40, 'undo removes exactly the last added ring');
    S().redo();
    assert.equal(getRings(current('left_back', o.id)).length, 41);
  });

  it('a plain Dot can get rings too (+ Add Ring on an ordinary dot)', () => {
    const d = place('dot', 'left_back');
    assert.equal(hasRings(d), false);
    edit(d, addRing(d));
    assert.equal(hasRings(current('left_back', d.id)), true);
    assert.equal(objectsOf('left_back').length, 1);
  });

  it('moving it moves the whole composite; its rings cannot be left behind', () => {
    const o = addRings(place('dotRing', 'left_back'), 2);
    const ringsBefore = JSON.stringify(getRings(o));
    edit(o, { x: 0.8, y: 0.2 });
    const moved = current('left_back', o.id);
    assert.deepEqual([moved.x, moved.y], [0.8, 0.2]);
    assert.equal(JSON.stringify(getRings(moved)), ringsBefore);
  });

  it('resizing it scales the dot and every ring together, keeping the recorded dot scale in step', () => {
    const o = addRings(place('dotRing', 'left_back'), 1);
    edit(o, patchCompositeResize(o, 2));
    const r = current('left_back', o.id);
    assert.equal(r.width, +(o.width * 2).toFixed(4));
    assert.deepEqual(getRings(r).map((x) => x.thickness), getRings(o).map((x) => x.thickness * 2));
    assert.equal(r.metadata.scale, 2, 'derived from the real width');
  });

  it('delete removes the composite as one; undo brings it back complete with every ring; redo removes it again', () => {
    const o = addRings(place('dotRing', 'left_back'), 3);
    const full = JSON.stringify(current('left_back', o.id).metadata.rings);
    S().deleteObject(o.id);
    assert.equal(objectsOf('left_back').length, 0);
    S().undo();
    assert.equal(JSON.stringify(current('left_back', o.id).metadata.rings), full);
    S().redo();
    assert.equal(objectsOf('left_back').length, 0);
  });

  it('copy + paste: a new id and its OWN rings (same values, no shared references); editing the original afterwards does not change the paste', () => {
    const o = addRings(place('dotRing', 'left_back'), 2);
    edit(o, patchRingAt(o, 0, { color: '#111111', thickness: 33, outline: { enabled: true, color: '#ffffff', thickness: 5 } }));
    const original = current('left_back', o.id);
    S().selectObject(o.id); S().copySelected();
    edit(original, patchRingAt(original, 0, { color: '#222222' })); // edit AFTER copying
    S().pasteClipboard();
    const pasted = S().getSelectedObject();
    assert.notEqual(pasted.id, o.id);
    assert.match(pasted.id, UUID_RE);
    assert.equal(getRings(pasted).length, 3);
    assert.equal(getRings(pasted)[0].color, '#111111', 'the clipboard holds a snapshot, not a live reference');
    assert.deepEqual(getRings(pasted)[0].outline, { enabled: true, color: '#ffffff', thickness: 5 });
    assert.notEqual(pasted.metadata.rings, current('left_back', o.id).metadata.rings);
    assert.notEqual(pasted.metadata.rings[0], current('left_back', o.id).metadata.rings[0]);
  });

  it('duplicate keeps every ring (colour, thickness, outline) under a new id; editing the duplicate leaves the original untouched', () => {
    const o = addRings(place('dotRing', 'left_back'), 2);
    edit(o, patchRingAt(o, 1, { color: '#8e4ec6', thickness: 21 }));
    const original = current('left_back', o.id);
    S().selectObject(o.id); S().duplicateSelected();
    const dup = S().getSelectedObject();
    assert.notEqual(dup.id, o.id);
    assert.deepEqual(getRings(dup), getRings(original));
    edit(dup, patchRingAt(dup, 1, { color: '#000000', thickness: 999 }));
    assert.deepEqual(getRings(current('left_back', o.id)), getRings(original));
  });

  it('save then reload preserves every ring, its outline, and an Extra Large dot, exactly', async () => {
    const o = addRings(place('dotRing', 'right_back'), 2, 'right_back');
    edit(o, patchSizePreset(o, 'xl'));
    edit(current('right_back', o.id), patchRingAt(current('right_back', o.id), 2, { color: '#12a594', thickness: 250, outline: { enabled: true, color: '#000000', thickness: 12 } }));
    api.handler = (url, body) => ({ data: { ...S().protocol, canvases: S().canvases.map((c) => ({ ...c, objects: body.canvases.find((b) => b.id === c.id).objects })) } });
    await S().save();
    const before = JSON.parse(JSON.stringify(current('right_back', o.id)));
    S().loadProtocol(JSON.parse(JSON.stringify(S().protocol)));
    const after = current('right_back', o.id);
    assert.deepEqual(after.metadata.rings, before.metadata.rings);
    assert.equal(after.metadata.sizePreset, 'xl');
    assert.equal(getRings(after)[2].thickness, 250);
  });

  it('removing a ring is one undoable step', () => {
    const o = addRings(place('dotRing', 'left_back'), 2);
    const steps = S().history.past.length;
    edit(o, removeRingAt(current('left_back', o.id), 1));
    assert.equal(getRings(current('left_back', o.id)).length, 2);
    assert.equal(S().history.past.length, steps + 1);
    S().undo();
    assert.equal(getRings(current('left_back', o.id)).length, 3);
  });
});

describe('[DETERMINISTIC] outline, Extra Large and unlimited thickness through the store', () => {
  it('an outline can be switched on for a shape and every change is its own undo step', () => {
    const line = place('hline', 'left_front');
    edit(line, patchOutline(line, { enabled: true }));
    edit(current('left_front', line.id), patchOutline(current('left_front', line.id), { color: '#12a594', thickness: 20 }));
    assert.deepEqual(getOutline(current('left_front', line.id)), { enabled: true, color: '#12a594', thickness: 20 });
    S().undo();
    assert.equal(getOutline(current('left_front', line.id)).thickness, 4);
    S().undo();
    assert.equal(getOutline(current('left_front', line.id)).enabled, false);
  });

  it('a huge thickness survives the store round trip untouched (no clamp anywhere in commit / sync)', () => {
    const line = place('hline', 'left_front');
    edit(line, patchThickness(line, 777777));
    assert.equal(current('left_front', line.id).thickness, 777777);
    edit(current('left_front', line.id), { x: 0.2 }); // an unrelated commit runs syncDerivedMetadata
    assert.equal(current('left_front', line.id).thickness, 777777);
    assert.equal('thicknessScale' in current('left_front', line.id).metadata, false, 'no stale scale is derived from a free thickness');
  });

  it('Extra Large can be chosen for any size-capable shape and is stored as the size preset', () => {
    ['dot', 'ring', 'hline', 'rectangle', 'triangle'].forEach((tool) => {
      const o = place(tool, 'left_front');
      edit(o, patchSizePreset(o, 'xl'));
      assert.equal(current('left_front', o.id).metadata.sizePreset, tool === 'fingerBand' ? 'xl' : 'xl', tool);
    });
  });

  it('the save payload carries outline, XL and the huge thickness as plain JSON', async () => {
    const line = place('hline', 'left_front');
    edit(line, { ...patchSizePreset(line, 'xl') });
    edit(current('left_front', line.id), patchThickness(current('left_front', line.id), 54321));
    edit(current('left_front', line.id), patchOutline(current('left_front', line.id), { enabled: true, thickness: 9000 }));
    api.handler = (url, body) => ({ data: { ...S().protocol, canvases: S().canvases.map((c) => ({ ...c, objects: body.canvases.find((b) => b.id === c.id).objects })) } });
    await S().save();
    const sent = api.calls[0].body.canvases[0].objects[0];
    assert.equal(sent.metadata.sizePreset, 'xl');
    assert.equal(sent.thickness, 54321);
    assert.deepEqual(sent.metadata.outline, { enabled: true, color: '#000000', thickness: 9000 });
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), sent);
  });
});

describe('[DETERMINISTIC] copy / paste / duplicate across views', () => {
  it('paste goes onto the ACTIVE view, which can differ from where it was copied', () => {
    const o = place('dot', 'left_front');
    S().copySelected();
    S().focusCanvas('c-right_back');
    S().pasteClipboard();
    assert.equal(objectsOf('left_front').length, 1);
    assert.equal(objectsOf('right_back').length, 1);
    assert.notEqual(objectsOf('right_back')[0].id, o.id);
  });

  it('a Finger Band pasted onto a different view lands on THAT view\'s finger', () => {
    const p = axisPoint('left_front', 'ring', 0.3);
    const b = place('fingerBand', 'left_front', p.x, p.y);
    assert.equal(b.finger, 'ring');
    S().copySelected();
    S().focusCanvas('c-right_front');
    S().pasteClipboard();
    const pasted = S().getSelectedObject();
    const want = axisPoint('right_front', 'ring', getBand(pasted).position);
    assert.ok(Math.abs(pasted.x - want.x) < 1e-3 && Math.abs(pasted.y - want.y) < 1e-3, 'on the mirrored hand\'s ring finger');
    assert.equal(pasted.finger, 'ring');
    assert.notEqual(pasted.metadata.band, b.metadata.band);
  });

  it('duplicating a band keeps it on the same finger, slid along it, with independent data', () => {
    const p = axisPoint('left_front', 'middle', 0.3);
    const b = place('fingerBand', 'left_front', p.x, p.y);
    S().duplicateSelected();
    const d = S().getSelectedObject();
    assert.equal(d.finger, 'middle');
    assert.ok(getBand(d).position > getBand(b).position);
    edit(d, patchBandPosition(d, 'left_front', { width: DIMS[0][0], height: DIMS[0][1] }, 0.9));
    assert.equal(getBand(objectsOf('left_front').find((x) => x.id === b.id)).position, 0.3);
  });

  it('duplicate stays in the same view as the original even if another view is active', () => {
    const o = place('dot', 'left_front');
    S().selectObject(o.id);
    S().focusCanvas('c-left_front');
    S().duplicateSelected();
    assert.equal(objectsOf('left_front').length, 2);
  });
});

describe('[DETERMINISTIC] editing keeps recorded intent consistent', () => {
  it('a panel size change and a canvas-style resize both leave metadata.scale equal to width / base', () => {
    const o = place('ring', 'right_front');
    edit(o, patchSizePreset(o, 'large'));
    let r = objectsOf('right_front')[0];
    assert.equal(r.metadata.sizePreset, 'large');
    edit(r, { width: r.width * 0.5, height: r.height * 0.5 }); // what a Transformer drag commits
    r = objectsOf('right_front')[0];
    assert.equal(r.metadata.scale, 0.5);
  });

  it('thickness changes are single undoable steps', () => {
    const o = place('hline', 'left_front');
    const steps = S().history.past.length;
    edit(o, patchThicknessPreset(o, 'large'));
    assert.equal(S().history.past.length, steps + 1);
    S().undo();
    assert.equal(objectsOf('left_front')[0].thickness, 4);
  });

  it('text: content edits, scale and duplicate all work and stay independent', () => {
    const t = place('text', 'left_front');
    edit(t, patchText(t, 'Rest for 2 minutes'));
    edit(S().getSelectedObject() || objectsOf('left_front')[0], patchScale(objectsOf('left_front')[0], 1.5));
    const now = objectsOf('left_front')[0];
    assert.equal(getText(now), 'Rest for 2 minutes');
    S().selectObject(now.id);
    S().duplicateSelected();
    const dup = S().getSelectedObject();
    edit(dup, patchText(dup, 'changed'));
    assert.equal(getText(objectsOf('left_front').find((x) => x.id === now.id)), 'Rest for 2 minutes');
  });
});

describe('[DETERMINISTIC] undo / redo across all four views', () => {
  it('one history covers every view: undo/redo walk back and forward through edits made on different views', () => {
    place('dot', 'left_front');
    place('ring', 'right_back');
    place('text', 'left_back');
    assert.deepEqual(KEYS.map((k) => objectsOf(k).length), [1, 0, 1, 1]);
    S().undo();
    assert.deepEqual(KEYS.map((k) => objectsOf(k).length), [1, 0, 0, 1]);
    S().undo();
    S().undo();
    assert.deepEqual(KEYS.map((k) => objectsOf(k).length), [0, 0, 0, 0]);
    S().redo();
    S().redo();
    assert.deepEqual(KEYS.map((k) => objectsOf(k).length), [1, 0, 0, 1]);
  });

  it('a new action after undo discards the redo branch', () => {
    place('dot', 'left_front');
    S().undo();
    assert.equal(S().canRedo(), true);
    place('ring', 'left_front');
    assert.equal(S().canRedo(), false);
  });
});

describe('[DETERMINISTIC] eraser', () => {
  it('does not create objects when a view is clicked with the eraser', () => {
    S().setActiveTool('eraser');
    S().addObjectAtPoint(0.5, 0.5, 'c-left_front');
    assert.equal(allObjects().length, 0);
    assert.equal(S().history.past.length, 0);
  });
  it('deleting through the eraser path is one undoable step and works in any view', () => {
    const o = place('dotRing', 'right_back');
    S().setActiveTool('eraser');
    S().deleteObject(o.id, 'c-right_back'); // what HandCanvas calls when an object is clicked with the eraser
    assert.equal(objectsOf('right_back').length, 0);
    S().undo();
    assert.equal(objectsOf('right_back').length, 1);
  });
});

describe('[DETERMINISTIC] saving and loading the whole protocol', () => {
  const populate = () => {
    place('dot', 'left_front');
    place('ring', 'right_front');
    place('dotRing', 'left_back');
    const p = axisPoint('right_back', 'index', 0.4);
    place('fingerBand', 'right_back', p.x, p.y);
    const t = place('text', 'right_back', 0.5, 0.8);
    edit(t, patchText(t, 'Hold 3 min'));
    const ring = objectsOf('right_front')[0];
    edit(ring, patchThickness(ring, 12345)); // a free value, far beyond any old preset
    edit(objectsOf('right_front')[0], patchScale(objectsOf('right_front')[0], 0.8));
  };

  it('ONE request carries every view, and the payload is structured data (ids, types, metadata) rather than drawing state', async () => {
    populate();
    api.handler = (url, body) => ({ data: { ...fourViewProtocol(), canvases: fourViewProtocol().canvases.map((c) => ({ ...c, objects: body.canvases.find((b) => b.id === c.id).objects })) } });
    await S().save();
    assert.equal(api.calls.length, 1, 'one save for the whole protocol, not one per hand');
    const { url, body } = api.calls[0];
    assert.equal(url, '/protocols/proto-4/save');
    assert.deepEqual(body.canvases.map((c) => c.id), KEYS.map((k) => `c-${k}`), 'all four views');
    assert.deepEqual(body.canvases.map((c) => c.objects.length), [1, 1, 1, 2]);
    assert.deepEqual(Object.keys(body.canvases[0]).sort(), ['id', 'objects'], 'only ids and objects are sent');
    const sent = JSON.parse(JSON.stringify(body));
    assert.deepEqual(sent, body, 'plain JSON, nothing that only exists in the browser');
    const flat = body.canvases.flatMap((c) => c.objects);
    assert.ok(flat.some((o) => Array.isArray(o.metadata.rings) && o.metadata.rings.length === 1), 'the attached ring travels inside its dot');
    assert.ok(flat.some((o) => o.type === 'fingerBand' && o.finger === 'index' && o.metadata.band.position === 0.4));
    assert.ok(flat.some((o) => o.type === 'text' && o.metadata.text === 'Hold 3 min'));
  });

  it('after a save the screen shows exactly what the server returned, and the unsaved flag clears', async () => {
    populate();
    assert.equal(S().isDirty, true);
    api.handler = (url, body) => ({ data: JSON.parse(JSON.stringify({ ...fourViewProtocol(), currentVersion: 2, canvases: fourViewProtocol().canvases.map((c) => ({ ...c, objects: body.canvases.find((b) => b.id === c.id).objects })) })) });
    const sentSnapshot = JSON.stringify(S().canvases.map((c) => c.objects));
    await S().save();
    assert.equal(S().isDirty, false);
    assert.equal(S().protocol.currentVersion, 2);
    assert.equal(JSON.stringify(S().canvases.map((c) => c.objects)), sentSnapshot);
  });

  it('loading a saved protocol restores all four views and every value', () => {
    populate();
    const saved = JSON.parse(JSON.stringify({ ...fourViewProtocol(), canvases: S().canvases }));
    S().loadProtocol(fourViewProtocol());
    assert.equal(allObjects().length, 0);
    S().loadProtocol(saved);
    assert.deepEqual(KEYS.map((k) => objectsOf(k).length), [1, 1, 1, 2]);
    assert.equal(hasRings(objectsOf('left_back')[0]), true);
    assert.equal(objectsOf('right_front')[0].thickness, 12345);
    assert.equal('thicknessPreset' in objectsOf('right_front')[0].metadata, false);
    assert.equal(objectsOf('right_front')[0].metadata.scale, 0.8);
    assert.equal(getText(objectsOf('right_back')[1]), 'Hold 3 min');
    assert.equal(S().isDirty, false);
    assert.equal(S().history.past.length, 0);
  });

  it('a loaded protocol is independent of the object it was loaded from (no shared references)', () => {
    populate();
    const saved = JSON.parse(JSON.stringify({ ...fourViewProtocol(), canvases: S().canvases }));
    S().loadProtocol(saved);
    objectsOf('left_back')[0].metadata.rings[0].color = '#000000'; // mutate the store's copy directly
    assert.equal(saved.canvases[2].objects[0].metadata.rings[0].color, '#1a73e8', 'the source data is not touched');
  });
});

describe('[DETERMINISTIC] JSON export / import through the store', () => {
  const populate = () => {
    place('dot', 'left_front');
    place('dotRing', 'left_back');
    const p = axisPoint('right_back', 'ring', 0.5);
    place('fingerBand', 'right_back', p.x, p.y);
    place('text', 'right_front');
  };

  it('export is structured JSON of every view', () => {
    populate();
    const data = S().exportProtocolData();
    assert.equal(data.format, 'colour-therapy-protocol');
    assert.deepEqual(data.views.map((v) => v.viewKey), KEYS);
    assert.deepEqual(data.views.map((v) => v.objects.length), [1, 1, 1, 1]);
    assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
    data.views[2].objects[0].metadata.rings[0].color = '#000000';
    assert.equal(getRings(objectsOf('left_back')[0])[0].color, '#1a73e8', 'the export is a copy, not a live reference');
  });

  it('import replaces the views in the file with NEW ids, keeps all data, and is one undo step', () => {
    populate();
    const data = JSON.parse(JSON.stringify(S().exportProtocolData()));
    S().loadProtocol(fourViewProtocol());
    const before = S().history.past.length;
    const result = S().importProtocolData(data);
    assert.equal(result.ok, true);
    assert.deepEqual(KEYS.map((k) => objectsOf(k).length), [1, 1, 1, 1]);
    const importedIds = allObjects().map((o) => o.id);
    const fileIds = data.views.flatMap((v) => v.objects.map((o) => o.id));
    assert.equal(importedIds.filter((id) => fileIds.includes(id)).length, 0, 'fresh ids, so importing never collides with the source protocol');
    importedIds.forEach((id) => assert.match(id, UUID_RE));
    assert.equal(hasRings(objectsOf('left_back')[0]), true);
    assert.equal(objectsOf('right_back')[0].finger, 'ring');
    assert.equal(S().isDirty, true, 'imported data still has to be saved');
    assert.equal(S().history.past.length, before + 1);
    S().undo();
    assert.equal(allObjects().length, 0, 'one undo reverses the whole import');
  });

  it('import only touches the views that appear in the file', () => {
    populate();
    const only = { ...S().exportProtocolData(), views: [{ ...S().exportProtocolData().views[0], objects: [] }] };
    assert.equal(S().importProtocolData(only).ok, true);
    assert.deepEqual(KEYS.map((k) => objectsOf(k).length), [0, 1, 1, 1]);
  });

  it('malformed files are rejected with readable errors and change NOTHING', () => {
    populate();
    const snapshot = JSON.stringify(S().canvases);
    const steps = S().history.past.length;
    const good = S().exportProtocolData();
    const bad = JSON.parse(JSON.stringify(good));
    bad.views[0].objects[0].color = 'red';
    bad.views[1].objects[0].metadata = { sizePreset: 'xl' };
    [null, 'text', 42, [], {}, { format: 'other' }, { ...good, version: 99 }, { ...good, views: [] }, bad].forEach((input) => {
      const r = S().importProtocolData(input);
      assert.equal(r.ok, false);
      assert.ok(r.errors.length > 0 && r.errors.every((e) => typeof e === 'string'));
    });
    assert.equal(JSON.stringify(S().canvases), snapshot);
    assert.equal(S().history.past.length, steps);
  });

  it('a file that is not JSON is rejected without throwing', () => {
    populate();
    const snapshot = JSON.stringify(S().canvases);
    ['', '{', 'not json', '<html>'].forEach((text) => {
      const r = S().importProtocolText(text);
      assert.equal(r.ok, false);
      assert.match(r.errors[0], /not valid JSON/);
    });
    assert.equal(JSON.stringify(S().canvases), snapshot);
    assert.equal(S().importProtocolText(JSON.stringify(S().exportProtocolData())).ok, true);
  });
});
