/**
 * [DETERMINISTIC SOFTWARE TESTS — canvas layer] The Studio's real shape components, canvas and 2x2 workspace are compiled and rendered in Node
 * with a RECORDING stand-in for react-konva (real Konva needs a browser canvas). Tests check exactly what each shape tells Konva to draw
 * (sizes, colours, rotation, layout) and call the shapes' drag / resize handlers with fake events to check the data changes they emit.
 * WHAT THIS DOES NOT PROVE: that Konva then paints it correctly, or how mouse dragging feels. That needs a real browser
 * (see docs/PROTOCOL_STUDIO.md, "Manual QA").
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import useProtocolStore from '../src/builder/store.js';
import api from './support/stubs/apiClient.mjs';
import { konvaCalls, resetKonva } from './support/stubs/reactKonva.mjs';
import { loadComponent, RENDER_SKIP } from './support/renderJsx.mjs';
import { axisPoint, getGuide } from '../src/builder/model/fingerGeometry.js';
import { createStudioObject, getRing, patchText, patchRingGapPreset, patchRingColor, effectiveRingGapPx, patchRingEnabled, addRing, patchRingAt, patchOutline, patchThickness, getRings, getOutline, compositeRingLayers } from '../src/builder/model/objectModel.js';
import { RING_GAP_BASES } from '../src/builder/config/sizePresets.js';

const S = () => useProtocolStore.getState();
const KEYS = ['left_front', 'right_front', 'left_back', 'right_back'];
const DIMS = [[1586, 1982], [1585, 1983], [1585, 1981], [1971, 2010]];
const W = 1586; const H = 1982;
const canvasFor = (viewKey = 'left_front', objects = []) => {
  const i = KEYS.indexOf(viewKey);
  return { id: `c-${viewKey}`, viewKey, canvasType: 'hand', backgroundLabel: viewKey.replace('_', ' '), backgroundUrl: `/assets/${viewKey}.png`, width: DIMS[i][0], height: DIMS[i][1], objects };
};
const protocol = (type = 'hand', canvases) => ({ id: 'p', name: 'P', protocolType: type, currentVersion: 1, status: 'draft', canvases: canvases || KEYS.map((k) => canvasFor(k)) });
const make = (tool, viewKey = 'left_front', x = 0.4, y = 0.5) => { const i = KEYS.indexOf(viewKey); return createStudioObject(tool, x, y, { viewKey, canvasWidth: DIMS[i][0], canvasHeight: DIMS[i][1] }); };
const place = (tool, viewKey, x = 0.4, y = 0.5) => { S().setActiveTool(tool); S().addObjectAtPoint(x, y, S().canvases.find((c) => c.viewKey === viewKey).id); return S().getSelectedObject(); };
/** A Dot + Ring in the OLDER single-spaced-ring format (`metadata.ring`). */
const makeLegacyRing = (view = 'left_front', x = 0.4, y = 0.5) => { const d = make('dot', view, x, y); return { ...d, ...patchRingEnabled(d, true) }; };
const near = (a, b, eps = 1e-6, m = '') => assert.ok(Math.abs(a - b) <= eps, `${m} expected ${b} got ${a}`);

/** A stand-in for a Konva node that supports the getter/setter style the shapes use. */
function fakeNode({ x = 0, y = 0, sx = 1, sy = 1, rotation = 0, radius = 10, width = 10, height = 10 } = {}) {
  const n = { _x: x, _y: y, _sx: sx, _sy: sy, _r: rotation, _radius: radius, _w: width, _h: height, positioned: null, sets: [] };
  const acc = (key, prop) => (v) => { if (v === undefined) return n[prop]; n[prop] = v; n.sets.push([key, v]); return n; };
  n.x = acc('x', '_x'); n.y = acc('y', '_y'); n.scaleX = acc('scaleX', '_sx'); n.scaleY = acc('scaleY', '_sy'); n.rotation = () => n._r;
  n.radius = acc('radius', '_radius'); n.width = acc('width', '_w'); n.height = acc('height', '_h');
  n.offsetX = () => n; n.offsetY = () => n; n.position = (p) => { n.positioned = p; n._x = p.x; n._y = p.y; return n; };
  return n;
}
const renderShape = (Component, props) => { resetKonva(); renderToStaticMarkup(h(Component, props)); return konvaCalls().map((c) => ({ name: c.name, props: c.props })); };
const first = (calls, name) => calls.find((c) => c.name === name);
const all = (calls, name) => calls.filter((c) => c.name === name);

let ObjectRenderer; let DotRingShape; let FingerBandShape; let TextShape; let HandCanvas; let HandWorkspace; let PreviewMode;

describe('[DETERMINISTIC · canvas layer] shapes', { skip: RENDER_SKIP }, () => {
  before(async () => {
    ({ default: ObjectRenderer } = await loadComponent('src/builder/ObjectRenderer.jsx'));
    ({ default: DotRingShape } = await loadComponent('src/builder/shapes/DotRingShape.jsx'));
    ({ default: FingerBandShape } = await loadComponent('src/builder/shapes/FingerBandShape.jsx'));
    ({ default: TextShape } = await loadComponent('src/builder/shapes/TextShape.jsx'));
  });

  const noop = () => {};
  const props = (object, extra = {}) => ({ object, canvas: canvasFor('left_front'), isSelected: false, onSelect: noop, onChange: noop, nodeRef: noop, ...extra });

  describe('which Konva shape each object type becomes', () => {
    const expectations = [
      ['dot', 'Circle'], ['ring', 'Circle'], ['hline', 'Line'], ['vline', 'Line'], ['arrow', 'Arrow'], ['freeline', 'Line'],
      ['triangle', 'RegularPolygon'], ['invertedTriangle', 'RegularPolygon'], ['rectangle', 'Rect'], ['square', 'Rect'], ['text', 'Text'],
    ];
    expectations.forEach(([tool, shape]) => {
      it(`${tool} -> ${shape}`, () => {
        const calls = renderShape(ObjectRenderer, props(make(tool)));
        assert.ok(first(calls, shape), `${tool} should render a ${shape}; got ${calls.map((c) => c.name)}`);
        assert.equal(first(calls, 'Group'), undefined, 'no group for a simple shape');
      });
    });
    it('a plain dot is a filled circle; a ring is an outline (as before)', () => {
      const dot = first(renderShape(ObjectRenderer, props(make('dot'))), 'Circle').props;
      assert.equal(dot.fill, '#e5484d');
      const ring = first(renderShape(ObjectRenderer, props(make('ring'))), 'Circle').props;
      assert.equal(ring.fill, undefined);
      assert.equal(ring.stroke, '#e5484d');
      assert.equal(ring.strokeWidth, 4);
    });
    it('a legacy Dot + Ring is ONE group holding a ring circle and a dot circle', () => {
      const calls = renderShape(ObjectRenderer, props(makeLegacyRing()));
      assert.equal(all(calls, 'Group').length, 1);
      assert.equal(all(calls, 'Circle').length, 2);
    });
    it('a dot whose ring is switched off is drawn as a plain dot again', () => {
      const o = makeLegacyRing();
      o.metadata.ring.enabled = false;
      const calls = renderShape(ObjectRenderer, props(o));
      assert.equal(first(calls, 'Group'), undefined);
      assert.equal(all(calls, 'Circle').length, 1);
    });
    it('Finger Band -> a group; text -> Text; unknown types render nothing instead of crashing', () => {
      assert.ok(first(renderShape(ObjectRenderer, props(make('fingerBand'))), 'Group'));
      assert.deepEqual(renderShape(ObjectRenderer, props({ ...make('dot'), type: 'hologram' })), []);
    });
  });

  describe('LEGACY single spaced ring: drawing and handlers', () => {
    it('draws the ring and dot at the right sizes, colours and place', () => {
      const o = makeLegacyRing( 'left_front', 0.3, 0.6);
      o.color = '#f76b15'; o.opacity = 0.5; o.metadata.ring.color = '#1a73e8';
      const calls = renderShape(DotRingShape, props(o));
      const group = first(calls, 'Group').props;
      near(group.x, 0.3 * W); near(group.y, 0.6 * H); assert.equal(group.opacity, 0.5); assert.equal(group.draggable, true);
      const [ring, dot] = all(calls, 'Circle').map((c) => c.props);
      near(ring.radius, (o.metadata.ring.width / 2) * W, 1e-6);
      near(dot.radius, (o.width / 2) * W, 1e-6);
      assert.ok(ring.radius > dot.radius);
      assert.deepEqual([ring.stroke, ring.strokeWidth, ring.fill], ['#1a73e8', o.metadata.ring.thickness, undefined]);
      assert.deepEqual([dot.fill], ['#f76b15']);
    });
    it('changing the gap changes what is actually drawn: the ring is redrawn with EXACTLY that empty space, immediately, without a second object', () => {
      const dotRadiusPx = (0.03 / 2) * W; // the default dot at Medium size
      const canvas = { width: W, height: H };
      ['small', 'medium', 'large'].forEach((preset) => {
        const o = makeLegacyRing( 'left_front', 0.3, 0.6);
        const patched = { ...o, ...patchRingGapPreset(o, canvas, preset) };
        const calls = renderShape(DotRingShape, props(patched));
        // Still one composite: one Group, one ring Circle, one dot Circle — not a second, independent object.
        assert.equal(all(calls, 'Group').length, 1);
        assert.equal(all(calls, 'Circle').length, 2);
        const [ring] = all(calls, 'Circle').map((c) => c.props);
        const thicknessPx = getRing(patched).thickness;
        // The ring's INNER edge (radius minus half the stroke, since a Konva stroke is centred on the radius)
        // sits exactly RING_GAP_BASES[preset] px from the dot's outer edge — not merely "further away than before".
        const ringInnerEdgePx = ring.radius - thicknessPx / 2;
        near(ringInnerEdgePx - dotRadiusPx, RING_GAP_BASES[preset], 0.01, `${preset} gap`);
      });
    });
    it('the SAME object redrawn after only its gap changes shows a different radius and nothing else', () => {
      const canvas = { width: W, height: H };
      const o = makeLegacyRing( 'left_front', 0.3, 0.6);
      const small = { ...o, ...patchRingGapPreset(o, canvas, 'small') };
      const before = first(renderShape(DotRingShape, props(small)), 'Circle').props;
      const grown = { ...small, ...patchRingGapPreset(small, canvas, 'large') };
      const after = first(renderShape(DotRingShape, props(grown)), 'Circle').props;
      assert.ok(after.radius > before.radius, 'the canvas immediately reflects the larger gap');
      assert.deepEqual([after.stroke, after.strokeWidth], [before.stroke, before.strokeWidth], 'colour and thickness are unaffected by a gap change');
      const dot = all(renderShape(DotRingShape, props(grown)), 'Circle')[1].props;
      near(dot.radius, (grown.width / 2) * W, 1e-6, 'the dot itself does not change size when only the gap changes');
    });
    it('dragging the group commits a new position only', () => {
      const changes = [];
      const o = makeLegacyRing();
      const group = first(renderShape(DotRingShape, props(o, { onChange: (p) => changes.push(p) })), 'Group').props;
      group.onDragEnd({ target: fakeNode({ x: 0.5 * W, y: 0.25 * H }) });
      assert.deepEqual(changes, [{ x: 0.5, y: 0.25 }]);
    });
    it('resizing the group scales the dot AND the ring together and resets Konva\'s scale', () => {
      const changes = [];
      const o = makeLegacyRing();
      const group = first(renderShape(DotRingShape, props(o, { onChange: (p) => changes.push(p) })), 'Group').props;
      const node = fakeNode({ x: 0.4 * W, y: 0.5 * H, sx: 1.5, sy: 1.5 });
      group.onTransformEnd({ target: node });
      assert.equal(node.scaleX(), 1); assert.equal(node.scaleY(), 1);
      const patch = changes[0];
      near(patch.width, +(o.width * 1.5).toFixed(4), 1e-6);
      near(patch.metadata.ring.width, +(getRing(o).width * 1.5).toFixed(4), 1e-6);
      assert.equal(patch.height, patch.width);
      near(patch.x, 0.4, 1e-6);
    });
    it('the ring of a dot never moves independently: only the group is draggable', () => {
      const calls = renderShape(DotRingShape, props(makeLegacyRing()));
      all(calls, 'Circle').forEach((c) => assert.notEqual(c.props.draggable, true));
    });
  });

  describe('Finger Band drawing and handlers', () => {
    const band = (view = 'left_front', finger = 'ring', t = 0.4) => { const p = axisPoint(view, finger, t); return make('fingerBand', view, p.x, p.y); };
    it('is drawn across the finger at its saved place, angle, width and colour', () => {
      const o = band();
      o.color = '#12a594'; o.opacity = 0.7;
      const calls = renderShape(FingerBandShape, props(o));
      const group = first(calls, 'Group').props;
      near(group.x, o.x * W); near(group.y, o.y * H); near(group.rotation, o.rotation); assert.equal(group.opacity, 0.7);
      const lines = all(calls, 'Line').map((l) => l.props);
      assert.equal(lines.length, 2, 'halo + band');
      const colored = lines.find((l) => l.stroke === '#12a594');
      assert.equal(colored.strokeWidth, o.thickness);
      near(colored.points[0], -(o.width * W) / 2); near(colored.points[4], (o.width * W) / 2);
      assert.ok(colored.points[3] > 0, 'slightly curved, like it wraps round the finger');
      assert.equal(colored.tension, 0.5);
    });
    it('a double band draws a second parallel strip', () => {
      const o = band(); Object.assign(o, { metadata: { ...o.metadata, band: { ...o.metadata.band, type: 'double' } } });
      assert.equal(all(renderShape(FingerBandShape, props(o)), 'Line').length, 3);
    });
    it('is easy to click (generous hit area) even when thin', () => {
      const o = band(); o.thickness = 1;
      const colored = all(renderShape(FingerBandShape, props(o)), 'Line').map((l) => l.props).find((l) => l.stroke === o.color);
      assert.ok(colored.hitStrokeWidth >= 16);
    });
    it('while dragging it is held ON the finger', () => {
      const view = 'left_front';
      const o = band(view, 'middle', 0.3);
      const group = first(renderShape(FingerBandShape, props(o, { canvas: canvasFor(view) })), 'Group').props;
      const node = fakeNode({ x: 0.9 * W, y: 0.2 * H });            // dragged far off the finger
      group.onDragMove({ target: node });
      assert.ok(node.positioned, 'position was corrected');
      const g = getGuide(view, 'middle');
      // the corrected point lies on the base->tip segment
      const bx = g.base.x * W; const by = g.base.y * H; const vx = (g.tip.x - g.base.x) * W; const vy = (g.tip.y - g.base.y) * H;
      const cross = ((node.positioned.x - bx) * vy - (node.positioned.y - by) * vx) / Math.hypot(vx, vy);
      assert.ok(Math.abs(cross) < 0.5, `distance from the finger axis: ${cross}px`);
    });
    it('dropping it records where along the SAME finger it now sits', () => {
      const changes = [];
      const o = band('left_front', 'middle', 0.3);
      const group = first(renderShape(FingerBandShape, props(o, { onChange: (p) => changes.push(p) })), 'Group').props;
      const target = axisPoint('left_front', 'middle', 0.75);
      group.onDragEnd({ target: fakeNode({ x: target.x * W, y: target.y * H }) });
      near(changes[0].metadata.band.position, 0.75, 0.01);
      assert.equal(changes[0].finger, 'middle');
      near(changes[0].x, target.x, 1e-3);
    });
    it('resizing changes the width and keeps it across the finger; turning it is recorded as an angle offset', () => {
      const changes = [];
      const o = band('left_front', 'index', 0.4);
      const group = first(renderShape(FingerBandShape, props(o, { onChange: (p) => changes.push(p) })), 'Group').props;
      const node = fakeNode({ sx: 1.25, sy: 1 }); node.rotation = () => o.rotation + 10;
      group.onTransformEnd({ target: node });
      near(changes[0].width, +(o.width * 1.25).toFixed(4), 1e-4);
      near(changes[0].metadata.band.rotationOffset, 10, 0.05);
      assert.equal(node.scaleX(), 1);
    });
  });

  describe('text drawing and handlers', () => {
    it('draws its content at the right font size, colour, place and angle', () => {
      const o = make('text', 'left_front', 0.5, 0.8);
      Object.assign(o, { color: '#111111', rotation: 20, opacity: 0.9, ...patchText(o, 'Hold 3 min') });
      const t = first(renderShape(TextShape, props(o)), 'Text').props;
      assert.deepEqual([t.text, t.fill, t.rotation, t.opacity, t.align], ['Hold 3 min', '#111111', 20, 0.9, 'center']);
      near(t.fontSize, o.width * W);
      near(t.x, 0.5 * W); near(t.y, 0.8 * H);
    });
    it('empty text is drawn as a space rather than crashing Konva', () => {
      const o = make('text'); Object.assign(o, patchText(o, ''));
      assert.equal(first(renderShape(TextShape, props(o)), 'Text').props.text, ' ');
    });
    it('resizing changes the font size; dragging changes the position', () => {
      const changes = [];
      const o = make('text');
      const t = first(renderShape(TextShape, props(o, { onChange: (p) => changes.push(p) })), 'Text').props;
      const node = fakeNode({ x: 0.2 * W, y: 0.3 * H, sx: 2, sy: 2 }); node.rotation = () => 15;
      t.onTransformEnd({ target: node });
      near(changes[0].width, +(o.width * 2).toFixed(4), 1e-4);
      assert.equal(changes[0].rotation, 15);
      t.onDragEnd({ target: fakeNode({ x: 0.6 * W, y: 0.7 * H }) });
      assert.deepEqual(changes[1], { x: 0.6, y: 0.7 });
    });
  });

  describe('the original shapes are unchanged in what they draw', () => {
    it('ring/dot/line/rectangle/triangle use the same geometry as before', () => {
      const dot = first(renderShape(ObjectRenderer, props(make('dot', 'left_front', 0.25, 0.75))), 'Circle').props;
      near(dot.x, 0.25 * W); near(dot.y, 0.75 * H); near(dot.radius, (0.03 / 2) * W);
      const rect = first(renderShape(ObjectRenderer, props(make('rectangle'))), 'Rect').props;
      near(rect.width, 0.16 * W); near(rect.height, 0.1 * H); near(rect.offsetX, (0.16 * W) / 2);
      const tri = first(renderShape(ObjectRenderer, props(make('invertedTriangle'))), 'RegularPolygon').props;
      assert.deepEqual([tri.sides, tri.rotation], [3, 180]);
      const line = first(renderShape(ObjectRenderer, props(make('vline'))), 'Line').props;
      assert.equal(line.rotation, 90);
    });
  });
});

describe('[DETERMINISTIC · canvas layer] one canvas and the 2x2 workspace', { skip: RENDER_SKIP }, () => {
  before(async () => {
    ({ default: HandCanvas } = await loadComponent('src/builder/HandCanvas.jsx'));
    ({ default: HandWorkspace } = await loadComponent('src/builder/HandWorkspace.jsx'));
    ({ default: PreviewMode } = await loadComponent('src/builder/PreviewMode.jsx'));
  });
  beforeEach(() => { api.reset(); S().loadProtocol(protocol()); resetKonva(); });

  const canvasCalls = (canvas, extra = {}) => { resetKonva(); const html = renderToStaticMarkup(h(HandCanvas, { canvas, maxWidth: 400, maxHeight: 500, ...extra })); return { html, calls: konvaCalls().map((c) => ({ name: c.name, props: c.props })) }; };
  const wsCalls = (extra = {}) => { resetKonva(); const html = renderToStaticMarkup(h(HandWorkspace, extra)); return { html, calls: konvaCalls().map((c) => ({ name: c.name, props: c.props })) }; };

  describe('a single canvas', () => {
    it('is scaled to fit inside the space it is given, keeping the image\'s proportions', () => {
      const c = S().canvases[0];
      const stage = first(canvasCalls(c).calls, 'Stage').props;
      assert.ok(stage.width <= 400 + 1e-6 && stage.height <= 500 + 1e-6);
      near(stage.width / stage.height, c.width / c.height, 1e-6, 'aspect ratio');
      near(stage.scaleX, stage.width / c.width, 1e-9);
      assert.ok(stage.width === 400 || stage.height === 500, 'uses all the room in one direction');
    });
    it('draws every object of THIS canvas only', () => {
      place('dot', 'left_front'); place('ring', 'right_front'); place('text', 'right_front');
      const counts = KEYS.map((k) => all(canvasCalls(S().canvases.find((c) => c.viewKey === k)).calls, 'Circle').length + all(canvasCalls(S().canvases.find((c) => c.viewKey === k)).calls, 'Text').length);
      assert.deepEqual(counts, [1, 2, 0, 0]);
    });
    it('shows the finger guides only while placing a band or with a band selected', () => {
      const c = () => S().canvases[0];
      const guides = (calls) => all(calls, 'Line').filter((l) => l.props.dash && l.props.stroke.startsWith('rgba(26,115,232,0.55'));
      assert.equal(guides(canvasCalls(c()).calls).length, 0);
      S().setActiveTool('fingerBand');
      assert.equal(guides(canvasCalls(c()).calls).length, 5, 'one per finger');
      S().setActiveTool('select');
      const p = axisPoint('left_front', 'index', 0.4);
      place('fingerBand', 'left_front', p.x, p.y);
      assert.equal(guides(canvasCalls(S().canvases[0]).calls).length, 5);
      assert.equal(guides(canvasCalls(S().canvases[0], { readOnly: true }).calls).length, 0, 'never in preview');
    });
    it('the grid is 18 faint lines and only when asked', () => {
      const gridLines = (calls) => all(calls, 'Line').filter((l) => String(l.props.stroke).startsWith('rgba(26,115,232,0.22'));
      assert.equal(gridLines(canvasCalls(S().canvases[0]).calls).length, 0);
      assert.equal(gridLines(canvasCalls(S().canvases[0], { showGrid: true }).calls).length, 18);
    });
    it('read-only (preview) switches off interaction for the whole layer and shows no handles', () => {
      place('dot', 'left_front');
      const c = S().canvases[0];
      assert.equal(first(canvasCalls(c).calls, 'Layer').props.listening, true);
      const ro = canvasCalls(c, { readOnly: true }).calls;
      assert.equal(first(ro, 'Layer').props.listening, false);
      assert.equal(all(ro, 'Transformer').every((t) => !t.props.enabledAnchors), true, 'no resize handles');
    });
    it('the selected object gets the right handles for its type', () => {
      const anchorsOf = (tool) => {
        S().loadProtocol(protocol());
        const p = axisPoint('left_front', 'index', 0.4);
        place(tool, 'left_front', p.x, p.y);
        const t = all(canvasCalls(S().canvases[0]).calls, 'Transformer').map((x) => x.props).find((x) => x.enabledAnchors);
        return t;
      };
      assert.deepEqual(anchorsOf('fingerBand').enabledAnchors, ['middle-left', 'middle-right']);
      assert.equal(anchorsOf('fingerBand').rotateEnabled, true);
      assert.equal(anchorsOf('dot').rotateEnabled, false, 'a circle has nothing to rotate');
      assert.equal(anchorsOf('dotRing').rotateEnabled, false);
      assert.equal(anchorsOf('dotRing').keepRatio, true);
      assert.equal(anchorsOf('text').keepRatio, true);
      assert.equal(anchorsOf('rectangle').enabledAnchors.length, 8);
      assert.equal(anchorsOf('freeline'), undefined, 'a free line is drag-only');
    });
    it('a selection in ANOTHER view gives this view no handles', () => {
      place('dot', 'right_back');
      const t = all(canvasCalls(S().canvases[0]).calls, 'Transformer').map((x) => x.props);
      assert.ok(t.every((x) => !x.enabledAnchors));
    });
  });

  describe('the workspace', () => {
    it('shows all four views, labelled, in a 2x2 grid, with their object counts', () => {
      place('dot', 'left_front'); place('ring', 'right_front'); place('dotRing', 'left_back'); place('text', 'right_back'); place('dot', 'right_back');
      const { html } = wsCalls();
      const labels = [...html.matchAll(/studio-cell-label">([^<]+)</g)].map((m) => m[1]);
      assert.deepEqual(labels, ['LEFT FRONT', 'RIGHT FRONT', 'LEFT BACK', 'RIGHT BACK']);
      assert.equal(count(html, '<section'), 4);
      assert.match(html, /grid-template-columns:repeat\(2, 1fr\)/);
      const badges = [...html.matchAll(/class="badge"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
      assert.deepEqual(badges, [1, 1, 1, 2]);
    });
    it('each canvas gets its own stage sized to fit its cell', () => {
      const stages = all(wsCalls().calls, 'Stage').map((s) => s.props);
      assert.equal(stages.length, 4);
      stages.forEach((s) => { assert.ok(s.width > 100 && s.width <= 432 + 1e-6, `width ${s.width}`); assert.ok(s.height <= 298 + 1e-6, `height ${s.height}`); });
    });
    it('the active view and the view holding the selection are highlighted', () => {
      place('ring', 'left_back');
      const html = wsCalls().html;
      assert.match(html, /studio-cell active has-selection[^>]*aria-label="left back"/);
      assert.equal(count(html, ' active'), 1 + count(html, 'tool-tile active'));
      assert.match(html, /studio-cell-label">LEFT BACK</);
    });
    it('can enlarge one view: only that view is shown, and it can go back to all four', () => {
      const { html, calls } = wsCalls({ focusedCanvasId: 'c-right_front', onFocusCanvas() {} });
      assert.equal(count(html, '<section'), 1);
      assert.match(html, /RIGHT FRONT/);
      assert.match(html, /Show all four/);
      assert.equal(all(calls, 'Stage').length, 1);
      assert.ok(all(calls, 'Stage')[0].props.width > all(wsCalls().calls, 'Stage')[0].props.width, 'the enlarged view is bigger');
      assert.match(wsCalls({ onFocusCanvas() {} }).html, /Enlarge/);
    });
    it('read-only mode has no controls and every layer is non-interactive', () => {
      const { html, calls } = wsCalls({ readOnly: true });
      assert.doesNotMatch(html, /Enlarge|<button/);
      assert.ok(all(calls, 'Layer').every((l) => l.props.listening === false));
      assert.equal(count(html, '<section'), 4);
    });
    it('flags a placeholder background image', () => {
      const p = protocol(); p.canvases[0].isPlaceholderAsset = true; S().loadProtocol(p);
      assert.match(wsCalls().html, /Placeholder image/);
    });
    it('a protocol with a different number of views lays out what it has (an organ protocol with one view)', () => {
      S().loadProtocol(protocol('organ', [canvasFor('left_front')]));
      const { html } = wsCalls();
      assert.equal(count(html, '<section'), 1);
      assert.match(html, /grid-template-columns:repeat\(1, 1fr\)/);
      assert.doesNotMatch(html, /Enlarge/, 'nothing to enlarge with a single view');
    });
    it('preview shows the four views without editing controls', () => {
      const html = renderToStaticMarkup(h(PreviewMode, { onExit() {} }));
      assert.match(html, /Preview/);
      assert.match(html, /Exit preview/);
      assert.equal(count(html, '<section'), 4);
      assert.doesNotMatch(html, /Enlarge/);
    });
  });
});

const count = (html, needle) => html.split(needle).length - 1;


// =====================================================================================================================
// Sharing/PDF task: attached rings, outlines, Extra Large and unlimited thickness — what the Studio canvas draws.
// =====================================================================================================================
describe('[DETERMINISTIC · canvas layer] attached rings, outlines and free thickness', { skip: RENDER_SKIP }, () => {
  let OR; let DR;
  before(async () => {
    ({ default: OR } = await loadComponent('src/builder/ObjectRenderer.jsx'));
    ({ default: DR } = await loadComponent('src/builder/shapes/DotRingShape.jsx'));
  });
  const noop = () => {};
  const cv = canvasFor('left_front');
  const props = (object, extra = {}) => ({ object, canvas: cv, isSelected: false, onSelect: noop, onChange: noop, nodeRef: noop, ...extra });
  const withRings = (n) => { let o = make('dotRing', 'left_front', 0.3, 0.6); for (let i = 1; i < n; i += 1) o = { ...o, ...addRing(o) }; return o; };

  describe('Dot + attached rings', () => {
    it('is ONE group: N ring circles then the dot on top, outermost ring first', () => {
      const o = withRings(4);
      const calls = renderShape(OR, props(o));
      assert.equal(all(calls, 'Group').length, 1, 'one group = one selectable object');
      const circles = all(calls, 'Circle').map((c) => c.props);
      assert.equal(circles.length, 5, '4 rings + the dot');
      const radii = circles.map((c) => c.radius);
      assert.deepEqual([...radii].sort((a, b) => b - a), radii, 'drawn from the outermost ring inward, the dot last (on top)');
      assert.equal(circles[4].fill, o.color, 'the last circle is the filled dot');
    });

    it('ZERO GAP, as drawn: each ring\'s inner edge is exactly the previous outer edge, and ring 1 touches the dot', () => {
      const o = withRings(6);
      const circles = all(renderShape(OR, props(o)), 'Circle').map((c) => c.props);
      const dot = circles[circles.length - 1];
      const rings = circles.slice(0, -1).reverse(); // innermost first
      near(rings[0].radius - rings[0].strokeWidth / 2, dot.radius, 1e-9, 'ring 1 inner edge = dot edge');
      rings.slice(1).forEach((r, i) => near(r.radius - r.strokeWidth / 2, rings[i].radius + rings[i].strokeWidth / 2, 1e-9, `ring ${i + 2} touches ring ${i + 1}`));
    });

    it('every ring is drawn in its OWN colour and thickness (independent of the dot and of each other)', () => {
      let o = withRings(3);
      o = { ...o, color: '#f76b15', ...patchRingAt(o, 0, { color: '#111111', thickness: 7 }) };
      o = { ...o, ...patchRingAt(o, 2, { color: '#12a594', thickness: 300 }) };
      const circles = all(renderShape(OR, props(o)), 'Circle').map((c) => c.props);
      const [r3, r2, r1, dot] = circles;
      assert.deepEqual([r1.stroke, r1.strokeWidth], ['#111111', 7]);
      assert.deepEqual([r2.stroke, r2.strokeWidth], [getRings(o)[1].color, getRings(o)[1].thickness]);
      assert.deepEqual([r3.stroke, r3.strokeWidth], ['#12a594', 300], 'a very thick ring is drawn at its full thickness');
      assert.equal(dot.fill, '#f76b15');
      circles.slice(0, 3).forEach((c) => assert.equal(c.fill, undefined, 'rings are never filled'));
    });

    it('a ring OUTLINE is an underlay drawn just beneath its own ring: outline colour, stroke = ring thickness + 2 × outline thickness', () => {
      let o = withRings(2);
      o = { ...o, ...patchRingAt(o, 1, { outline: { enabled: true, color: '#ffffff', thickness: 9 } }) };
      const circles = all(renderShape(OR, props(o)), 'Circle').map((c) => c.props);
      assert.equal(circles.length, 4, '2 rings + 1 outline underlay + the dot');
      const ring2 = getRings(o)[1];
      const under = circles[0];
      assert.deepEqual([under.stroke, under.strokeWidth], ['#ffffff', ring2.thickness + 18]);
      assert.equal(under.radius, circles[1].radius, 'same geometry as the ring it outlines');
      assert.equal(circles[1].stroke, ring2.color, 'and the ring itself is drawn right above it');
    });

    it('a DOT outline sits beneath the dot: outline colour fill + stroke of 2 × outline thickness', () => {
      let o = withRings(1);
      o = { ...o, ...patchOutline(o, { enabled: true, color: '#000000', thickness: 11 }) };
      const circles = all(renderShape(OR, props(o)), 'Circle').map((c) => c.props);
      const dotCircle = circles[circles.length - 1];
      const dotUnder = circles[circles.length - 2];
      assert.deepEqual([dotUnder.fill, dotUnder.stroke, dotUnder.strokeWidth], ['#000000', '#000000', 22]);
      assert.equal(dotUnder.radius, dotCircle.radius);
      assert.equal(dotCircle.fill, o.color);
    });

    it('with no outline anywhere, exactly N + 1 circles are drawn (no hidden extra nodes)', () => {
      assert.equal(all(renderShape(OR, props(withRings(5))), 'Circle').length, 6);
    });

    it('dragging commits the position only; the rings cannot be left behind', () => {
      const changes = [];
      const o = withRings(3);
      const group = first(renderShape(DR, props(o, { onChange: (p) => changes.push(p) })), 'Group').props;
      group.onDragEnd({ target: fakeNode({ x: 0.5 * cv.width, y: 0.25 * cv.height }) });
      assert.deepEqual(changes, [{ x: 0.5, y: 0.25 }]);
    });

    it('resizing scales the dot and EVERY ring thickness together (rings stay attached) and resets Konva\'s scale', () => {
      const changes = [];
      const o = withRings(3);
      const group = first(renderShape(DR, props(o, { onChange: (p) => changes.push(p) })), 'Group').props;
      const node = fakeNode({ x: 0.3 * cv.width, y: 0.6 * cv.height, sx: 2, sy: 2 });
      group.onTransformEnd({ target: node });
      assert.equal(node.scaleX(), 1);
      const patch = changes[0];
      assert.equal(patch.width, +(o.width * 2).toFixed(4));
      assert.deepEqual(patch.metadata.rings.map((r) => r.thickness), getRings(o).map((r) => r.thickness * 2));
    });

    it('the rings group is the only draggable thing: its circles are not individually draggable', () => {
      all(renderShape(OR, props(withRings(3))), 'Circle').forEach((c) => assert.notEqual(c.props.draggable, true));
    });

    it('an empty rings list draws a plain dot (no group)', () => {
      const o = { ...make('dot'), metadata: { sizePreset: 'medium', scale: 1, rings: [] } };
      const calls = renderShape(OR, props(o));
      assert.equal(first(calls, 'Group'), undefined);
      assert.equal(all(calls, 'Circle').length, 1);
    });
  });

  describe('outline on every other shape (an underlay beneath the shape, from the shared primitives)', () => {
    const TYPES = ['dot', 'ring', 'hline', 'vline', 'arrow', 'triangle', 'invertedTriangle', 'rectangle', 'square'];
    const strokeNodes = (calls) => calls.map((c) => c.props).filter((p) => p.stroke === '#00ff00');

    TYPES.forEach((tool) => {
      it(`${tool}: an active outline adds an underlay in the outline colour, beneath the shape; with it off, nothing extra is drawn`, () => {
        const plain = make(tool);
        const plainCalls = renderShape(OR, props(plain));
        assert.equal(strokeNodes(plainCalls).length, 0);
        const withOutline = { ...plain, ...patchOutline(plain, { enabled: true, color: '#00ff00', thickness: 13 }) };
        const calls = renderShape(OR, props(withOutline));
        const under = strokeNodes(calls);
        assert.ok(under.length >= 1, `${tool} has an outline underlay`);
        assert.ok(under.every((u) => u.listening === false), 'the underlay is never interactive');
        const own = Math.max(0, plain.thickness || 0);
        assert.ok(under.some((u) => u.strokeWidth === own + 26 || u.strokeWidth === 26), `${tool}: stroke = own stroke (${own}) + 2 × 13`);
        // the shape's own node is still there, and comes AFTER the underlay in draw order
        const names = calls.map((c) => c.name);
        assert.ok(names.length > plainCalls.length);
        assert.deepEqual(names.slice(-plainCalls.length), plainCalls.map((c) => c.name), 'the shape itself is drawn last, on top');
      });
    });

    it('a free line and a finger band get an outline underlay too', () => {
      let free = make('freeline'); free = { ...free, points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }] };
      const fo = { ...free, ...patchOutline(free, { enabled: true, color: '#00ff00', thickness: 5 }) };
      assert.ok(strokeNodes(renderShape(OR, props(fo))).length >= 1);
      const p = axisPoint('left_front', 'ring', 0.4);
      const band = make('fingerBand', 'left_front', p.x, p.y);
      const bo = { ...band, ...patchOutline(band, { enabled: true, color: '#00ff00', thickness: 6 }) };
      const under = strokeNodes(renderShape(OR, props(bo)));
      assert.ok(under.length >= 1);
      assert.ok(under.some((u) => u.strokeWidth === band.thickness + 12));
    });

    it('an object with no outline at all (anything saved before outlines existed) renders with NO underlay — exactly as before', () => {
      TYPES.forEach((tool) => {
        const calls = renderShape(OR, props(make(tool)));
        assert.equal(calls.filter((c) => c.props.listening === false).length, 0, `${tool}: no non-interactive underlay nodes`);
      });
    });

    it('text has no outline: switching one on in the data changes nothing it draws', () => {
      const t = make('text');
      const forced = { ...t, metadata: { ...t.metadata, outline: { enabled: true, color: '#00ff00', thickness: 9 } } };
      assert.equal(renderShape(OR, props(forced)).length, renderShape(OR, props(t)).length);
    });
  });

  describe('free thickness and Extra Large are drawn at their full value', () => {
    it('a line with a 50,000 px thickness is handed to Konva at exactly that thickness (nothing clamps it)', () => {
      const line = { ...make('hline'), ...patchThickness(make('hline'), 50000) };
      const l = first(renderShape(OR, props(line)), 'Line').props;
      assert.equal(l.strokeWidth, 50000);
    });
    it('an Extra Large dot is drawn larger than a Large one', () => {
      const d = make('dot');
      const big = (preset) => first(renderShape(OR, props({ ...d, ...M2.patchSizePreset(d, preset) })), 'Circle').props.radius;
      assert.ok(big('xl') > big('large'));
    });
  });
});
import * as M2 from '../src/builder/model/objectModel.js';
