/**
 * [DETERMINISTIC SOFTWARE TESTS — rendering + store] the Studio "Camera anchor" control (undoable, saved in the existing
 * landmarkReference field) and the admin hand-reference editor.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import useProtocolStore from '../src/builder/store.js';
import { __reset } from './support/stubs/reactRouter.mjs';
import { loadComponent, RENDER_SKIP } from './support/renderJsx.mjs';
import { anchorPatch } from '../src/builder/model/anchors.js';
import { BUILT_IN_REFERENCE_LANDMARKS } from '../src/tracking/referenceLandmarks.js';

const S = () => useProtocolStore.getState();
const render = (C, p) => renderToStaticMarkup(h(C, p));
const W = 1586; const H = 1982;
const canvas = { id: 'c-lf', viewKey: 'left_front', canvasType: 'hand', backgroundLabel: 'Left Front', width: W, height: H, objects: [] };
const P = BUILT_IN_REFERENCE_LANDMARKS.left_front;

let AnchorControl; let AdminHandReferenceView; let startingTables; let changesFromBuiltIn; let exportTables;

describe('[DETERMINISTIC] camera anchors in the Studio', { skip: RENDER_SKIP }, () => {
  before(async () => {
    ({ AnchorControl } = await loadComponent('src/builder/PropertiesPanel.jsx'));
    ({ AdminHandReferenceView, startingTables, changesFromBuiltIn, exportTables } = await loadComponent('src/pages/admin/AdminHandReferencePage.jsx'));
  });
  beforeEach(() => __reset());

  it('automatic anchor shows which part of the hand the marking moves with', () => {
    const o = { id: 'o', type: 'dot', x: (P[10][0] + P[11][0]) / 2, y: (P[10][1] + P[11][1]) / 2, landmarkReference: null };
    const html = render(AnchorControl, { object: o, canvas, onCommit: () => {} });
    assert.match(html, /Camera anchor/);
    assert.match(html, /Automatic \(Middle finger – middle segment\)/);
    assert.match(html, /Moves with: Middle finger – middle segment/);
  });
  it('an ambiguous spot asks the doctor to choose; a pinned anchor says so; a stale pin warns', () => {
    const root = { id: 'o', type: 'dot', x: P[9][0] + (P[10][0] - P[9][0]) * 0.12, y: P[9][1] + (P[10][1] - P[9][1]) * 0.12, landmarkReference: null };
    assert.match(render(AnchorControl, { object: root, canvas, onCommit: () => {} }), /data-testid="anchor-ambiguous"/);
    const pinned = { ...root, x: P[8][0], y: P[8][1], landmarkReference: { region: 'index.distal', source: 'doctor' } };
    assert.match(render(AnchorControl, { object: pinned, canvas, onCommit: () => {} }), /Pinned: moves only with Index finger – tip segment/);
    assert.match(render(AnchorControl, { object: { ...pinned, x: P[20][0], y: P[20][1] }, canvas, onCommit: () => {} }), /anchor-mismatch/);
    assert.equal(render(AnchorControl, { object: root, canvas: { ...canvas, canvasType: 'organ', viewKey: 'body_front' }, onCommit: () => {} }), '');
  });
  it('pinning goes through the normal store commit: saved in landmarkReference, undo and redo restore it', () => {
    S().loadProtocol({ id: 'p', name: 'P', protocolType: 'hand', currentVersion: 1, status: 'draft', slug: 'p', canvases: [canvas] });
    S().setActiveTool('dot');
    S().addObjectAtPoint(0.5, 0.2, 'c-lf');
    const id = S().getSelectedObject().id;
    S().commitObjectChange(id, anchorPatch('middle.distal'));
    const obj = () => S().canvases[0].objects.find((o) => o.id === id);
    assert.deepEqual(obj().landmarkReference, { region: 'middle.distal', source: 'doctor' });
    S().undo();
    assert.equal(obj().landmarkReference, null);
    S().redo();
    assert.deepEqual(obj().landmarkReference, { region: 'middle.distal', source: 'doctor' });
  });

  it('admin reference editor: 21 draggable points per view, change tracking and a committable export', () => {
    const tables = startingTables();
    const html = render(AdminHandReferenceView, {
      tables, viewKey: 'left_back', dims: { width: 1585, height: 1981 }, selected: 9, changes: changesFromBuiltIn(tables),
      onSelectView: () => {}, onPointerDown: () => {}, svgRef: null, previewActive: false, onPreview: () => {}, onClearPreview: () => {}, onReset: () => {}, onDownload: () => {},
    });
    assert.equal(html.split('data-testid="handref-point"').length - 1, 21);
    assert.match(html, /9 · middle mcp/);
    const edited = { ...tables, left_back: tables.left_back.map(([x, y], i) => (i === 0 ? [x + 0.01, y] : [x, y])) };
    assert.ok(changesFromBuiltIn(edited).left_back > 0.009 && changesFromBuiltIn(edited).left_front === 0);
    const json = JSON.parse(exportTables(edited));
    assert.equal(json.left_back.length, 21);
    assert.equal(json.left_back[0][0], Math.round((BUILT_IN_REFERENCE_LANDMARKS.left_back[0][0] + 0.01) * 10000) / 10000);
  });
});
