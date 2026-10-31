/**
 * [DETERMINISTIC SOFTWARE TESTS — component rendering] The Studio's real React components (Properties panel, tool palette, size / thickness /
 * colour controls, bottom bar, protocol-details panel) are compiled and rendered to HTML in Node against the REAL store, and the HTML is checked.
 * This proves the panels build and show the right controls for each kind of selected object without runtime errors.
 * It does NOT test clicking (no browser), and Konva drawing is covered separately (studioCanvas.render.test.mjs).
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import useProtocolStore from '../src/builder/store.js';
import api from './support/stubs/apiClient.mjs';
import { loadComponent, RENDER_SKIP } from './support/renderJsx.mjs';
import { axisPoint } from '../src/builder/model/fingerGeometry.js';
import { patchText, patchSizePreset, patchRingColor, patchRingGapPreset, patchRingEnabled, addRing, patchRingAt, patchOutline, patchThickness } from '../src/builder/model/objectModel.js';

/** The HTML between one marker and the next, for scoping an assertion to one specific control among several similar ones on the page. */
const between = (html, startMarker, endMarker) => {
  const start = html.indexOf(startMarker);
  if (start === -1) return '';
  const end = html.indexOf(endMarker, start + startMarker.length);
  return html.slice(start, end === -1 ? undefined : end);
};

const S = () => useProtocolStore.getState();
const KEYS = ['left_front', 'right_front', 'left_back', 'right_back'];
const DIMS = [[1586, 1982], [1585, 1983], [1585, 1981], [1971, 2010]];
const protocol = (type = 'hand') => ({
  id: 'p', name: 'P', protocolType: type, currentVersion: 1, status: 'draft',
  canvases: KEYS.map((viewKey, i) => ({ id: `c-${viewKey}`, viewKey, canvasType: type, backgroundLabel: viewKey.replace('_', ' '), width: DIMS[i][0], height: DIMS[i][1], objects: [] })),
});
const place = (tool, viewKey, x = 0.4, y = 0.5) => { S().setActiveTool(tool); S().addObjectAtPoint(x, y, S().canvases.find((c) => c.viewKey === viewKey).id); return S().getSelectedObject(); };
const count = (html, needle) => html.split(needle).length - 1;

let ThicknessInput; let OutlineControl; let PropertiesPanel; let ToolPalette; let StudioBottomBar; let ProtocolMetadataPanel; let PresetScaleControl; let ColorPalette; let SizeControl; let ThicknessControl;
const render = (Component, props = {}) => renderToStaticMarkup(h(Component, props));

describe('[DETERMINISTIC · rendering] Studio panels', { skip: RENDER_SKIP }, () => {
  before(async () => {
    ({ default: PropertiesPanel } = await loadComponent('src/builder/PropertiesPanel.jsx'));
    ({ default: ToolPalette } = await loadComponent('src/builder/ToolPalette.jsx'));
    ({ default: StudioBottomBar } = await loadComponent('src/builder/StudioBottomBar.jsx'));
    ({ default: ProtocolMetadataPanel } = await loadComponent('src/builder/ProtocolMetadataPanel.jsx'));
    ({ default: PresetScaleControl } = await loadComponent('src/builder/panels/PresetScaleControl.jsx'));
    ({ default: ColorPalette } = await loadComponent('src/builder/panels/ColorPalette.jsx'));
    ({ default: SizeControl } = await loadComponent('src/builder/panels/SizeControl.jsx'));
    ({ default: ThicknessControl } = await loadComponent('src/builder/panels/ThicknessControl.jsx'));
    ({ default: ThicknessInput } = await loadComponent('src/builder/panels/ThicknessInput.jsx'));
    ({ default: OutlineControl } = await loadComponent('src/builder/panels/OutlineControl.jsx'));
  });
  beforeEach(() => { api.reset(); S().loadProtocol(protocol()); });

  describe('tool palette', () => {
    it('shows the 15 tools in order, with the active one marked', () => {
      const html = render(ToolPalette);
      const names = [...html.matchAll(/class="tool-name">([^<]+)</g)].map((m) => m[1]);
      assert.deepEqual(names, ['Select', 'Dot', 'Ring', 'Dot + Ring', 'Finger Band', 'H Line', 'V Line', 'Free Line', 'Inv. Triangle', 'Triangle', 'Rectangle', 'Square', 'Arrow', 'Text', 'Eraser']);
      assert.equal(count(html, 'aria-pressed="true"'), 1);
      assert.match(html, /tool-tile active"[^>]*aria-pressed="true"[^>]*title="Select"/);
    });
    it('marks the picked tool as active', () => {
      S().setActiveTool('dotRing');
      assert.match(render(ToolPalette), /aria-pressed="true"[^>]*title="Dot \+ Ring"/);
    });
    it('offers the Finger Band only on hand protocols', () => {
      assert.doesNotMatch(render(ToolPalette), /title="Finger Band"[^>]*disabled|disabled[^>]*title="Finger Band"/);
      S().loadProtocol(protocol('organ'));
      assert.match(render(ToolPalette), /disabled[^>]*title="Finger Band is only available on hand protocols"|title="Finger Band is only available on hand protocols"[^>]*disabled/);
    });
  });

  describe('properties panel: nothing selected', () => {
    it('tells the doctor to select something on any of the four views', () => {
      const html = render(PropertiesPanel);
      assert.match(html, /Select an object on any of the four views/);
      assert.equal(count(html, 'palette-swatch'), 0);
    });
  });

  describe('properties panel: a plain dot', () => {
    it('shows colour palette, size preset + scale, ring switch, opacity — and no thickness or rotation', () => {
      place('dot', 'left_front');
      const html = render(PropertiesPanel);
      assert.match(html, /<strong>Dot<\/strong>/);
      assert.match(html, /class="pill"[^>]*>left front</, 'names the view the object is on');
      assert.equal(count(html, 'class="palette-swatch'), 14, 'the full palette');
      assert.match(html, /aria-label="Custom colour"/);
      ['Small', 'Medium', 'Large', 'Extra Large'].forEach((p) => assert.match(html, new RegExp(`>${p}</button>`)));
      assert.match(html, /aria-label="Size custom scale"[^>]*min="0.25"[^>]*max="3"|min="0.25"[^>]*max="3"[^>]*aria-label="Size custom scale"/);
      assert.match(html, />\+ Add Ring</, 'a plain dot can get rings');
      assert.doesNotMatch(html, /<span>Thickness<\/span>/, 'a dot has no thickness of its own');
      assert.doesNotMatch(html, /aria-label="Rotation"/, 'a dot has nothing to rotate');
      assert.match(html, /aria-label="Opacity"/);
      assert.match(html, /Finger \(optional\)/);
      ['Duplicate', 'Copy', 'Delete'].forEach((a) => assert.match(html, new RegExp(`>${a}</button>`)));
    });
    it('Extra Large can be chosen and is shown as the active size', () => {
      const o = place('dot', 'left_front');
      S().commitObjectChange(o.id, patchSizePreset(o, 'xl'));
      assert.match(render(PropertiesPanel), /aria-pressed="true"[^>]*>Extra Large</);
    });
    it('marks Medium as the chosen preset for a new object and shows 100%', () => {
      place('dot', 'left_front');
      const html = render(PropertiesPanel);
      assert.match(html, /aria-pressed="true"[^>]*>Medium</);
      assert.match(html, /<output class="range-value">100%<\/output>/);
    });
    it('reflects a changed preset', () => {
      const o = place('dot', 'left_front');
      S().commitObjectChange(o.id, patchSizePreset(o, 'large'));
      assert.match(render(PropertiesPanel), /aria-pressed="true"[^>]*>Large</);
    });
  });

  describe('properties panel: Dot + attached rings', () => {
    it('shows separate DOT and per-RING controls for one object: colour, thickness and outline for each ring, plus + Add Ring — and no gap control', () => {
      place('dotRing', 'left_back');
      const html = render(PropertiesPanel);
      assert.match(html, /<strong>Dot \+ Ring<\/strong>/);
      assert.match(html, /class="pill"[^>]*>left back</);
      ['Dot colour', 'Dot size', 'Dot outline', 'Ring 1 colour', 'Ring 1 thickness', 'Ring 1 outline'].forEach((label) => assert.ok(html.includes(label), label));
      assert.match(html, />\+ Add Ring</);
      assert.match(html, /aria-label="Remove ring 1"/);
      assert.doesNotMatch(html, /Ring gap|aria-label="[^"]*gap[^"]*"/i, 'there is no gap slider, preset or input anywhere');
      assert.doesNotMatch(html, /Ring size|Ring 1 size/, 'a ring has no size of its own: it is its thickness, attached to what is inside it');
      assert.equal(count(html, 'class="palette-swatch'), 28, 'a palette for the dot and one for ring 1');
    });

    it('the heading says "Dot + Rings" once there is more than one, and every ring gets its own full set of controls', () => {
      const o = place('dotRing', 'left_back');
      let cur = o;
      for (let i = 0; i < 3; i += 1) { S().commitObjectChange(o.id, addRing(cur)); cur = S().canvases.flatMap((c) => c.objects).find((x) => x.id === o.id); }
      const html = render(PropertiesPanel);
      assert.match(html, /<strong>Dot \+ Rings<\/strong>/);
      [1, 2, 3, 4].forEach((n) => ['colour', 'thickness', 'outline'].forEach((what) => assert.ok(html.includes(`Ring ${n} ${what}`), `Ring ${n} ${what}`)));
      assert.equal(count(html, 'aria-label="Remove ring'), 4);
      assert.equal(count(html, '>+ Add Ring<'), 1, 'one Add Ring button, not one per ring');
    });

    it('there is no ring-count limit in the panel: 30 rings are all listed and + Add Ring is still offered', () => {
      const o = place('dotRing', 'left_back');
      let cur = o;
      for (let i = 0; i < 29; i += 1) { S().commitObjectChange(o.id, addRing(cur)); cur = S().canvases.flatMap((c) => c.objects).find((x) => x.id === o.id); }
      const html = render(PropertiesPanel);
      assert.ok(html.includes('Ring 30 colour'));
      assert.equal(count(html, '>+ Add Ring<'), 1);
      assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>\+ Add Ring/);
    });

    it('Dot = RED and Ring 1 = BLUE render as exactly that combination, independently', () => {
      const o = place('dotRing', 'left_back');
      S().commitObjectChange(o.id, { color: '#e5484d' });
      const afterColor = S().canvases.flatMap((c) => c.objects).find((x) => x.id === o.id);
      S().commitObjectChange(o.id, patchRingAt(afterColor, 0, { color: '#1a73e8' }));
      const html = render(PropertiesPanel);
      const dotSection = between(html, 'aria-label="Dot colour palette"', 'aria-label="Ring 1 colour palette"');
      const ringSection = between(html, 'aria-label="Ring 1 colour palette"', 'Ring 1 thickness');
      assert.match(dotSection, /title="Red"[^>]*aria-pressed="true"/);
      assert.doesNotMatch(dotSection, /title="Blue"[^>]*aria-pressed="true"/);
      assert.match(dotSection, /Custom · Red/);
      assert.match(ringSection, /title="Blue"[^>]*aria-pressed="true"/);
      assert.doesNotMatch(ringSection, /title="Red"[^>]*aria-pressed="true"/);
      assert.match(ringSection, /Custom · Blue/);
    });

    it('a ring\'s thickness field shows its real value and has NO maximum, even for an enormous ring', () => {
      const o = place('dotRing', 'left_back');
      S().commitObjectChange(o.id, patchRingAt(o, 0, { thickness: 450000 }));
      const html = render(PropertiesPanel);
      const input = html.match(/<input[^>]*aria-label="Ring 1 thickness"[^>]*>/)[0];
      assert.match(input, /value="450000"/);
      assert.doesNotMatch(input, /max=/);
    });

    it('a ring outline shows its colour and thickness controls only while it is switched on', () => {
      const o = place('dotRing', 'left_back');
      const off = render(PropertiesPanel);
      assert.ok(off.includes('Ring 1 outline enabled'));
      assert.ok(!off.includes('Ring 1 outline colour') && !off.includes('Ring 1 outline thickness'));
      S().commitObjectChange(o.id, patchRingAt(o, 0, { outline: { enabled: true, color: '#000000', thickness: 8 } }));
      const on = render(PropertiesPanel);
      assert.ok(on.includes('Ring 1 outline colour') && on.includes('Ring 1 outline thickness'));
      assert.match(on.match(/<input[^>]*aria-label="Ring 1 outline thickness"[^>]*>/)[0], /value="8"/);
    });

    it('an older single-ring object shows the "older format" card with a Convert button — and still offers + Add Ring (which converts it)', () => {
      const d = place('dot', 'left_back');
      S().commitObjectChange(d.id, patchRingEnabled(d, true));
      const html = render(PropertiesPanel);
      assert.match(html, /<strong>Dot \+ Ring<\/strong>/);
      assert.match(html, /Ring \(older format\)/);
      assert.match(html, />Convert to attached rings</);
      assert.match(html, />\+ Add Ring</);
      assert.doesNotMatch(html, /Ring 1 colour/, 'it has not been converted just by being opened');
    });

    it('a dot with an empty ring list is shown as a plain Dot again', () => {
      const o = place('dotRing', 'left_back');
      S().commitObjectChange(o.id, { metadata: { ...o.metadata, rings: [] } });
      const html = render(PropertiesPanel);
      assert.match(html, /<strong>Dot<\/strong>/);
      assert.doesNotMatch(html, /Ring 1/);
    });
  });

  describe('properties panel: other object types', () => {
    it('a ring has a FREE thickness number (no maximum, no preset/scale) but no rotation', () => {
      place('ring', 'right_front');
      const html = render(PropertiesPanel);
      assert.match(html, /<span>Thickness<\/span>/);
      assert.doesNotMatch(html, /aria-label="Thickness custom scale"/, 'thickness is no longer a preset + scale');
      const input = html.match(/<input[^>]*aria-label="Thickness"[^>]*>/)[0];
      assert.match(input, /type="number"/);
      assert.doesNotMatch(input, /max=/, 'there is no artificial maximum');
      assert.doesNotMatch(html, /aria-label="Rotation"/);
      assert.doesNotMatch(html, />\+ Add Ring</, 'only a dot can have rings');
    });
    it('a line has size, thickness and rotation', () => {
      place('hline', 'left_front');
      const html = render(PropertiesPanel);
      assert.match(html, /aria-label="Rotation"/);
      assert.match(html, /<span>Thickness<\/span>/);
    });
    it('a free line has thickness but no size (it has no natural size)', () => {
      const o = place('freeline', 'left_front');
      assert.ok(o);
      const html = render(PropertiesPanel);
      assert.doesNotMatch(html, /aria-label="Size custom scale"/);
      assert.match(html, /<span>Thickness<\/span>/);
    });
    it('an object saved before the Studio (no presets) still opens, as Medium at its derived scale', () => {
      const p = protocol();
      p.canvases[0].objects = [{ id: 'legacy', type: 'hline', x: 0.4, y: 0.4, width: 0.27, height: null, rotation: 0, color: '#123456', thickness: 3, opacity: 1, points: null, finger: 'pinky', landmarkReference: null, metadata: {}, zIndex: 1 }];
      S().loadProtocol(p);
      S().selectObject('legacy');
      const html = render(PropertiesPanel);
      assert.match(html, /aria-pressed="true"[^>]*>Medium</);
      assert.match(html, /<output class="range-value">150%<\/output>/, '0.27 / 0.18');
      assert.match(html, /<option value="little" selected="">Little<\/option>/, 'legacy "pinky" is shown as little');
      assert.deepEqual(S().canvases[0].objects[0].metadata, {}, 'opening it rewrote nothing');
    });
  });

  describe('properties panel: Finger Band', () => {
    const band = (finger = 'ring', t = 0.4) => { const p = axisPoint('right_back', finger, t); return place('fingerBand', 'right_back', p.x, p.y); };
    it('shows the finger, position, band type, angle and fit — and not the generic finger dropdown', () => {
      band();
      const html = render(PropertiesPanel);
      assert.match(html, /<strong>Finger Band<\/strong>/);
      assert.match(html, /class="pill"[^>]*>right back</);
      assert.match(html, /<legend>Finger band<\/legend>/);
      assert.equal(count(html, '<option value="thumb"'), 1);
      ['thumb', 'index', 'middle', 'ring', 'little'].forEach((f) => assert.match(html, new RegExp(`<option value="${f}"`)));
      assert.match(html, /<option value="ring" selected="">Ring<\/option>/);
      assert.match(html, /aria-label="Position along finger"/);
      assert.match(html, /<output class="range-value">40%<\/output>/);
      assert.match(html, /Plain band/);
      assert.match(html, /Double band/);
      assert.match(html, /aria-label="Angle across the finger"/);
      assert.match(html, /Fit width to finger/);
      assert.match(html, /Band width/);
      assert.doesNotMatch(html, /Finger \(optional\)/);
      assert.doesNotMatch(html, /aria-label="Rotation"/, 'rotation is the angle across the finger for a band');
    });
    it('says plainly how the camera treats a band (it follows its finger\'s bones — AR mapping now exists)', () => {
      band();
      assert.match(render(PropertiesPanel), /On the camera, a band follows its finger&#x27;s bones|On the camera, a band follows its finger's bones/);
      assert.match(render(PropertiesPanel), /Camera anchor/);
    });
  });

  describe('properties panel: text', () => {
    it('shows an editable text box with a character counter', () => {
      const o = place('text', 'left_front');
      S().commitObjectChange(o.id, patchText(o, 'Hold 3 min'));
      const html = render(PropertiesPanel);
      assert.match(html, /<textarea[^>]*aria-label="Text content"[^>]*>Hold 3 min<\/textarea>/);
      assert.match(html, /10\/200 characters/);
      assert.match(html, />Text size</);
      assert.match(html, /aria-label="Rotation"/);
    });
    it('hostile text content is shown escaped, never as markup', () => {
      const o = place('text', 'left_front');
      S().commitObjectChange(o.id, patchText(o, '</textarea><script>alert(1)</script><img src=x onerror=alert(1)>'));
      const html = render(PropertiesPanel);
      assert.doesNotMatch(html, /<script>alert/);
      assert.doesNotMatch(html, /<img src=x/);
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    });
  });

  describe('properties panel: which view', () => {
    it('shows an object from a NON-active view and names its view', () => {
      const o = place('ring', 'right_back');
      S().focusCanvas('c-left_front');            // another view becomes the working view
      S().selectObject(o.id);                      // selecting brings its own view forward
      const html = render(PropertiesPanel);
      assert.match(html, /class="pill"[^>]*>right back</);
      assert.match(html, /<strong>Ring \/ Circle<\/strong>/);
    });
  });

  describe('controls', () => {
    it('the size control offers exactly Small / Medium / Large / Extra Large and a bounded scale', () => {
      const html = render(PresetScaleControl, { label: 'Size', preset: 'small', scale: 0.5, onPreset() {}, onScale() {} });
      assert.deepEqual([...html.matchAll(/<button type="button"[^>]*>(Small|Medium|Large|Extra Large|[^<]+)<\/button>/g)].map((m) => m[1]).slice(0, 4), ['Small', 'Medium', 'Large', 'Extra Large']);
      assert.match(html, /aria-pressed="true"[^>]*>Small</);
      assert.match(html, /<output class="range-value">50%<\/output>/);
    });
    it('the − / + buttons stop at the scale limits', () => {
      assert.match(render(PresetScaleControl, { label: 'Size', preset: 'medium', scale: 0.25, onPreset() {}, onScale() {} }), /aria-label="Decrease size scale" disabled/);
      assert.match(render(PresetScaleControl, { label: 'Size', preset: 'medium', scale: 3, onPreset() {}, onScale() {} }), /aria-label="Increase size scale" disabled/);
    });
    it('the colour palette marks the current colour, keeps a custom picker, and lists every configured colour', () => {
      const html = render(ColorPalette, { value: '#1A73E8', onChange() {} });
      assert.equal(count(html, 'class="palette-swatch'), 14);
      assert.match(html, /title="Blue"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*title="Blue"/, 'matching is case-insensitive');
      assert.match(html, /type="color"/);
    });
    it('SizeControl and ThicknessControl render from a real object', () => {
      const o = place('ring', 'left_front');
      assert.match(render(SizeControl, { object: o, onCommit() {} }), /Size/);
      assert.match(render(ThicknessControl, { object: o, onCommit() {} }), /Thickness/);
    });
  });

  describe('thickness input and outline control', () => {
    it('ThicknessInput shows the value, a number field with a minimum but NO maximum, and − / + steppers', () => {
      const html = render(ThicknessInput, { label: 'Thickness', value: 12, onCommit() {} });
      const input = html.match(/<input[^>]*>/)[0];
      assert.match(input, /type="number"/);
      assert.match(input, /value="12"/);
      assert.match(input, /min="0.5"/);
      assert.doesNotMatch(input, /max=/);
      assert.match(html, /aria-label="Decrease Thickness"/);
      assert.match(html, /aria-label="Increase Thickness"/);
      assert.doesNotMatch(html, /disabled/, 'the + button is never disabled: there is no upper limit');
    });
    it('ThicknessInput shows an enormous value as typed (no clamping in the display)', () => {
      assert.match(render(ThicknessInput, { label: 'Thickness', value: 123456789, onCommit() {} }), /value="123456789"/);
    });
    it('OutlineControl: off shows only the switch; on shows colour palette + thickness, all independently labelled', () => {
      const off = render(OutlineControl, { label: 'Outline', outline: { enabled: false, color: '#000000', thickness: 4 }, onChange() {} });
      assert.match(off, /aria-label="Outline enabled"/);
      assert.doesNotMatch(off, /checked=""/);
      assert.doesNotMatch(off, /palette-swatch|type="number"/);
      const on = render(OutlineControl, { label: 'Outline', outline: { enabled: true, color: '#12a594', thickness: 6 }, onChange() {} });
      assert.match(on, /checked=""/);
      assert.equal(count(on, 'class="palette-swatch'), 14);
      assert.match(on, /Custom · Teal/);
      assert.match(on.match(/<input[^>]*aria-label="Outline thickness"[^>]*>/)[0], /value="6"/);
    });
    it('every shape that supports an outline shows the Outline control in its panel; text does not', () => {
      ['dot', 'ring', 'hline', 'vline', 'arrow', 'freeline', 'triangle', 'invertedTriangle', 'rectangle', 'square'].forEach((tool) => {
        S().loadProtocol(protocol());
        place(tool, 'left_front');
        assert.match(render(PropertiesPanel), /Outline enabled/, tool);
      });
      S().loadProtocol(protocol());
      place('text', 'left_front');
      assert.doesNotMatch(render(PropertiesPanel), /Outline enabled/);
    });
    it('the panel reflects an object\'s outline settings and an enormous thickness', () => {
      const line = place('hline', 'left_front');
      S().commitObjectChange(line.id, patchThickness(line, 98765));
      const cur = S().canvases.flatMap((c) => c.objects).find((x) => x.id === line.id);
      S().commitObjectChange(line.id, patchOutline(cur, { enabled: true, color: '#12a594', thickness: 31 }));
      const html = render(PropertiesPanel);
      assert.match(html.match(/<input[^>]*aria-label="Thickness"[^>]*>/)[0], /value="98765"/);
      assert.match(html.match(/<input[^>]*aria-label="Outline thickness"[^>]*>/)[0], /value="31"/);
      assert.match(html, /Custom · Teal/);
    });
  });

  describe('bottom bar', () => {
    it('undo/redo/copy/paste/duplicate/delete start disabled, and the grid switch is offered', () => {
      const html = render(StudioBottomBar, { showGrid: false, onToggleGrid() {} });
      ['Undo', 'Redo', 'Copy', 'Paste', 'Duplicate', 'Delete'].forEach((label) => assert.match(html, new RegExp(`disabled=""[^>]*>[^<]*${label}<`)));
      assert.match(html, /Grid \(not saved\)/);
    });
    it('enables them once there is something to act on', () => {
      place('dot', 'left_front');
      const html = render(StudioBottomBar, { showGrid: true, onToggleGrid() {} });
      assert.doesNotMatch(html, /disabled=""[^>]*>Duplicate</);
      assert.doesNotMatch(html, /disabled=""[^>]*>↶ Undo</);
      assert.match(html, /disabled=""[^>]*>↷ Redo</);
    });
  });
});

describe('[DETERMINISTIC · rendering] protocol details panel', { skip: RENDER_SKIP }, () => {
  let Panel;
  before(async () => { ({ default: Panel } = await loadComponent('src/builder/ProtocolMetadataPanel.jsx')); });
  const noop = () => {};
  const fakeMeta = (over = {}, protocolOver = {}) => ({
    loading: false, busy: false, error: null, problems: [], dirty: false, setField: noop,
    meta: { id: 'p', name: 'Headache', slug: 'headache-relief', status: 'draft', currentVersion: 4, published: null, hasUnpublishedChanges: false, conditions: [{ id: 'c1', name: 'Migraine' }], searchTerms: [{ id: 't1', term: 'head ache', kind: 'synonym' }], ...protocolOver },
    draft: { displayName: 'Headache relief', shortDescription: 'Short', description: 'Long text', categoryId: 'k1' },
    categories: [{ id: 'k1', name: 'Head', isActive: true }, { id: 'k2', name: 'Old', isActive: false }],
    conditions: [{ id: 'c1', name: 'Migraine', isActive: true }, { id: 'c2', name: 'Tension headache', isActive: true }],
    versions: [{ version: 4, kind: 'checkpoint', isCurrentlyPublished: false, createdAt: '2026-09-28 10:00:00' }, { version: 3, kind: 'published', isCurrentlyPublished: true, createdAt: '2026-09-27 10:00:00' }],
    addTerm: noop, removeTerm: noop, attachCondition: noop, detachCondition: noop, createCondition: noop, createCategory: noop, changeStatus: noop, archive: noop, publish: noop, restoreVersion: noop,
    ...over,
  });
  const show = (meta, isAdmin = true) => renderToStaticMarkup(h(Panel, { isAdmin, meta, onPublish: noop, onRestore: noop }));

  // ---------------------------------------------------------------- the DOCTOR's view of their own protocol
  const showDoctor = (meta, extra = {}) => renderToStaticMarkup(h(Panel, { isAdmin: false, canManage: true, meta, onPublish: noop, onRestore: noop, onSave: noop, origin: 'https://clinic.example', ...extra }));
  const PUBLISHED = { status: 'published', published: { version: 3 } };

  it('DOCTOR: sees the details of their own protocol, and the old "publishing is managed by an administrator" notice is gone', () => {
    const html = showDoctor(fakeMeta());
    ['Display name', 'Short description', 'Description', 'Category', 'Conditions', 'Search terms', 'Status &amp; publishing'].forEach((label) => assert.ok(html.includes(label), label));
    assert.doesNotMatch(html, /publishing are managed by an administrator/);
    assert.doesNotMatch(html, /Protocol details \(category, conditions, search terms\)/);
    assert.match(html, /You can publish your own protocols/);
    assert.match(html, /value="Headache relief"/);
    assert.match(html, /<option value="k1" selected="">Head<\/option>/);
    assert.match(html, /Migraine/);
    assert.match(html, /head ache/);
    assert.match(html, /<option value="c2">Tension headache<\/option>/, 'the doctor can link another existing condition');
  });
  it('DOCTOR draft: Save Draft and Publish Protocol are there; nothing public is shown yet', () => {
    const html = showDoctor(fakeMeta());
    assert.match(html, />Save Draft</);
    assert.match(html, />Publish Protocol</);
    assert.match(html, /<span class="pill ">Draft<\/span>/);
    assert.doesNotMatch(html, /<legend>Share<\/legend>|Copy Share Link|Open Public Protocol|Download PDF|✓ Published/, 'a draft has no public link and no PDF');
  });
  it('DOCTOR: admin-only controls are not offered — new categories / conditions, status changes, archive, version history, restore', () => {
    for (const html of [showDoctor(fakeMeta()), showDoctor(fakeMeta({}, PUBLISHED)), showDoctor(fakeMeta({}, { status: 'in_review' }))]) {
      assert.doesNotMatch(html, /Send to review|Back to draft|Return to draft|>Archive<|Version history|>Restore<|New category|New condition|Add &amp; link/);
    }
    assert.match(showDoctor(fakeMeta()), /Categories are managed by an administrator/, 'the doctor is told why, for the right things');
    assert.match(showDoctor(fakeMeta()), /Conditions are managed by an administrator/);
  });
  it('DOCTOR: Save Draft is disabled until there is something to save, shows "Saving…" while saving, and is wired to onSave', () => {
    assert.match(showDoctor(fakeMeta(), { hasChanges: false }), /<button[^>]*disabled=""[^>]*>Save Draft</);
    assert.doesNotMatch(showDoctor(fakeMeta(), { hasChanges: true }), /<button[^>]*disabled=""[^>]*>Save Draft</);
    assert.match(showDoctor(fakeMeta(), { hasChanges: true, saving: true }), />Saving…</);
  });
  it('DOCTOR published: "✓ Published", Publish New Version, and the three share actions — Copy Share Link, Open Public Protocol, Download PDF', () => {
    const html = showDoctor(fakeMeta({}, PUBLISHED));
    assert.match(html, /<strong>✓ Published<\/strong> — version v3 is live/);
    assert.match(html, />Publish New Version</);
    assert.doesNotMatch(html, />Publish Protocol</);
    assert.match(html, /<legend>Share<\/legend>/);
    assert.match(html.match(/<input[^>]*aria-label="Public protocol link"[^>]*>/)[0], /value="https:\/\/clinic\.example\/protocols\/headache-relief"/, 'the existing public route, never the Studio');
    assert.match(html, />Copy Share Link</);
    assert.match(html, /<a [^>]*href="\/protocols\/headache-relief"[^>]*target="_blank"[^>]*>Open Public Protocol</);
    assert.match(html, />Download PDF</);
    assert.match(html, /made from the published version \(v3\), never from your unsaved edits/);
  });
  it('DOCTOR: Download PDF exists ONLY while a published version exists (draft, in review, archived, or a missing published pointer: no PDF)', () => {
    assert.match(showDoctor(fakeMeta({}, PUBLISHED)), />Download PDF</);
    for (const over of [{ status: 'draft' }, { status: 'in_review' }, { status: 'archived', published: { version: 3 } }, { status: 'published', published: null }]) {
      assert.doesNotMatch(showDoctor(fakeMeta({}, over)), />Download PDF</, JSON.stringify(over));
    }
  });
  it('DOCTOR published with later edits: the panel says the link keeps showing the published version until they publish again', () => {
    const html = showDoctor(fakeMeta({}, { ...PUBLISHED, hasUnpublishedChanges: true }));
    assert.match(html, /There are unpublished changes/);
    assert.match(html, /link still shows the published version until you publish again/);
    assert.match(html, />Publish New Version</);
  });
  it('DOCTOR: an in-review protocol can be published; an archived one cannot and says why', () => {
    assert.match(showDoctor(fakeMeta({}, { status: 'in_review' })), />Publish Protocol</);
    const archived = showDoctor(fakeMeta({}, { status: 'archived' }));
    assert.doesNotMatch(archived, />Publish Protocol</);
    assert.match(archived, /archived, so it is not public\. An administrator can return it to draft/);
  });
  it('DOCTOR: a failed publish is explicit — the error and every validation problem are listed, nothing is hidden', () => {
    const html = showDoctor(fakeMeta({ error: 'The protocol failed validation and was not published.', problems: [{ path: 'x', message: 'Object 2: ring 1 thickness must be a finite number above 0.' }] }));
    assert.match(html, /role="alert">The protocol failed validation and was not published\./);
    assert.match(html, /aria-label="Problems that stopped publishing"/);
    assert.match(html, /ring 1 thickness must be/);
  });
  it('DOCTOR: the protocol\'s current category stays selectable even if the catalog no longer offers it', () => {
    const html = showDoctor(fakeMeta({ categories: [{ id: 'k9', name: 'Other', isActive: true }] }, { category: { id: 'k1', name: 'Head', isActive: false } }));
    assert.match(html, /<option value="k1" selected="">Head \(inactive\)<\/option>/);
  });
  it('a user who may not manage protocol details (neither doctor nor admin) gets a neutral message and no controls', () => {
    const html = showDoctor(fakeMeta(), { canManage: false });
    assert.match(html, /available to doctors and administrators/);
    assert.doesNotMatch(html, /Publish|Save Draft|Category|Share/);
  });
  it('ADMIN is unchanged and also gets the clear published state and the PDF / share actions', () => {
    const html = show(fakeMeta({}, PUBLISHED));
    assert.match(html, /✓ Published/);
    assert.match(html, />Copy Share Link</);
    assert.match(html, />Download PDF</);
    assert.match(html, />Publish changes</, 'admin keeps its own wording');
    assert.match(html, /Version history/);
    assert.match(html, /Send to review|Archive/);
    assert.match(html, /New category/);
    assert.doesNotMatch(html, /Save Draft/, 'Save Draft is a doctor-side convenience; admins keep the top-bar Save');
  });
  it('an admin sees every field the publishing foundation defines', () => {
    const html = show(fakeMeta());
    ['Display name', 'Short description', 'Description', 'Category', 'Conditions', 'Search terms', 'Status &amp; publishing', 'Version history'].forEach((label) => assert.ok(html.includes(label), label));
    assert.match(html, /value="Headache relief"/);
    assert.match(html, /<option value="k1" selected="">Head<\/option>/);
    assert.match(html, /Migraine/);
    assert.match(html, /head ache/);
    assert.match(html, /<option value="c2">Tension headache<\/option>/, 'only conditions not yet linked are offered');
    assert.doesNotMatch(html, /<option value="c1">/);
  });
  it('draft: can be sent to review or published; published: offers "Publish changes" and shows unpublished changes', () => {
    assert.match(show(fakeMeta()), /Send to review/);
    assert.match(show(fakeMeta()), />Publish</);
    const pub = show(fakeMeta({}, { status: 'published', published: { version: 3 }, hasUnpublishedChanges: true }));
    assert.match(pub, /Publish changes/);
    assert.match(pub, /There are unpublished changes/);
    assert.match(pub, /Published version v3/);
  });
  it('archived: can only return to draft (no publish)', () => {
    const html = show(fakeMeta({}, { status: 'archived' }));
    assert.match(html, /Return to draft/);
    assert.doesNotMatch(html, />Publish</);
  });
  it('publish problems are listed in plain language', () => {
    const html = show(fakeMeta({ error: 'This protocol cannot be published yet.', problems: [{ path: 'x', message: 'Object 1: a text object needs some text.' }] }));
    assert.match(html, /cannot be published yet/);
    assert.match(html, /a text object needs some text/);
  });
  it('version history marks the live version and offers Restore', () => {
    const html = show(fakeMeta());
    assert.match(html, /v3<\/strong> · published · live/);
    assert.equal(count(html, '>Restore<'), 2);
  });
  it('SHARE: a published protocol shows its public link (the existing /protocols/:slug route), Copy Share Link and Open Public Protocol', () => {
    const html = renderToStaticMarkup(h(Panel, { isAdmin: true, meta: fakeMeta({}, { status: 'published', published: { version: 3 } }), onPublish: noop, onRestore: noop, origin: 'https://clinic.example' }));
    assert.match(html, /<legend>Share<\/legend>/);
    assert.match(html.match(/<input[^>]*aria-label="Public protocol link"[^>]*>/)[0], /value="https:\/\/clinic\.example\/protocols\/headache-relief"/);
    assert.match(html, />Copy Share Link</);
    assert.match(html, /<a [^>]*href="\/protocols\/headache-relief"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Open Public Protocol</);
    assert.match(html, /version v3/);
    assert.match(html, /Drafts and unpublished edits are never visible/);
  });
  it('SHARE: nothing to share for a draft, an in-review or an archived protocol (their public link does not resolve)', () => {
    ['draft', 'in_review', 'archived'].forEach((status) => {
      const html = renderToStaticMarkup(h(Panel, { isAdmin: true, meta: fakeMeta({}, { status }), onPublish: noop, onRestore: noop }));
      assert.doesNotMatch(html, /<legend>Share<\/legend>|Copy Share Link|Open Public Protocol|Download PDF/, status);
    });
  });
  it('SHARE: while there are unpublished changes the panel says the link still shows the published version', () => {
    const html = renderToStaticMarkup(h(Panel, { isAdmin: true, meta: fakeMeta({}, { status: 'published', published: { version: 3 }, hasUnpublishedChanges: true }), onPublish: noop, onRestore: noop }));
    assert.match(html, /link still shows the published version until you publish again/);
  });
  it('SHARE: someone who may not manage the protocol (neither doctor nor admin) never sees sharing controls', () => {
    const html = renderToStaticMarkup(h(Panel, { isAdmin: false, meta: fakeMeta({}, { status: 'published' }), onPublish: noop, onRestore: noop }));
    assert.doesNotMatch(html, /Copy Share Link|Open Public Protocol|Download PDF/);
  });
  it('shows whether metadata edits are saved', () => {
    assert.match(show(fakeMeta({ dirty: true })), /Unsaved changes/);
    assert.match(show(fakeMeta({ dirty: false })), />Saved\.</);
  });
  it('names from the server are escaped', () => {
    const html = show(fakeMeta({ categories: [{ id: 'k1', name: '<script>alert(1)</script>', isActive: true }] }));
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });
  it('loading and failed-to-load states render', () => {
    assert.match(show({ loading: true, meta: null, draft: null, problems: [] }), /Loading protocol details/);
    assert.match(show({ loading: false, meta: null, draft: null, error: 'Forbidden', problems: [] }), /Forbidden/);
  });
});
