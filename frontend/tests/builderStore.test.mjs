/**
 * [DETERMINISTIC SOFTWARE TESTS] Doctor Builder state (src/builder/store.js + objectDefaults.js) — the REAL modules.
 * Covers copy/paste/duplicate deep-clone behaviour, id regeneration, undo/redo, and every object type (the original 10 + fingerBand + text).
 * It does NOT render the Konva canvas — dragging/resizing on screen needs a browser (see docs/REAL_DEVICE_VALIDATION.md).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import useProtocolStore from '../src/builder/store.js';
import { createDefaultObject, OBJECT_TYPES } from '../src/builder/objectDefaults.js';
import api from './support/stubs/apiClient.mjs';

const S = () => useProtocolStore.getState();
const TYPES = OBJECT_TYPES.map((t) => t.type);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeProtocol() {
  return {
    id: 'proto-1', name: 'Test', currentVersion: 1,
    canvases: [
      {
        id: 'c1', viewKey: 'left_front', width: 1586, height: 1982,
        objects: [{
          id: 'o1', type: 'freeline', x: 0.1, y: 0.2, width: null, height: null, rotation: 0, color: '#111111', thickness: 4, opacity: 1,
          points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], finger: 'index',
          landmarkReference: { start: 9, end: 10, t: 0.35 }, metadata: { note: 'a', tags: ['x', 'y'] }, zIndex: 1,
        }],
      },
      { id: 'c2', viewKey: 'right_front', width: 1585, height: 1983, objects: [] },
    ],
  };
}

beforeEach(() => {
  api.reset();
  S().loadProtocol(makeProtocol());
});

const canvasObjects = (id) => S().canvases.find((c) => c.id === id).objects;
const withoutVolatile = ({ id, x, y, zIndex, ...rest }) => rest; // eslint-disable-line no-unused-vars

describe('[DETERMINISTIC] default objects for every supported type', () => {
  it('the original 10 types are unchanged, two were added (12), and each creates a well-formed, JSON-safe object with a fresh UUID', () => {
    assert.deepEqual(TYPES.slice(0, 10), ['dot', 'ring', 'hline', 'vline', 'freeline', 'invertedTriangle', 'triangle', 'rectangle', 'square', 'arrow'], 'the original ten are unchanged and in the same order');
    assert.deepEqual(TYPES.slice(10), ['fingerBand', 'text']);
    assert.equal(TYPES.length, 12);
    const ids = new Set();
    for (const type of TYPES) {
      const o = createDefaultObject(type, 0.4, 0.5);
      assert.equal(o.type, type);
      assert.match(o.id, UUID_RE);
      ids.add(o.id);
      assert.equal(o.x, 0.4); assert.equal(o.y, 0.5);
      assert.deepEqual(JSON.parse(JSON.stringify(o)), o, `${type} must survive JSON serialisation unchanged`);
      for (const k of ['width', 'height']) if (o[k] !== null) assert.ok(o[k] > 0 && o[k] <= 1, `${type}.${k} must be a normalized fraction`);
    }
    assert.equal(ids.size, TYPES.length, 'ids must be unique');
  });

  it('per-type defaults are what the builder has always produced', () => {
    const d = (t) => createDefaultObject(t, 0.5, 0.5);
    assert.deepEqual([d('dot').width, d('dot').thickness], [0.03, 0]);
    assert.deepEqual([d('ring').width, d('ring').thickness], [0.08, 4]);
    assert.deepEqual([d('hline').width, d('hline').rotation], [0.18, 0]);
    assert.equal(d('vline').rotation, 90);
    assert.equal(d('invertedTriangle').rotation, 180);
    assert.equal(d('triangle').rotation, 0);
    assert.deepEqual([d('rectangle').width, d('rectangle').height], [0.16, 0.1]);
    assert.deepEqual([d('square').width, d('square').height], [0.1, 0.1]);
    assert.equal(d('arrow').width, 0.18);
    assert.equal(d('freeline').points.length, 2);
  });
});

describe('[DETERMINISTIC] adding objects through the store', () => {
  it('every one of the 12 types can be added to the active canvas, each as its own undoable step', () => {
    for (const type of TYPES.filter((t) => t !== 'freeline')) {
      S().setActiveTool(type);
      S().addObjectAtPoint(0.3, 0.3);
    }
    S().addFreeLineAtPoints([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.25 }, { x: 0.3, y: 0.2 }]);
    const added = canvasObjects('c1').filter((o) => o.id !== 'o1');
    assert.deepEqual(added.map((o) => o.type).sort(), [...TYPES].sort());
    assert.equal(canvasObjects('c2').length, 0, 'objects must land only on the ACTIVE canvas');
    assert.equal(S().history.past.length, TYPES.length);
    for (let i = 0; i < TYPES.length; i += 1) S().undo();
    assert.equal(canvasObjects('c1').length, 1, 'one undo per addition removes exactly the additions');
  });

  it('a free line needs at least two points; the select tool adds nothing', () => {
    S().addFreeLineAtPoints([{ x: 0.1, y: 0.1 }]);
    S().setActiveTool('select'); S().addObjectAtPoint(0.5, 0.5);
    assert.equal(canvasObjects('c1').length, 1);
    assert.equal(S().history.past.length, 0);
  });
});

describe('[DETERMINISTIC] loading is isolated from the source data', () => {
  it('editing the store never mutates the protocol object it was loaded from, and vice versa', () => {
    const source = makeProtocol();
    const snapshot = JSON.stringify(source);
    S().loadProtocol(source);
    S().commitObjectChange('o1', { color: '#ff0000' });
    canvasObjects('c1')[0].points.push({ x: 9, y: 9 });
    assert.equal(JSON.stringify(source), snapshot, 'source data must be untouched');
    source.canvases[0].objects[0].metadata.note = 'changed after load';
    assert.equal(canvasObjects('c1')[0].metadata.note, 'a', 'later changes to the source must not leak into the store');
  });
});

describe('[DETERMINISTIC] copy / paste / duplicate: deep clone with new IDs', () => {
  it('paste creates a new UUID, keeps every property, offsets the position, and is stored in the active canvas', () => {
    S().selectObject('o1'); S().copySelected(); S().pasteClipboard();
    const [orig, pasted] = canvasObjects('c1');
    assert.notEqual(pasted.id, orig.id);
    assert.match(pasted.id, UUID_RE);
    assert.deepEqual(withoutVolatile(pasted), withoutVolatile(orig), 'everything except id/position/zIndex is identical');
    assert.ok(Math.abs(pasted.x - (orig.x + 0.04)) < 1e-12 && Math.abs(pasted.y - (orig.y + 0.04)) < 1e-12);
    assert.equal(S().selectedObjectId, pasted.id, 'the new object becomes the selection');
  });

  it('no shared mutable references: nested points / metadata / landmarkReference are independent copies', () => {
    S().selectObject('o1'); S().copySelected(); S().pasteClipboard();
    const [orig, pasted] = canvasObjects('c1');
    for (const key of ['points', 'metadata', 'landmarkReference']) assert.notStrictEqual(pasted[key], orig[key], `${key} must be a distinct object`);
    assert.notStrictEqual(pasted.points[0], orig.points[0]);
    assert.notStrictEqual(pasted.metadata.tags, orig.metadata.tags);

    // mutate the copy IN PLACE (the case a shallow clone would get wrong) — the original must not change
    pasted.points[0].x = 0.99; pasted.metadata.tags.push('z'); pasted.landmarkReference.t = 0.9;
    assert.equal(orig.points[0].x, 0.1);
    assert.deepEqual(orig.metadata.tags, ['x', 'y']);
    assert.equal(orig.landmarkReference.t, 0.35);
    // …and the other way round
    orig.metadata.note = 'edited original';
    assert.equal(pasted.metadata.note, 'a');
  });

  it('pasting the same clipboard twice gives two distinct, mutually independent objects', () => {
    S().selectObject('o1'); S().copySelected(); S().pasteClipboard(); S().pasteClipboard();
    const [, a, b] = canvasObjects('c1');
    assert.notEqual(a.id, b.id);
    a.points.push({ x: 0.5, y: 0.5 });
    assert.equal(b.points.length, 2);
  });

  it('the clipboard is a snapshot: changing the original after copying does not change what gets pasted', () => {
    S().selectObject('o1'); S().copySelected();
    S().commitObjectChange('o1', { color: '#00ff00' });
    S().pasteClipboard();
    assert.equal(canvasObjects('c1')[1].color, '#111111');
  });

  it('paste lands on whichever canvas is active (copy on one view, paste on another)', () => {
    S().selectObject('o1'); S().copySelected();
    S().setActiveCanvas('c2'); S().pasteClipboard();
    assert.equal(canvasObjects('c1').length, 1);
    assert.equal(canvasObjects('c2').length, 1);
    assert.equal(canvasObjects('c2')[0].type, 'freeline');
  });

  it('duplicate behaves the same way: new id, identical properties, independent nested data', () => {
    S().selectObject('o1'); S().duplicateSelected();
    const [orig, dup] = canvasObjects('c1');
    assert.notEqual(dup.id, orig.id);
    assert.match(dup.id, UUID_RE);
    assert.deepEqual(withoutVolatile(dup), withoutVolatile(orig));
    assert.notStrictEqual(dup.points, orig.points);
    dup.metadata.tags.push('q');
    assert.deepEqual(orig.metadata.tags, ['x', 'y']);
  });

  it('the pasted/duplicated position is clamped so it cannot leave the canvas', () => {
    S().commitObjectChange('o1', { x: 0.97, y: 0.99 });
    S().selectObject('o1'); S().duplicateSelected();
    const dup = canvasObjects('c1')[1];
    assert.equal(dup.x, 0.95); assert.equal(dup.y, 0.95);
  });

  it('copy/paste/duplicate with nothing selected does nothing (and adds no history)', () => {
    S().copySelected(); S().pasteClipboard(); S().duplicateSelected();
    assert.equal(canvasObjects('c1').length, 1);
    assert.equal(S().history.past.length, 0);
  });
});

describe('[DETERMINISTIC] undo / redo / delete', () => {
  it('undo restores the exact previous state, redo re-applies it, and a new action discards the redo branch', () => {
    const before = JSON.stringify(S().canvases);
    S().commitObjectChange('o1', { color: '#abcdef', thickness: 9 });
    const after = JSON.stringify(S().canvases);
    assert.notEqual(before, after);

    S().undo(); assert.equal(JSON.stringify(S().canvases), before);
    assert.equal(S().canRedo(), true);
    S().redo(); assert.equal(JSON.stringify(S().canvases), after);

    S().undo();
    S().commitObjectChange('o1', { opacity: 0.5 });
    assert.equal(S().canRedo(), false, 'a new edit clears the redo stack');
  });

  it('undo/redo span ALL canvases (an edit on one view can be undone while another view is showing)', () => {
    S().commitObjectChange('o1', { color: '#123456' });
    S().setActiveCanvas('c2'); S().setActiveTool('dot'); S().addObjectAtPoint(0.5, 0.5);
    assert.equal(canvasObjects('c2').length, 1);
    S().undo(); assert.equal(canvasObjects('c2').length, 0);
    S().undo(); assert.equal(canvasObjects('c1')[0].color, '#111111');
    assert.equal(S().canUndo(), false);
  });

  it('undo history is capped at 100 steps', () => {
    for (let i = 0; i < 105; i += 1) S().commitObjectChange('o1', { rotation: i });
    let undone = 0;
    while (S().canUndo()) { S().undo(); undone += 1; }
    assert.equal(undone, 100);
  });

  it('delete removes only the chosen object, clears the selection if it was selected, and is undoable', () => {
    S().selectObject('o1'); S().duplicateSelected();
    const [orig, dup] = canvasObjects('c1');
    S().deleteObject(dup.id);
    assert.deepEqual(canvasObjects('c1').map((o) => o.id), [orig.id]);
    assert.equal(S().selectedObjectId, null);
    S().undo();
    assert.equal(canvasObjects('c1').length, 2);
  });

  it('every edit marks the protocol as unsaved', () => {
    assert.equal(S().isDirty, false);
    S().commitObjectChange('o1', { color: '#000000' });
    assert.equal(S().isDirty, true);
  });
});

describe('[DETERMINISTIC] saving', () => {
  it('posts only { id, objects } per canvas to the save endpoint, then adopts the server response and clears the unsaved flag', async () => {
    S().commitObjectChange('o1', { color: '#ff00ff' });
    const serverResponse = { ...makeProtocol(), currentVersion: 2 };
    serverResponse.canvases[0].objects[0].color = '#ff00ff';
    api.handler = () => ({ data: serverResponse });

    const result = await S().save();
    assert.equal(api.calls.length, 1);
    const call = api.calls[0];
    assert.equal(call.url, '/protocols/proto-1/save');
    assert.deepEqual(Object.keys(call.body), ['canvases']);
    assert.deepEqual(call.body.canvases.map((c) => Object.keys(c).sort()), [['id', 'objects'], ['id', 'objects']]);
    assert.equal(call.body.canvases[0].objects[0].color, '#ff00ff');

    assert.equal(result.currentVersion, 2);
    assert.equal(S().protocol.currentVersion, 2);
    assert.equal(S().isDirty, false);
    assert.equal(S().isSaving, false);
  });

  it('a failed save keeps the doctor\'s unsaved work and reports the error', async () => {
    S().commitObjectChange('o1', { color: '#ff00ff' });
    api.handler = () => { throw new Error('network down'); };
    await assert.rejects(S().save(), /network down/);
    assert.equal(S().isDirty, true);
    assert.equal(S().isSaving, false);
    assert.equal(S().error, 'network down');
    assert.equal(canvasObjects('c1')[0].color, '#ff00ff');
  });
});
