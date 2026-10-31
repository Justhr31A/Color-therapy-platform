/**
 * [DETERMINISTIC SOFTWARE TESTS] Protocol Studio object model — the REAL modules (src/builder/model/*, config/*).
 * Pure logic: sizes, presets, scale, thickness, Dot + Ring, Finger Band geometry, text, and the guarantees around them.
 * It does NOT draw anything (no Konva); on-screen behaviour needs a browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultObject, OBJECT_TYPES } from '../src/builder/objectDefaults.js';
import { COLOR_PALETTE, getPalette, DEFAULT_OBJECT_COLOR } from '../src/builder/config/palette.js';
import {
  SIZE_PRESET_KEYS, SIZE_PRESET_LABELS, SIZE_BASES, SIZE_BASES_HEIGHT, RING_SIZE_BASES, THICKNESS_PRESET_KEYS, THICKNESS_BASES, SCALE_LIMITS,
  GAP_PRESET_KEYS, RING_GAP_BASES, DEFAULT_RING_THICKNESS, DEFAULT_OUTLINE_COLOR, DEFAULT_OUTLINE_THICKNESS,
} from '../src/builder/config/sizePresets.js';
import { FINGER_GUIDES } from '../src/builder/config/fingerGuides.js';
import {
  TOOL_IDS, supports, createStudioObject, offsetForCopy, deepClone,
  getSizeState, patchSizePreset, patchScale, clampScale, syncDerivedMetadata, round2, round4,
  getThicknessState, patchThicknessPreset, patchThicknessScale,
  hasActiveRing, getRing, defaultRing, patchRingEnabled, patchRingSizePreset, patchRingScale, patchRingThicknessPreset,
  patchRingThicknessScale, patchRingColor, patchCompositeResize, getRingSizeState,
  effectiveRingGapPx, getRingGapState, patchRingGapPreset, patchRingGapScale,
  getBand, patchBandFinger, patchBandPosition, patchBandDrag, patchBandTransform, patchBandType, patchBandFitToFinger, patchBandRotationOffset,
  getText, patchText, TEXT_MAX_LENGTH,
} from '../src/builder/model/objectModel.js';
import { nearestFinger, projectToAxis, axisPoint, bandRotationDeg, canonicalFingerName, hasGuides, getGuide } from '../src/builder/model/fingerGeometry.js';

const VIEWS = ['left_front', 'right_front', 'left_back', 'right_back'];
const DIMS = { left_front: [1586, 1982], right_front: [1585, 1983], left_back: [1585, 1981], right_back: [1971, 2010] };
const ctx = (viewKey) => ({ viewKey, canvasWidth: DIMS[viewKey][0], canvasHeight: DIMS[viewKey][1] });
const canvasOf = (viewKey) => ({ width: DIMS[viewKey][0], height: DIMS[viewKey][1] });
const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b} got ${a}`);
const DRAWING = TOOL_IDS.filter((t) => t !== 'select' && t !== 'eraser');
const make = (tool, view = 'left_front', x = 0.4, y = 0.5) => createStudioObject(tool, x, y, ctx(view));
/** A Dot + Ring in the OLDER single-spaced-ring format (`metadata.ring`) — what the Dot + Ring tool created before multi-ring support. */
const makeLegacyRing = (view = 'left_front', x = 0.4, y = 0.5) => { const d = make('dot', view, x, y); return { ...d, ...patchRingEnabled(d, true) }; };

describe('[DETERMINISTIC] Studio configuration', () => {
  it('the toolbar has the 15 required tools in order', () => {
    assert.deepEqual([...TOOL_IDS], ['select', 'dot', 'ring', 'dotRing', 'fingerBand', 'hline', 'vline', 'freeline', 'invertedTriangle', 'triangle', 'rectangle', 'square', 'arrow', 'text', 'eraser']);
  });

  it('sizes are exactly Small / Medium / Large / Extra Large (the old "no XL" limit is gone)', () => {
    assert.deepEqual([...SIZE_PRESET_KEYS], ['small', 'medium', 'large', 'xl']);
    assert.equal(SIZE_PRESET_LABELS.xl, 'Extra Large');
    // every size table defines all four — no object type is left without an Extra Large
    [...Object.values(SIZE_BASES), ...Object.values(SIZE_BASES_HEIGHT), RING_SIZE_BASES].forEach((t) => {
      assert.deepEqual(Object.keys(t).sort(), [...SIZE_PRESET_KEYS].sort());
    });
  });
  it('the three-value thickness and gap preset lists only survive to read data saved by earlier versions', () => {
    assert.deepEqual([...THICKNESS_PRESET_KEYS], ['small', 'medium', 'large']);
    assert.deepEqual([...GAP_PRESET_KEYS], ['small', 'medium', 'large']);
  });

  it('every size table is complete and strictly increasing (small < medium < large < xl), and so is the legacy thickness table', () => {
    const tables = { ...SIZE_BASES, ...Object.fromEntries(Object.entries(SIZE_BASES_HEIGHT).map(([k, v]) => [`${k}.height`, v])), ring: RING_SIZE_BASES };
    Object.entries(tables).forEach(([name, t]) => {
      assert.ok(t.small > 0 && t.small < t.medium && t.medium < t.large && t.large < t.xl, `${name}: ${JSON.stringify(t)}`);
      assert.ok(t.xl <= 1, `${name}: an Extra Large must still fit inside the canvas`);
    });
    assert.ok(THICKNESS_BASES.small > 0 && THICKNESS_BASES.small < THICKNESS_BASES.medium && THICKNESS_BASES.medium < THICKNESS_BASES.large);
  });

  it('MEDIUM equals the default the builder has always produced, so "default size" did not change', () => {
    ['dot', 'ring', 'hline', 'vline', 'arrow', 'triangle', 'invertedTriangle', 'rectangle', 'square'].forEach((type) => {
      const legacy = createDefaultObject(type, 0.5, 0.5);
      assert.equal(SIZE_BASES[type].medium, legacy.width, `${type} width`);
    });
    assert.equal(SIZE_BASES_HEIGHT.rectangle.medium, createDefaultObject('rectangle', 0.5, 0.5).height);
    assert.equal(THICKNESS_BASES.medium, createDefaultObject('ring', 0.5, 0.5).thickness);
  });

  it('the palette is one modifiable list of 12–14 unique hex colours, and the default object colour comes from it', () => {
    assert.ok(COLOR_PALETTE.length >= 12 && COLOR_PALETTE.length <= 14, `${COLOR_PALETTE.length} colours`);
    assert.equal(new Set(COLOR_PALETTE.map((c) => c.value.toLowerCase())).size, COLOR_PALETTE.length);
    assert.ok(COLOR_PALETTE.every((c) => /^#[0-9a-f]{6}$/i.test(c.value) && c.name && c.key));
    assert.equal(getPalette(), COLOR_PALETTE);
    assert.equal(DEFAULT_OBJECT_COLOR, createDefaultObject('dot', 0.1, 0.1).color);
  });

  it('the palette is defined ONLY in config/palette.js (no component re-declares a swatch list)', () => {
    const root = fileURLToPath(new URL('../src/builder', import.meta.url));
    const files = [];
    (function walk(d) { readdirSync(d).forEach((f) => { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(f)) files.push(p); }); }(root));
    const values = COLOR_PALETTE.map((c) => c.value.toLowerCase());
    files.filter((f) => !relative(root, f).startsWith('config')).forEach((f) => {
      const src = readFileSync(f, 'utf8').toLowerCase();
      const distinct = values.filter((v) => src.includes(v));
      assert.ok(distinct.length < 4, `${relative(root, f)} contains ${distinct.length} palette colours; the palette must live in config/palette.js only`);
    });
  });
});

describe('[DETERMINISTIC] size preset + custom scale', () => {
  it('a new object starts as Medium at scale 1 with width = the Medium base', () => {
    const d = make('dot');
    assert.deepEqual([d.metadata.sizePreset, d.metadata.scale, d.width, d.height], ['medium', 1, SIZE_BASES.dot.medium, SIZE_BASES.dot.medium]);
  });

  it('choosing Small / Large changes the real width to base x scale (and keeps the scale)', () => {
    const d = make('ring');
    const large = { ...d, ...patchSizePreset(d, 'large') };
    assert.equal(large.width, SIZE_BASES.ring.large);
    assert.equal(large.metadata.sizePreset, 'large');
    assert.equal(large.height, large.width, 'a ring stays circular');
    const scaled = { ...large, ...patchScale(large, 0.5) };
    assert.equal(scaled.width, +(SIZE_BASES.ring.large * 0.5).toFixed(4));
    assert.equal(scaled.metadata.sizePreset, 'large', 'a custom scale does not change the preset');
    const small = { ...scaled, ...patchSizePreset(scaled, 'small') };
    assert.equal(small.width, +(SIZE_BASES.ring.small * 0.5).toFixed(4), 'the scale carries across presets');
    assert.equal(small.metadata.scale, 0.5);
  });

  it('scale is clamped to the configured limits', () => {
    assert.equal(clampScale(0.01), SCALE_LIMITS.min);
    assert.equal(clampScale(99), SCALE_LIMITS.max);
    assert.equal(clampScale('nope'), 1);
    const d = make('dot');
    assert.equal(patchScale(d, 1000).metadata.scale, SCALE_LIMITS.max);
  });

  it('a rectangle keeps its width:height proportion when scaled, and takes the preset proportion when the preset changes', () => {
    let r = make('rectangle');
    r = { ...r, width: 0.2, height: 0.05 }; // the doctor stretched it
    const scaled = { ...r, ...patchScale(r, 2) };
    near(scaled.height / scaled.width, 0.05 / 0.2, 1e-3, 'proportion kept');
    const large = { ...r, ...patchSizePreset(r, 'large') };
    near(large.height / large.width, SIZE_BASES_HEIGHT.rectangle.large / SIZE_BASES.rectangle.large, 1e-3, 'preset proportion');
  });

  it('an object saved BEFORE the Studio (no preset) reads as Medium with a derived scale, and nothing is rewritten by reading it', () => {
    const legacy = createDefaultObject('hline', 0.5, 0.5);
    legacy.width = 0.27; // a legacy hline stretched to 0.27
    const before = JSON.stringify(legacy);
    const state = getSizeState(legacy);
    assert.deepEqual([state.preset, state.managed], ['medium', false]);
    near(state.scale, 0.27 / SIZE_BASES.hline.medium, 1e-3);
    assert.equal(JSON.stringify(legacy), before, 'reading does not mutate');
    const edited = { ...legacy, ...patchSizePreset(legacy, 'medium') };
    near(edited.width, 0.27, 1e-3, 'picking Medium keeps its visual size (its scale is preserved)');
  });

  it('patches never mutate the object and never share nested data with it', () => {
    const d = make('dot');
    const before = deepClone(d);
    const p = patchScale(d, 2);
    assert.deepEqual(d, before);
    assert.notEqual(p.metadata, d.metadata);
  });

  it('types that have no size (free line) ignore size patches; types without thickness (dot, text) ignore thickness patches', () => {
    assert.deepEqual(patchScale(make('freeline'), 2), {});
    assert.deepEqual(patchThicknessPreset(make('dot'), 'large'), {});
    assert.deepEqual(patchThicknessScale(make('text'), 2), {});
  });

  it('capabilities: which types have size / thickness / rotation', () => {
    const sizeless = OBJECT_TYPES.map((t) => t.type).filter((t) => !supports(t, 'size'));
    assert.deepEqual(sizeless, ['freeline']);
    assert.deepEqual(OBJECT_TYPES.map((t) => t.type).filter((t) => !supports(t, 'thickness')).sort(), ['dot', 'text']);
    assert.equal(supports('ring', 'rotation'), false, 'a circle has nothing to rotate');
    assert.equal(supports('arrow', 'rotation'), true);
    assert.equal(supports('nonsense', 'size'), false);
  });
});

describe('[DETERMINISTIC] thickness preset + custom thickness scale', () => {
  it('presets set the real thickness in px; the custom scale multiplies it', () => {
    const r = make('ring');
    assert.equal(r.thickness, THICKNESS_BASES.medium);
    const large = { ...r, ...patchThicknessPreset(r, 'large') };
    assert.equal(large.thickness, THICKNESS_BASES.large);
    const scaled = { ...large, ...patchThicknessScale(large, 0.5) };
    assert.equal(scaled.thickness, THICKNESS_BASES.large * 0.5);
    assert.equal(scaled.metadata.thicknessPreset, 'large');
    assert.equal(scaled.metadata.thicknessScale, 0.5);
    const small = { ...scaled, ...patchThicknessPreset(scaled, 'small') };
    assert.equal(small.thickness, THICKNESS_BASES.small * 0.5);
  });

  it('thickness never drops below the minimum', () => {
    const r = make('ring');
    const t = { ...r, ...patchThicknessPreset(r, 'small') };
    assert.ok(patchThicknessScale(t, 0.25).thickness >= 0.5);
  });

  it('legacy thickness (3 px) reads as Medium at 75% without rewriting anything', () => {
    const legacy = createDefaultObject('rectangle', 0.5, 0.5);
    const s = getThicknessState(legacy);
    assert.deepEqual([s.preset, s.scale, s.managed], ['medium', 0.75, false]);
    assert.deepEqual(legacy.metadata, {});
  });
});

describe('[DETERMINISTIC] recorded scale can never disagree with the real geometry (incl. the legacy ring)', () => {
  it('after a canvas resize (width changed directly) the scale is re-derived', () => {
    const d = make('ring');
    const resized = syncDerivedMetadata({ ...d, width: SIZE_BASES.ring.medium * 1.5 });
    assert.equal(resized.metadata.scale, 1.5);
    assert.equal(resized.metadata.sizePreset, 'medium');
  });
  it('thickness scale and ring scales are re-derived the same way', () => {
    const d = makeLegacyRing();
    const changed = syncDerivedMetadata({ ...d, thickness: 0, metadata: { ...d.metadata, ring: { ...d.metadata.ring, width: RING_SIZE_BASES.medium * 2, thickness: 6 } } });
    assert.equal(changed.metadata.ring.scale, 2);
    assert.equal(changed.metadata.ring.thicknessScale, 1.5);
  });
  it('returns the very same object when nothing needs fixing, and leaves legacy objects alone', () => {
    const d = make('dot');
    assert.equal(syncDerivedMetadata(d), d);
    const legacy = createDefaultObject('dot', 0.3, 0.3);
    assert.equal(syncDerivedMetadata(legacy), legacy);
  });
});

describe('[DETERMINISTIC] LEGACY single spaced ring: Dot + Ring is ONE structured object', () => {
  it('the Dot + Ring tool creates a single dot object with the ring inside its metadata', () => {
    const o = makeLegacyRing();
    assert.equal(o.type, 'dot', 'stays a dot, so anything that only knows dots still shows it');
    assert.equal(hasActiveRing(o), true);
    const ring = getRing(o);
    assert.deepEqual(Object.keys(ring).sort(), ['color', 'enabled', 'scale', 'sizePreset', 'thickness', 'thicknessPreset', 'thicknessScale', 'width']);
    assert.ok(ring.width > o.width, 'the ring surrounds the dot');
    assert.equal(ring.color, o.color);
  });

  it('a plain Dot has no ring, and only a dot can carry one', () => {
    assert.equal(hasActiveRing(make('dot')), false);
    assert.equal(getRing(make('dot')), null);
    assert.deepEqual(patchRingEnabled(make('ring'), true), {});
    assert.equal(hasActiveRing(make('ring')), false);
  });

  it('enabling adds a default ring; disabling keeps its settings so re-enabling restores them', () => {
    let d = make('dot');
    d = { ...d, ...patchRingEnabled(d, true) };
    assert.equal(hasActiveRing(d), true);
    d = { ...d, ...patchRingColor(d, '#1a73e8'), ...{} };
    d = { ...d, ...patchRingSizePreset(d, 'large') };
    const off = { ...d, ...patchRingEnabled(d, false) };
    assert.equal(hasActiveRing(off), false);
    assert.equal(getRing(off).color, '#1a73e8');
    const on = { ...off, ...patchRingEnabled(off, true) };
    assert.equal(getRing(on).color, '#1a73e8');
    assert.equal(getRing(on).sizePreset, 'large');
  });

  it('ring size preset/scale, ring thickness preset/scale and ring colour each change only the ring', () => {
    let o = makeLegacyRing();
    const dotBefore = [o.width, o.height, o.color, o.opacity, o.metadata.sizePreset, o.metadata.scale];
    o = { ...o, ...patchRingSizePreset(o, 'large') };
    assert.equal(getRing(o).width, RING_SIZE_BASES.large);
    o = { ...o, ...patchRingScale(o, 1.2) };
    assert.equal(getRing(o).width, +(RING_SIZE_BASES.large * 1.2).toFixed(4));
    assert.equal(getRing(o).sizePreset, 'large');
    o = { ...o, ...patchRingThicknessPreset(o, 'large') };
    assert.equal(getRing(o).thickness, THICKNESS_BASES.large);
    o = { ...o, ...patchRingThicknessScale(o, 0.5) };
    assert.equal(getRing(o).thickness, THICKNESS_BASES.large * 0.5);
    o = { ...o, ...patchRingColor(o, '#12a594') };
    assert.equal(getRing(o).color, '#12a594');
    assert.deepEqual([o.width, o.height, o.color, o.opacity, o.metadata.sizePreset, o.metadata.scale], dotBefore, 'the dot part is untouched');
    assert.equal(getRingSizeState(getRing(o)).scale, 1.2);
  });

  it('the dot and ring have independent colours; the dot colour is the object colour', () => {
    let o = makeLegacyRing();
    o = { ...o, color: '#f76b15' };
    assert.equal(getRing(o).color, '#e5484d');
    assert.equal(o.color, '#f76b15');
  });

  it('resizing the composite scales the dot AND the ring by the same factor, keeping their ratio', () => {
    const o = makeLegacyRing();
    const ratio = getRing(o).width / o.width;
    const grown = { ...o, ...patchCompositeResize(o, 1.5) };
    near(grown.width, o.width * 1.5, 1e-4);
    near(getRing(grown).width, getRing(o).width * 1.5, 1e-4);
    near(getRing(grown).width / grown.width, ratio, 1e-3, 'ring:dot ratio');
    assert.equal(grown.height, grown.width);
    assert.equal(getRing(o).width, RING_SIZE_BASES.medium, 'the original is untouched');
  });
});

describe('[DETERMINISTIC] LEGACY single spaced ring: independent colours', () => {
  const CANVAS_W = 1586;

  it('the dot and ring can be set to different colours, and reading each gives back exactly what was set', () => {
    let o = makeLegacyRing();
    o = { ...o, color: 'red', metadata: { ...o.metadata, ring: { ...getRing(o), color: 'blue' } } };
    assert.equal(o.color, 'red');
    assert.equal(getRing(o).color, 'blue');
  });

  it('patchRingColor changes only the ring; the dot colour is changed by the ordinary `color` field', () => {
    let o = makeLegacyRing();
    o = { ...o, ...patchRingColor(o, '#1a73e8') };
    o = { ...o, color: '#f76b15' };
    assert.equal(o.color, '#f76b15');
    assert.equal(getRing(o).color, '#1a73e8');
  });

  it('a ring with no colour of its own (legacy or hand-written data) falls back to the dot colour', () => {
    const o = { ...make('dot'), color: '#12a594' };
    o.metadata.ring = { enabled: true, sizePreset: 'medium', scale: 1, width: 0.08, thicknessPreset: 'medium', thicknessScale: 1, thickness: 4 }; // no .color
    assert.equal(getRing(o).color, '#12a594');
  });

  it('the fallback never rewrites the stored data — only what getRing() returns for display', () => {
    const o = { ...make('dot'), color: '#12a594' };
    o.metadata.ring = { enabled: true, sizePreset: 'medium', scale: 1, width: 0.08, thicknessPreset: 'medium', thicknessScale: 1, thickness: 4 };
    getRing(o);
    assert.equal('color' in o.metadata.ring, false);
  });

  it('once patchRingColor sets an explicit colour, it no longer falls back to the dot colour', () => {
    const o = { ...make('dot'), color: '#12a594' };
    o.metadata.ring = { enabled: true, sizePreset: 'medium', scale: 1, width: 0.08, thicknessPreset: 'medium', thicknessScale: 1, thickness: 4 };
    const patched = { ...o, ...patchRingColor(o, '#111111') };
    assert.equal(getRing(patched).color, '#111111');
  });
});

describe('[DETERMINISTIC] LEGACY single spaced ring: adjustable gap (not offered for new rings — they are always attached)', () => {
  const CANVAS_W = 1586;

  it('there is no XL gap preset', () => {
    assert.deepEqual([...GAP_PRESET_KEYS], ['small', 'medium', 'large']);
  });

  it('a freshly created ring has no explicit gap; its effective gap is derived from its default width', () => {
    const o = makeLegacyRing();
    const ring = getRing(o);
    assert.equal('gap' in ring, false);
    const dotRadiusPx = (o.width / 2) * CANVAS_W;
    const ringRadiusPx = (ring.width / 2) * CANVAS_W;
    const expected = round2(ringRadiusPx - dotRadiusPx - ring.thickness / 2);
    assert.equal(effectiveRingGapPx(o, ring, CANVAS_W), expected);
  });

  it('Small / Medium / Large gap presets set the exact reference-pixel gap from the table', () => {
    const o = makeLegacyRing();
    ['small', 'medium', 'large'].forEach((preset) => {
      const patched = { ...o, ...patchRingGapPreset(o, { width: CANVAS_W }, preset) };
      const ring = getRing(patched);
      assert.equal(ring.gapPreset, preset);
      assert.equal(ring.gap, RING_GAP_BASES[preset]);
      assert.equal(effectiveRingGapPx(patched, ring, CANVAS_W), RING_GAP_BASES[preset]);
    });
  });

  it('a custom gap scale multiplies the preset base, and is clamped to the scale limits', () => {
    let o = makeLegacyRing();
    o = { ...o, ...patchRingGapPreset(o, { width: CANVAS_W }, 'medium') };
    o = { ...o, ...patchRingGapScale(o, { width: CANVAS_W }, 1.5) };
    const ring = getRing(o);
    assert.equal(ring.gapScale, 1.5);
    assert.equal(ring.gap, round2(RING_GAP_BASES.medium * 1.5));
    o = { ...o, ...patchRingGapScale(o, { width: CANVAS_W }, 1000) };
    assert.equal(getRing(o).gapScale, SCALE_LIMITS.max);
  });

  it('changing the gap changes the ACTUAL empty space: the ring\'s inner edge sits exactly `gap` px from the dot\'s outer edge', () => {
    const o = makeLegacyRing();
    ['small', 'medium', 'large'].forEach((preset) => {
      const patched = { ...o, ...patchRingGapPreset(o, { width: CANVAS_W }, preset) };
      const ring = getRing(patched);
      const dotRadiusPx = (patched.width / 2) * CANVAS_W;
      const ringCenterlineRadiusPx = dotRadiusPx + ring.gap + ring.thickness / 2; // exactly what DotRingShape draws
      const ringInnerEdgePx = ringCenterlineRadiusPx - ring.thickness / 2;
      assert.equal(round2(ringInnerEdgePx - dotRadiusPx), RING_GAP_BASES[preset], `${preset} gap`);
    });
  });

  it('setting a gap keeps `ring.width` (and its preset/scale) truthful, for anything that still reads it', () => {
    const o = makeLegacyRing();
    const patched = { ...o, ...patchRingGapPreset(o, { width: CANVAS_W }, 'large') };
    const ring = getRing(patched);
    const dotRadiusPx = (patched.width / 2) * CANVAS_W;
    const impliedRadiusPx = (ring.width / 2) * CANVAS_W;
    // ring.width is rounded to 4 decimal places when stored; converting back to pixels can only be this close.
    assert.ok(Math.abs(impliedRadiusPx - (dotRadiusPx + ring.gap + ring.thickness / 2)) < 0.05);
  });

  it('picking a ring SIZE preset clears any explicit gap, so it is never a dead control after gap was used', () => {
    let o = makeLegacyRing();
    o = { ...o, ...patchRingGapPreset(o, { width: CANVAS_W }, 'large') };
    const widthBefore = getRing(o).width;
    const scaleBefore = getRingSizeState(getRing(o)).scale; // the scale the gap edit left behind, carried across presets exactly like the original size control
    assert.ok('gap' in getRing(o));
    o = { ...o, ...patchRingSizePreset(o, 'small') };
    assert.equal('gap' in getRing(o), false);
    assert.notEqual(getRing(o).width, widthBefore, 'picking Small had a real, visible effect');
    assert.equal(getRing(o).width, round4(RING_SIZE_BASES.small * scaleBefore));
    // and the gap control still works afterwards, deriving a sensible state from the new width
    const derived = getRingGapState(o, getRing(o), CANVAS_W);
    assert.ok(derived.gap >= 0);
  });

  it('changing a ring\'s size (patchRingScale) also clears an explicit gap', () => {
    let o = makeLegacyRing();
    o = { ...o, ...patchRingGapPreset(o, { width: CANVAS_W }, 'medium') };
    o = { ...o, ...patchRingScale(o, 1.4) };
    assert.equal('gap' in getRing(o), false);
  });

  it('changing thickness after a gap is set does NOT disturb the dot-to-ring-inner-edge distance', () => {
    let o = makeLegacyRing();
    o = { ...o, ...patchRingGapPreset(o, { width: CANVAS_W }, 'medium') };
    const before = effectiveRingGapPx(o, getRing(o), CANVAS_W);
    o = { ...o, ...patchRingThicknessPreset(o, 'large') };
    assert.equal(getRing(o).thicknessPreset, 'large', 'thickness really did change');
    assert.equal(effectiveRingGapPx(o, getRing(o), CANVAS_W), before, 'the gap itself is untouched by a thickness change');
  });

  it('an existing Dot + Ring object without any gap fields still renders at exactly its old size (backward compatible)', () => {
    const legacy = { ...make('dot'), color: '#e5484d', width: 0.03 };
    legacy.metadata.ring = { enabled: true, sizePreset: 'large', scale: 1, width: RING_SIZE_BASES.large, thicknessPreset: 'medium', thicknessScale: 1, thickness: 4, color: '#1a73e8' };
    const ring = getRing(legacy);
    const dotRadiusPx = (legacy.width / 2) * CANVAS_W;
    const oldRingRadiusPx = (ring.width / 2) * CANVAS_W;
    const newRingRadiusPx = dotRadiusPx + effectiveRingGapPx(legacy, ring, CANVAS_W) + ring.thickness / 2;
    assert.ok(Math.abs(newRingRadiusPx - oldRingRadiusPx) < 0.01, 'identical rendered radius, old vs new formula');
  });

  it('syncDerivedMetadata keeps a stored gapScale truthful, the same way it already does for size and thickness', () => {
    const o = makeLegacyRing();
    const changed = syncDerivedMetadata({ ...o, metadata: { ...o.metadata, ring: { ...getRing(o), gapPreset: 'medium', gap: RING_GAP_BASES.medium * 2 } } });
    assert.equal(changed.metadata.ring.gapScale, 2);
  });
});

describe('[DETERMINISTIC] finger guides and Finger Band geometry', () => {
  it('there are guides for all 5 fingers on all 4 views, with sane numbers', () => {
    VIEWS.forEach((v) => {
      assert.deepEqual(Object.keys(FINGER_GUIDES[v]).sort(), ['index', 'little', 'middle', 'ring', 'thumb']);
      Object.values(FINGER_GUIDES[v]).forEach((g) => {
        [g.base.x, g.base.y, g.tip.x, g.tip.y].forEach((n) => assert.ok(n > 0 && n < 1));
        assert.ok(g.width > 0.05 && g.width < 0.25);
        assert.ok(Math.hypot((g.tip.x - g.base.x) * DIMS[v][0], (g.tip.y - g.base.y) * DIMS[v][1]) > 200, 'a finger has real length in pixels');
      });
    });
  });

  it('on a front view the fingers are ordered index..little across the hand and mirrored on the other hand', () => {
    const xs = (v) => ['index', 'middle', 'ring', 'little'].map((f) => FINGER_GUIDES[v][f].base.x);
    assert.ok(xs('left_front').every((x, i, a) => i === 0 || x > a[i - 1]), 'left palm: index on the left, little on the right');
    assert.ok(xs('right_front').every((x, i, a) => i === 0 || x < a[i - 1]), 'right palm mirrors it');
    near(FINGER_GUIDES.left_front.middle.base.x + FINGER_GUIDES.right_front.middle.base.x, 1, 0.02, 'mirror symmetry');
  });

  it('a band is laid PERPENDICULAR to its finger, in pixel space, for every finger on every view (non-square images)', () => {
    VIEWS.forEach((v) => {
      Object.keys(FINGER_GUIDES[v]).forEach((f) => {
        const c = canvasOf(v);
        const g = getGuide(v, f);
        const rot = (bandRotationDeg(v, f, c) * Math.PI) / 180;
        const bandDir = { x: Math.cos(rot), y: Math.sin(rot) };
        const axis = { x: (g.tip.x - g.base.x) * c.width, y: (g.tip.y - g.base.y) * c.height };
        const cos = (bandDir.x * axis.x + bandDir.y * axis.y) / Math.hypot(axis.x, axis.y);
        assert.ok(Math.abs(cos) < 0.02, `${v}/${f}: band not perpendicular (cos ${cos.toFixed(3)})`);
      });
    });
  });

  it('a click near a finger selects THAT finger, on every view', () => {
    VIEWS.forEach((v) => {
      Object.keys(FINGER_GUIDES[v]).forEach((f) => {
        const p = axisPoint(v, f, 0.5);
        const found = nearestFinger(v, canvasOf(v), p.x + 0.004, p.y + 0.004);
        assert.equal(found.finger, f, `${v}: click on ${f}`);
        near(found.t, 0.5, 0.06);
      });
    });
  });

  it('projection snaps a point onto the axis and clamps to the finger ends', () => {
    const c = canvasOf('left_front');
    const g = getGuide('left_front', 'index');
    const on = projectToAxis('left_front', 'index', c, g.base.x + 0.2, (g.base.y + g.tip.y) / 2);
    assert.ok(on.t > 0.4 && on.t < 0.6);
    // t runs from the knuckle (0) to the fingertip (1); points beyond either end clamp
    assert.equal(projectToAxis('left_front', 'index', c, g.tip.x, g.tip.y - 0.3).t, 1, 'beyond the fingertip');
    assert.equal(projectToAxis('left_front', 'index', c, g.base.x, g.base.y + 0.3).t, 0, 'below the knuckle');
  });

  it('the Finger Band tool creates a structured band ON a finger', () => {
    const p = axisPoint('right_back', 'middle', 0.4);
    const b = make('fingerBand', 'right_back', p.x, p.y);
    assert.equal(b.type, 'fingerBand');
    assert.equal(b.finger, 'middle');
    assert.deepEqual(getBand(b), { type: 'plain', position: 0.4, rotationOffset: 0 });
    near(b.x, p.x, 1e-3);
    near(b.y, p.y, 1e-3);
    assert.equal(b.landmarkReference, null, 'the AR mapping field is reserved, not filled in');
    assert.ok(b.width > 0 && b.thickness === THICKNESS_BASES.medium);
    near(b.width, getGuide('right_back', 'middle').width * 0.95, 1e-4, 'wraps the finger it is on');
  });

  it('changing the finger re-places the band on the new finger, keeping its position along it', () => {
    const p = axisPoint('left_front', 'index', 0.3);
    let b = make('fingerBand', 'left_front', p.x, p.y);
    b = { ...b, ...patchBandFinger(b, 'left_front', canvasOf('left_front'), 'ring') };
    assert.equal(b.finger, 'ring');
    assert.equal(getBand(b).position, 0.3);
    const expected = axisPoint('left_front', 'ring', 0.3);
    near(b.x, expected.x, 1e-3);
    near(b.y, expected.y, 1e-3);
  });

  it('the legacy name "pinky" is understood but new data is always "little"', () => {
    assert.equal(canonicalFingerName('pinky'), 'little');
    const p = axisPoint('left_front', 'little', 0.5);
    let b = make('fingerBand', 'left_front', p.x, p.y);
    b = { ...b, ...patchBandFinger(b, 'left_front', canvasOf('left_front'), 'pinky') };
    assert.equal(b.finger, 'little');
    assert.ok(getGuide('left_front', 'pinky'));
  });

  it('position along the finger moves the band along the axis; dragging snaps it back onto the axis', () => {
    const p = axisPoint('left_front', 'middle', 0.2);
    let b = make('fingerBand', 'left_front', p.x, p.y);
    b = { ...b, ...patchBandPosition(b, 'left_front', canvasOf('left_front'), 0.8) };
    const at = axisPoint('left_front', 'middle', 0.8);
    near(b.x, at.x, 1e-3);
    near(b.y, at.y, 1e-3);
    // drag far off the finger: it must land ON the finger, at the projected position
    b = { ...b, ...patchBandDrag(b, 'left_front', canvasOf('left_front'), 0.9, 0.2) };
    const back = axisPoint('left_front', 'middle', getBand(b).position);
    near(b.x, back.x, 1e-3);
    near(b.y, back.y, 1e-3);
    assert.equal(b.finger, 'middle', 'dragging never changes which finger it is on');
  });

  it('a band on a view with no finger guides cannot be created; the store treats that as "nothing added"', () => {
    assert.equal(hasGuides('organ_diagram'), false);
    assert.equal(createStudioObject('fingerBand', 0.5, 0.5, { viewKey: 'organ_diagram', canvasWidth: 1000, canvasHeight: 1000 }), null);
  });

  it('band type, angle offset and "fit to finger" behave', () => {
    const p = axisPoint('left_front', 'ring', 0.4);
    let b = make('fingerBand', 'left_front', p.x, p.y);
    const base = b.rotation;
    b = { ...b, ...patchBandType(b, 'double') };
    assert.equal(getBand(b).type, 'double');
    assert.deepEqual(patchBandType(b, 'spiral'), {}, 'unknown band types are refused');
    b = { ...b, ...patchBandRotationOffset(b, 'left_front', canvasOf('left_front'), 20) };
    near(b.rotation, base + 20, 0.05);
    b = { ...b, width: 0.05 };
    b = { ...b, ...patchBandFitToFinger(b, 'left_front') };
    near(b.width, getGuide('left_front', 'ring').width * 0.95, 1e-4);
  });

  it('turning the band with the canvas handle is recorded as an offset from "across the finger", not lost', () => {
    const p = axisPoint('left_front', 'index', 0.4);
    const b = make('fingerBand', 'left_front', p.x, p.y);
    const across = b.rotation;
    const patch = patchBandTransform(b, 'left_front', canvasOf('left_front'), { widthNorm: 0.2, rotation: across + 15 });
    near(patch.metadata.band.rotationOffset, 15, 0.05);
    assert.equal(patch.width, 0.2);
    near(patch.rotation, across + 15, 0.05);
  });
});

describe('[DETERMINISTIC] text / annotation', () => {
  it('the Text tool creates a text object with content and a size that uses the size presets', () => {
    const t = make('text');
    assert.equal(t.type, 'text');
    assert.equal(getText(t), 'Text');
    assert.equal(t.width, SIZE_BASES.text.medium);
    const big = { ...t, ...patchSizePreset(t, 'large') };
    assert.equal(big.width, SIZE_BASES.text.large);
  });
  it('text content is stored in metadata, capped at the maximum length, and never mutates the source', () => {
    const t = make('text');
    const p = patchText(t, 'y'.repeat(TEXT_MAX_LENGTH + 50));
    assert.equal(p.metadata.text.length, TEXT_MAX_LENGTH);
    assert.equal(getText(t), 'Text');
    assert.equal(patchText(t, null).metadata.text, '');
    assert.equal(getText(createDefaultObject('dot', 0, 0)), '');
  });
  it('text is drawn as plain text: markup-looking content is kept verbatim as data', () => {
    const t = make('text');
    assert.equal(patchText(t, '<img src=x onerror=alert(1)>').metadata.text, '<img src=x onerror=alert(1)>');
  });
});

describe('[DETERMINISTIC] creating objects from tools', () => {
  it('every drawing tool yields a valid, JSON-safe object of a known type with a fresh id', () => {
    const known = OBJECT_TYPES.map((t) => t.type);
    const ids = new Set();
    DRAWING.forEach((tool) => {
      const o = make(tool);
      assert.ok(o, tool);
      assert.ok(known.includes(o.type), `${tool} -> ${o.type}`);
      assert.deepEqual(JSON.parse(JSON.stringify(o)), o, `${tool} is JSON-safe`);
      ids.add(o.id);
    });
    assert.equal(ids.size, DRAWING.length);
  });

  it('two objects made by the same tool share NO nested data', () => {
    DRAWING.forEach((tool) => {
      const a = make(tool);
      const b = make(tool);
      assert.notEqual(a.metadata, b.metadata, tool);
      if (a.metadata.ring) assert.notEqual(a.metadata.ring, b.metadata.ring);
      if (a.metadata.band) assert.notEqual(a.metadata.band, b.metadata.band);
    });
  });

  it('every size-capable object is created as Medium at scale 1; every thickness-capable one starts at the default thickness as a plain number (thickness is free, not a preset)', () => {
    DRAWING.filter((t) => t !== 'fingerBand').forEach((tool) => {
      const o = make(tool);
      if (supports(o.type, 'size')) assert.deepEqual([o.metadata.sizePreset, o.metadata.scale], ['medium', 1], tool);
      if (supports(o.type, 'thickness')) {
        assert.equal(o.thickness, THICKNESS_BASES.medium, tool);
        assert.equal('thicknessPreset' in o.metadata || 'thicknessScale' in o.metadata, false, `${tool}: no preset bookkeeping for a free value`);
      }
    });
  });
});

describe('[DETERMINISTIC] copy / duplicate placement', () => {
  it('ordinary objects are nudged down-right and clamped to the canvas (exactly as before)', () => {
    const o = make('dot', 'left_front', 0.5, 0.5);
    assert.deepEqual(offsetForCopy(o), { x: 0.54, y: 0.54 });
    assert.deepEqual(offsetForCopy({ ...o, x: 0.99, y: 0.97 }), { x: 0.95, y: 0.95 });
  });
  it('a band slides along its finger, and is re-placed on the TARGET view\'s finger when pasted onto another view', () => {
    const p = axisPoint('left_front', 'index', 0.3);
    const b = make('fingerBand', 'left_front', p.x, p.y);
    const same = offsetForCopy(b, { viewKey: 'left_front', canvas: canvasOf('left_front') });
    assert.equal(same.finger, 'index');
    assert.equal(same.metadata.band.position, 0.38);
    const other = offsetForCopy(b, { viewKey: 'right_front', canvas: canvasOf('right_front') });
    const expected = axisPoint('right_front', 'index', 0.38);
    near(other.x, expected.x, 1e-3);
    near(other.y, expected.y, 1e-3);
    assert.notEqual(same.metadata, b.metadata, 'deep copy');
  });
  it('a band near the fingertip slides back instead of off the end', () => {
    const p = axisPoint('left_front', 'index', 0.97);
    const b = make('fingerBand', 'left_front', p.x, p.y);
    assert.ok(offsetForCopy(b, { viewKey: 'left_front', canvas: canvasOf('left_front') }).metadata.band.position < 0.97);
  });
});


// =====================================================================================================================
// Sharing/PDF task: Extra Large, free thickness, the shared outline, and many attached rings (zero gap).
// =====================================================================================================================
import * as M from '../src/builder/model/objectModel.js';

const W = 1586; // left_front reference width
const SIZE_TYPES = ['dot', 'ring', 'hline', 'vline', 'arrow', 'triangle', 'invertedTriangle', 'rectangle', 'square', 'text'];
const THICK_TYPES = ['ring', 'hline', 'vline', 'arrow', 'freeline', 'triangle', 'invertedTriangle', 'rectangle', 'square'];
const OUTLINE_TYPES = ['dot', 'ring', 'hline', 'vline', 'arrow', 'freeline', 'triangle', 'invertedTriangle', 'rectangle', 'square', 'fingerBand'];

describe('[DETERMINISTIC] Extra Large size', () => {
  it('every size-capable type can be set to Extra Large, and it is larger than Large', () => {
    SIZE_TYPES.forEach((type) => {
      const o = make(type);
      const large = { ...o, ...M.patchSizePreset(o, 'large') };
      const xl = { ...o, ...M.patchSizePreset(o, 'xl') };
      assert.equal(xl.metadata.sizePreset, 'xl', type);
      assert.equal(xl.width, SIZE_BASES[type].xl, `${type} width = the Extra Large base`);
      assert.ok(xl.width > large.width, `${type}: Extra Large (${xl.width}) is larger than Large (${large.width})`);
    });
  });
  it('Extra Large keeps a custom scale and a rectangle gets its own Extra Large proportions', () => {
    const r = make('rectangle');
    const xl = { ...r, ...M.patchSizePreset(r, 'xl') };
    assert.equal(xl.height, SIZE_BASES_HEIGHT.rectangle.xl);
    const scaled = { ...xl, ...M.patchScale(xl, 0.5) };
    assert.equal(scaled.metadata.sizePreset, 'xl', 'a custom scale never changes the preset');
    assert.equal(scaled.width, +(SIZE_BASES.rectangle.xl * 0.5).toFixed(4));
  });
  it('the size state of an Extra Large object reads back as xl', () => {
    const o = make('square');
    assert.equal(M.getSizeState({ ...o, ...M.patchSizePreset(o, 'xl') }).preset, 'xl');
  });
  it('an unknown size ("xxl") is still refused', () => {
    assert.deepEqual(M.patchSizePreset(make('dot'), 'xxl'), {});
  });
});

describe('[DETERMINISTIC] thickness is a free number with no maximum', () => {
  it('any positive finite value is accepted, from tiny to enormous, on every stroke-based type', () => {
    THICK_TYPES.forEach((type) => {
      [0.5, 3, 8, 50, 1001, 5000, 250000, 1e9].forEach((v) => {
        const p = M.patchThickness(make(type), v);
        assert.equal(p.thickness, v, `${type} ${v}`);
      });
    });
  });
  it('the finger band is stroke-based too', () => {
    const p = { x: 0.7, y: 0.4 };
    const b = createStudioObject('fingerBand', p.x, p.y, ctx('right_front'));
    assert.equal(M.patchThickness(b, 12345).thickness, 12345);
  });
  it('invalid values are refused and never change anything: 0, negative, NaN, Infinity, text, empty, null, undefined', () => {
    [0, -1, NaN, Infinity, -Infinity, 'abc', '', '  ', null, undefined, {}, []].forEach((bad) => {
      assert.deepEqual(M.patchThickness(make('hline'), bad), {}, `${String(bad)} must be refused`);
    });
  });
  it('a numeric string (what a text input gives) is accepted as a number', () => {
    assert.equal(M.patchThickness(make('hline'), '12.5').thickness, 12.5);
  });
  it('types with no stroke (dot, text) ignore a thickness patch', () => {
    assert.deepEqual(M.patchThickness(make('dot'), 10), {});
    assert.deepEqual(M.patchThickness(make('text'), 10), {});
  });
  it('setting a free thickness drops the old preset/scale bookkeeping (a stale thicknessScale would be wrong, and the server caps it)', () => {
    const legacy = { ...make('hline'), metadata: { sizePreset: 'medium', scale: 1, thicknessPreset: 'medium', thicknessScale: 1 } };
    const p = M.patchThickness(legacy, 90000);
    assert.equal('thicknessPreset' in p.metadata, false);
    assert.equal('thicknessScale' in p.metadata, false);
    assert.equal(p.metadata.sizePreset, 'medium', 'unrelated metadata survives');
  });
  it('does not mutate the object it is given', () => {
    const o = make('hline'); const before = JSON.stringify(o);
    M.patchThickness(o, 77);
    assert.equal(JSON.stringify(o), before);
  });
  it('isValidThickness: the single definition of a usable thickness', () => {
    assert.equal(M.isValidThickness(0.0001), true);
    assert.equal(M.isValidThickness(1e12), true);
    [0, -2, NaN, Infinity, '4', null].forEach((v) => assert.equal(M.isValidThickness(v), false));
  });
});

describe('[DETERMINISTIC] outline: one shared model for every shape', () => {
  it('an object with no outline data has the outline OFF (with defaults ready), and nothing is invented by reading it', () => {
    const legacy = createDefaultObject('rectangle', 0.5, 0.5);
    const before = JSON.stringify(legacy);
    const o = M.getOutline(legacy);
    assert.deepEqual(o, { enabled: false, color: DEFAULT_OUTLINE_COLOR, thickness: DEFAULT_OUTLINE_THICKNESS });
    assert.equal(M.outlineActive(o), false);
    assert.equal(JSON.stringify(legacy), before);
  });
  it('every applicable shape supports an outline; text does not', () => {
    OUTLINE_TYPES.forEach((t) => assert.equal(supports(t, 'outline'), true, t));
    assert.equal(supports('text', 'outline'), false);
  });
  it('enabled, colour and thickness are independent of each other and of the fill colour', () => {
    OUTLINE_TYPES.filter((t) => t !== 'fingerBand').forEach((type) => {
      let o = make(type);
      const fill = o.color;
      o = { ...o, ...M.patchOutline(o, { enabled: true }) };
      assert.deepEqual(M.getOutline(o), { enabled: true, color: DEFAULT_OUTLINE_COLOR, thickness: DEFAULT_OUTLINE_THICKNESS }, type);
      o = { ...o, ...M.patchOutline(o, { color: '#12a594' }) };
      assert.deepEqual([M.getOutline(o).enabled, M.getOutline(o).color, M.getOutline(o).thickness], [true, '#12a594', DEFAULT_OUTLINE_THICKNESS], `${type}: colour only`);
      o = { ...o, ...M.patchOutline(o, { thickness: 250 }) };
      assert.deepEqual([M.getOutline(o).enabled, M.getOutline(o).color, M.getOutline(o).thickness], [true, '#12a594', 250], `${type}: thickness only`);
      o = { ...o, ...M.patchOutline(o, { enabled: false }) };
      assert.equal(M.outlineActive(M.getOutline(o)), false, `${type}: switching off keeps colour/thickness for next time`);
      assert.deepEqual([M.getOutline(o).color, M.getOutline(o).thickness], ['#12a594', 250]);
      assert.equal(o.color, fill, `${type}: the fill is untouched by every outline change`);
    });
  });
  it('outline thickness has no maximum', () => {
    const o = { ...make('hline'), ...M.patchOutline(make('hline'), { enabled: true, thickness: 1e7 }) };
    assert.equal(M.getOutline(o).thickness, 1e7);
  });
  it('invalid outline values are ignored: bad colour, zero / negative / NaN / text thickness, non-boolean enabled', () => {
    const o = { ...make('hline'), ...M.patchOutline(make('hline'), { enabled: true, color: '#abcdef', thickness: 9 }) };
    const after = { ...o, ...M.patchOutline(o, { enabled: 'yes', color: 'red', thickness: 0 }) };
    assert.deepEqual(M.getOutline(after), M.getOutline(o));
    [-3, NaN, Infinity, 'x'].forEach((t) => assert.equal(M.getOutline({ ...o, ...M.patchOutline(o, { thickness: t }) }).thickness, 9));
  });
  it('an outline patch on text does nothing, and never mutates its input', () => {
    assert.deepEqual(M.patchOutline(make('text'), { enabled: true }), {});
    const o = make('hline'); const before = JSON.stringify(o);
    M.patchOutline(o, { enabled: true });
    assert.equal(JSON.stringify(o), before);
  });
  it('a malformed stored outline reads back as safe defaults, never throws', () => {
    [null, 5, 'x', [], { enabled: 'maybe', color: 3, thickness: -9 }].forEach((raw) => {
      assert.deepEqual(M.normalizeOutline(raw), { enabled: false, color: DEFAULT_OUTLINE_COLOR, thickness: DEFAULT_OUTLINE_THICKNESS });
    });
  });
});

describe('[DETERMINISTIC] Dot + attached rings: an array, zero gap, no maximum', () => {
  const dotR = (o) => (o.width / 2) * W;

  it('the Dot + Ring tool creates ONE dot object with a rings ARRAY holding one default ring (and no legacy ring / no gap field)', () => {
    const o = make('dotRing');
    assert.equal(o.type, 'dot');
    assert.ok(Array.isArray(o.metadata.rings));
    assert.equal(o.metadata.rings.length, 1);
    assert.equal('ring' in o.metadata, false);
    assert.deepEqual(Object.keys(o.metadata.rings[0]).sort(), ['color', 'outline', 'thickness']);
    assert.equal(o.metadata.rings[0].thickness, DEFAULT_RING_THICKNESS);
    assert.equal(M.hasRings(o), true);
    assert.equal(M.hasActiveRing(o), false, 'the legacy single-ring check does not claim the new model');
  });

  it('"+ Add Ring" appends the next ring with defaults, as many times as asked — 250 rings, no maximum', () => {
    let o = make('dot');
    assert.equal(M.hasRings(o), false);
    for (let i = 0; i < 250; i += 1) o = { ...o, ...M.addRing(o) };
    assert.equal(M.getRings(o).length, 250);
    M.getRings(o).forEach((r) => assert.equal(r.thickness, DEFAULT_RING_THICKNESS));
  });

  it('new rings take colours from the one palette, cycling, so neighbours differ', () => {
    let o = make('dot');
    for (let i = 0; i < 8; i += 1) o = { ...o, ...M.addRing(o) };
    const colors = M.getRings(o).map((r) => r.color);
    assert.ok(colors.every((c) => COLOR_PALETTE.some((p) => p.value === c)));
    colors.slice(1).forEach((c, i) => assert.notEqual(c, colors[i], `ring ${i + 2} differs from ring ${i + 1}`));
  });

  it('ZERO GAP: ring 1 touches the dot and every ring touches the previous one — exactly, for many rings and mixed thicknesses', () => {
    let o = make('dot');
    const thicknesses = [10, 3, 40, 0.5, 120, 7, 7, 19.25];
    thicknesses.forEach((t) => { o = { ...o, ...M.addRing(o) }; o = { ...o, ...M.patchRingAt(o, M.getRings(o).length - 1, { thickness: t }) }; });
    const layers = M.compositeRingLayers(o, W);
    assert.equal(layers.length, thicknesses.length);
    layers.forEach((L, i) => {
      assert.equal(L.innerRadius, i === 0 ? dotR(o) : layers[i - 1].outerRadius, `ring ${i + 1}'s inner edge is exactly the previous outer edge`);
      near(L.outerRadius - L.innerRadius, thicknesses[i], 1e-9, `ring ${i + 1} thickness`);
      near(L.radius, L.innerRadius + thicknesses[i] / 2, 1e-9, `ring ${i + 1} centre-line radius`);
      assert.equal(L.legacy, false);
    });
    near(M.compositeOuterRadius(o, W), dotR(o) + thicknesses.reduce((a, b) => a + b, 0), 1e-9, 'outer radius = dot + the sum of every ring thickness');
  });

  it('there is no gap anywhere in the model: no field on a ring, and no function to set one for the new rings', () => {
    let o = make('dotRing'); o = { ...o, ...M.addRing(o) };
    M.getRings(o).forEach((r) => assert.equal('gap' in r || 'gapPreset' in r || 'gapScale' in r, false));
    o.metadata.rings.forEach((r) => assert.equal('gap' in r, false));
    M.compositeRingLayers(o, W).forEach((L) => assert.equal('gap' in L, false));
  });

  it('each ring has its own independent colour, thickness and outline; changing one never touches another', () => {
    let o = make('dot');
    for (let i = 0; i < 3; i += 1) o = { ...o, ...M.addRing(o) };
    const before = M.getRings(o);
    o = { ...o, ...M.patchRingAt(o, 1, { color: '#111111', thickness: 55, outline: { enabled: true, color: '#ffffff', thickness: 9 } }) };
    const after = M.getRings(o);
    assert.deepEqual(after[0], before[0]);
    assert.deepEqual(after[2], before[2]);
    assert.equal(after[1].color, '#111111');
    assert.equal(after[1].thickness, 55);
    assert.deepEqual(after[1].outline, { enabled: true, color: '#ffffff', thickness: 9 });
  });

  it('ring thickness and ring outline thickness are free (no maximum); invalid values are ignored', () => {
    let o = { ...make('dot'), ...M.addRing(make('dot')) };
    o = { ...o, ...M.patchRingAt(o, 0, { thickness: 987654, outline: { enabled: true, thickness: 555555 } }) };
    assert.equal(M.getRings(o)[0].thickness, 987654);
    assert.equal(M.getRings(o)[0].outline.thickness, 555555);
    const same = { ...o, ...M.patchRingAt(o, 0, { thickness: -1, color: 'nope', outline: { thickness: 0 } }) };
    assert.deepEqual(M.getRings(same), M.getRings(o));
    assert.deepEqual(M.patchRingAt(o, 99, { thickness: 5 }).metadata.rings, o.metadata.rings, 'an out-of-range ring index changes nothing');
  });

  it('a ring can be removed, and removing the last one leaves a plain dot', () => {
    let o = make('dotRing'); o = { ...o, ...M.addRing(o) };
    o = { ...o, ...M.removeRingAt(o, 0) };
    assert.equal(M.getRings(o).length, 1);
    o = { ...o, ...M.removeRingAt(o, 0) };
    assert.equal(M.hasRings(o), false);
    assert.equal(M.compositeRingLayers(o, W).length, 0);
  });

  it('only a dot can carry rings', () => {
    assert.deepEqual(M.addRing(make('hline')), {});
    assert.deepEqual(M.patchRingAt(make('ring'), 0, { thickness: 4 }), {});
    assert.deepEqual(M.getRings(make('ring')), []);
  });

  it('malformed stored rings are skipped or defaulted when read, never thrown on', () => {
    const o = { ...make('dot'), metadata: { rings: [null, 7, { color: 'red', thickness: -4 }, { color: '#1a73e8', thickness: 10 }] } };
    const rings = M.getRings(o);
    assert.equal(rings.length, 2, 'null and 7 are skipped');
    assert.equal(rings[0].color, o.color, 'a bad colour falls back to the dot colour');
    assert.equal(rings[0].thickness, DEFAULT_RING_THICKNESS, 'a bad thickness falls back to the default');
  });

  it('every patch deep-clones: two objects never share a ring (or its outline) by reference', () => {
    const a = { ...make('dot'), ...M.addRing(make('dot')) };
    const b = { ...a, ...M.patchRingAt(a, 0, { thickness: 99 }) };
    assert.notEqual(a.metadata.rings, b.metadata.rings);
    assert.notEqual(a.metadata.rings[0], b.metadata.rings[0]);
    assert.notEqual(a.metadata.rings[0].outline, b.metadata.rings[0].outline);
    assert.equal(a.metadata.rings[0].thickness, DEFAULT_RING_THICKNESS, 'the original is untouched');
  });

  it('resizing the composite scales the dot AND every ring thickness / outline thickness by the same factor, so the stack keeps its proportions and stays attached', () => {
    let o = make('dotRing'); o = { ...o, ...M.addRing(o) };
    o = { ...o, ...M.patchRingAt(o, 0, { outline: { enabled: true, thickness: 6 } }) };
    const before = M.compositeRingLayers(o, W);
    const grown = { ...o, ...M.patchCompositeResize(o, 2) };
    assert.equal(grown.width, +(o.width * 2).toFixed(4));
    assert.deepEqual(M.getRings(grown).map((r) => r.thickness), M.getRings(o).map((r) => r.thickness * 2));
    assert.equal(M.getRings(grown)[0].outline.thickness, 12);
    const after = M.compositeRingLayers(grown, W);
    near(after[1].outerRadius / before[1].outerRadius, 2, 1e-3, 'the whole stack doubled');
    assert.equal(after[1].innerRadius, after[0].outerRadius, 'still attached after resizing');
    assert.equal(o.metadata.rings[0].thickness, DEFAULT_RING_THICKNESS, 'the original is untouched');
  });
});

describe('[DETERMINISTIC] legacy single ring next to the new model', () => {
  it('a legacy ring object is recognised, is NOT treated as new, and its layer keeps its gap (renders as before)', () => {
    const o = makeLegacyRing();
    assert.equal(M.isLegacyRingObject(o), true);
    assert.equal(M.hasRings(o), false);
    const [L] = M.compositeRingLayers(o, W);
    assert.equal(L.legacy, true);
    const ring = M.getRing(o);
    assert.equal(L.innerRadius, (o.width / 2) * W + M.effectiveRingGapPx(o, ring, W), 'dot radius + the legacy effective gap');
  });
  it('convertLegacyRing makes the old ring the FIRST attached ring: colour and thickness carry over, the old gap does not', () => {
    const o = { ...makeLegacyRing(), ...M.patchRingColor(makeLegacyRing(), '#12a594') };
    const c = { ...o, ...M.convertLegacyRing(o) };
    assert.equal('ring' in c.metadata, false);
    assert.equal(M.getRings(c).length, 1);
    assert.equal(M.getRings(c)[0].color, '#12a594');
    assert.equal(M.getRings(c)[0].thickness, M.getRing(o).thickness);
    assert.equal(M.compositeRingLayers(c, W)[0].innerRadius, (c.width / 2) * W, 'now touching the dot');
    assert.equal(M.isLegacyRingObject(c), false);
  });
  it('"+ Add Ring" on a legacy object converts it first, so nothing is lost: ring 1 is the old ring, ring 2 is new', () => {
    const o = { ...makeLegacyRing(), ...M.patchRingColor(makeLegacyRing(), '#8e4ec6') };
    const a = { ...o, ...M.addRing(o) };
    assert.equal(M.getRings(a).length, 2);
    assert.equal(M.getRings(a)[0].color, '#8e4ec6');
  });
  it('editing one ring of a legacy object converts it too (the older ring becomes ring 1, then the change applies)', () => {
    const o = makeLegacyRing();
    const p = { ...o, ...M.patchRingAt(o, 0, { thickness: 33 }) };
    assert.equal(M.getRings(p)[0].thickness, 33);
    assert.equal('ring' in p.metadata, false);
  });
  it('convertLegacyRing on an object that is not legacy does nothing', () => {
    assert.deepEqual(M.convertLegacyRing(make('dotRing')), {});
    assert.deepEqual(M.convertLegacyRing(make('dot')), {});
  });
  it('merely READING a legacy object (layers, rings, outline) never rewrites it', () => {
    const o = makeLegacyRing(); const before = JSON.stringify(o);
    M.compositeRingLayers(o, W); M.getRings(o); M.getOutline(o); M.isLegacyRingObject(o);
    assert.equal(JSON.stringify(o), before);
  });
});
