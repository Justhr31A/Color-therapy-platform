/**
 * [DETERMINISTIC SOFTWARE TESTS] Studio JSON import validation (src/builder/model/importExport.js) — the REAL module.
 * A file is untrusted input: it must never crash the Studio, never be applied half-way, and never smuggle in bad data.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateImport, parseAndValidateImport, buildExport, EXPORT_FORMAT, EXPORT_VERSION, IMPORT_LIMITS } from '../src/builder/model/importExport.js';
import { createStudioObject, patchRingEnabled, addRing, patchRingAt, patchOutline, getRings } from '../src/builder/model/objectModel.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canvases = [
  { id: 'c1', viewKey: 'left_front', width: 1586, height: 1982, objects: [] },
  { id: 'c2', viewKey: 'right_front', width: 1585, height: 1983, objects: [] },
];
const ctx = { viewKey: 'left_front', canvasWidth: 1586, canvasHeight: 1982 };
const obj = (tool = 'dot', x = 0.4, y = 0.5) => createStudioObject(tool, x, y, ctx);
/** A dot in the OLDER single-spaced-ring format (`metadata.ring`). */
const legacyRingObj = () => { const d = obj('dot'); return { ...d, ...patchRingEnabled(d, true) }; };
const file = (views) => ({ format: EXPORT_FORMAT, version: EXPORT_VERSION, views });
const view = (viewKey, objects) => ({ viewKey, objects });
const errorsFor = (data) => { const r = validateImport(data, canvases); assert.equal(r.ok, false, 'expected rejection'); return r.errors.join(' | '); };

describe('[DETERMINISTIC] a good file', () => {
  it('is accepted, mapped onto the protocol\'s own canvases, and every object gets a NEW id', () => {
    const src = [obj('dot'), obj('dotRing'), obj('text'), obj('hline')];
    const r = validateImport(file([view('left_front', src), view('right_front', [obj('ring')])]), canvases);
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.deepEqual(r.views.map((v) => [v.canvasId, v.viewKey, v.objects.length]), [['c1', 'left_front', 4], ['c2', 'right_front', 1]]);
    const newIds = r.views.flatMap((v) => v.objects.map((o) => o.id));
    assert.equal(new Set(newIds).size, 5);
    newIds.forEach((id) => assert.match(id, UUID_RE));
    assert.equal(newIds.filter((id) => src.some((s) => s.id === id)).length, 0);
  });

  it('round-trips every Studio value (ring, size, scale, thickness, text) exactly', () => {
    const ring = obj('dotRing');
    const text = obj('text'); text.metadata.text = 'Hold — 3 min\nrelease';
    const r = validateImport(file([view('left_front', [ring, text])]), canvases);
    const [a, b] = r.views[0].objects;
    assert.deepEqual(a.metadata, ring.metadata);
    assert.equal(b.metadata.text, 'Hold — 3 min\nrelease');
    assert.deepEqual([a.width, a.height, a.color, a.thickness, a.opacity], [ring.width, ring.height, ring.color, ring.thickness, ring.opacity]);
  });

  it('a LEGACY Dot + Ring with independent colours and an explicit gap survives import exactly', () => {
    const dr = legacyRingObj();
    dr.color = '#e5484d';
    dr.metadata.ring = { ...dr.metadata.ring, color: '#1a73e8', gapPreset: 'large', gapScale: 1, gap: 28 };
    const r = validateImport(file([view('left_front', [dr])]), canvases);
    assert.equal(r.ok, true, r.errors.join('; '));
    const [got] = r.views[0].objects;
    assert.equal(got.color, '#e5484d');
    assert.deepEqual([got.metadata.ring.color, got.metadata.ring.gapPreset, got.metadata.ring.gapScale, got.metadata.ring.gap], ['#1a73e8', 'large', 1, 28]);
  });

  it('a legacy Dot + Ring with no ring.color and no gap fields at all still imports, falling back to the dot colour', () => {
    const legacy = {
      type: 'dot', x: 0.4, y: 0.5, color: '#e5484d', width: 0.03, thickness: 0,
      metadata: { sizePreset: 'medium', scale: 1, ring: { enabled: true, sizePreset: 'large', scale: 1, width: 0.12, thicknessPreset: 'medium', thicknessScale: 1, thickness: 4 } },
    };
    assert.equal('color' in legacy.metadata.ring, false, 'the fixture really has no ring colour of its own');
    const r = validateImport(file([view('left_front', [legacy])]), canvases);
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.views[0].objects[0].metadata.ring.color, '#e5484d', 'falls back to the dot colour, per the backward-compatibility requirement');
  });

  it('an export built by the Studio validates as an import of itself', () => {
    const cs = canvases.map((c, i) => ({ ...c, objects: [obj(i ? 'ring' : 'dotRing')] }));
    const exported = JSON.parse(JSON.stringify(buildExport({ name: 'P', protocolType: 'hand' }, cs)));
    assert.equal(validateImport(exported, canvases).ok, true);
    assert.equal(exported.protocol.name, 'P');
  });

  it('legacy finger "pinky" is imported as "little"; unknown extra fields are dropped; missing optional fields get defaults', () => {
    const o = { type: 'ring', x: 0.3, y: 0.3, color: '#e5484d', finger: 'pinky', hackerField: 'x', __proto__2: 1 };
    const r = validateImport(file([view('left_front', [o])]), canvases);
    assert.equal(r.ok, true, r.errors.join('; '));
    const clean = r.views[0].objects[0];
    assert.equal(clean.finger, 'little');
    assert.equal('hackerField' in clean, false);
    assert.deepEqual([clean.opacity, clean.rotation, clean.thickness, clean.width, clean.landmarkReference, clean.metadata], [1, 0, 3, null, null, {}]);
  });

  it('the result does not share nested data with the file that was read', () => {
    const src = obj('dotRing');
    const r = validateImport(file([view('left_front', [src])]), canvases);
    assert.notEqual(r.views[0].objects[0].metadata, src.metadata);
    assert.notEqual(r.views[0].objects[0].metadata.rings, src.metadata.rings);
    assert.notEqual(r.views[0].objects[0].metadata.rings[0], src.metadata.rings[0]);
    assert.notEqual(r.views[0].objects[0].metadata.rings[0].outline, src.metadata.rings[0].outline);
    const legacy = legacyRingObj();
    assert.notEqual(validateImport(file([view('left_front', [legacy])]), canvases).views[0].objects[0].metadata.ring, legacy.metadata.ring);
  });
});

describe('[DETERMINISTIC] bad files are refused with a clear reason', () => {
  it('not a protocol file at all', () => {
    [null, undefined, 5, 'str', true, [], {}, { format: 'something-else', version: 1, views: [] }].forEach((d) => {
      const r = validateImport(d, canvases);
      assert.equal(r.ok, false);
      assert.deepEqual(r.views, []);
    });
  });
  it('a newer file version than this Studio understands', () => {
    assert.match(errorsFor({ format: EXPORT_FORMAT, version: EXPORT_VERSION + 1, views: [view('left_front', [])] }), /version/);
  });
  it('a view this protocol does not have, a repeated view, missing/invalid lists', () => {
    assert.match(errorsFor(file([view('nose', [])])), /no "nose" view/);
    assert.match(errorsFor(file([view('left_front', []), view('left_front', [])])), /more than once/);
    assert.match(errorsFor(file([{ viewKey: 'left_front' }])), /objects/);
    assert.match(errorsFor(file([{ objects: [] }])), /viewKey/);
    assert.match(errorsFor(file('nope')), /views/);
  });
  it('an unknown object type', () => {
    assert.match(errorsFor(file([view('left_front', [{ ...obj(), type: 'hologram' }])])), /unknown object type "hologram"/);
  });
  it('coordinates outside the canvas, bad sizes, opacity and colours', () => {
    const bads = [
      [{ x: 2 }, /\.x/], [{ y: -0.1 }, /\.y/], [{ x: 'a' }, /\.x/], [{ x: NaN }, /\.x/], [{ x: Infinity }, /\.x/],
      [{ width: 0 }, /width/], [{ width: 5 }, /width/], [{ height: -1 }, /height/],
      [{ opacity: 3 }, /opacity/], [{ thickness: -2 }, /thickness/], [{ thickness: Infinity }, /thickness/], [{ thickness: '8' }, /thickness/],
      [{ rotation: 'x' }, /rotation/], [{ color: 'red' }, /color/], [{ color: '#12' }, /color/], [{ color: 5 }, /color/],
      [{ finger: 'elbow' }, /finger/], [{ landmarkReference: 'x' }, /landmarkReference/], [{ metadata: 'x' }, /metadata/], [{ metadata: [] }, /metadata/],
    ];
    bads.forEach(([patch, re]) => assert.match(errorsFor(file([view('left_front', [{ ...obj(), ...patch }])])), re, JSON.stringify(patch)));
  });
  it('a free line without enough valid points', () => {
    const line = { ...obj('freeline'), points: [{ x: 0.1, y: 0.1 }] };
    assert.match(errorsFor(file([view('left_front', [line])])), /points/);
    assert.match(errorsFor(file([view('left_front', [{ ...line, points: [{ x: 0.1, y: 0.1 }, { x: 9, y: 0 }] }])])), /points/);
    assert.match(errorsFor(file([view('left_front', [{ ...line, points: 'x' }])])), /points/);
  });
  it('invalid Studio structures: xl preset, bad scale, malformed ring, bad band, over-long text', () => {
    const withMeta = (base, meta) => ({ ...base, metadata: { ...base.metadata, ...meta } });
    const cases = [
      [withMeta(obj('dot'), { sizePreset: 'xxl' }), /sizePreset/], [withMeta(obj('dot'), { sizePreset: 'XL' }), /sizePreset/],
      [withMeta(obj('dot'), { thicknessPreset: 'huge' }), /thicknessPreset/],
      [withMeta(obj('dot'), { scale: 0 }), /scale/],
      [withMeta(obj('dot'), { scale: 50 }), /scale/],
      [withMeta(obj('dot'), { thicknessScale: -1 }), /thicknessScale/],
      [withMeta(legacyRingObj(), { ring: { enabled: 'yes' } }), /ring/],
      [withMeta(legacyRingObj(), { ring: { ...legacyRingObj().metadata.ring, color: 'blue' } }), /ring\.color/],
      [withMeta(legacyRingObj(), { ring: { ...legacyRingObj().metadata.ring, width: 4 } }), /ring\.width/],
      [withMeta(legacyRingObj(), { ring: 'x' }), /ring/],
      [withMeta(legacyRingObj(), { ring: { ...legacyRingObj().metadata.ring, gapPreset: 'xl' } }), /gapPreset/], // the older gap model never had an Extra Large
      [withMeta(legacyRingObj(), { ring: { ...legacyRingObj().metadata.ring, gapScale: 0 } }), /gapScale/],
      [withMeta(legacyRingObj(), { ring: { ...legacyRingObj().metadata.ring, gapScale: -1 } }), /gapScale/],
      [withMeta(legacyRingObj(), { ring: { ...legacyRingObj().metadata.ring, gap: -5 } }), /gap/],
      [withMeta(legacyRingObj(), { ring: { ...legacyRingObj().metadata.ring, gap: 'wide' } }), /gap/],
      [withMeta(obj('text'), { text: 'x'.repeat(201) }), /text/],
      [withMeta(obj('text'), { text: 5 }), /text/],
    ];
    cases.forEach(([o, re]) => assert.match(errorsFor(file([view('left_front', [o])])), re));
    const band = obj('fingerBand', 0.36, 0.3);
    [{ type: 'spiral' }, { position: 2 }, { rotationOffset: 'x' }].forEach((b) => {
      assert.match(errorsFor(file([view('left_front', [{ ...band, metadata: { ...band.metadata, band: { ...band.metadata.band, ...b } } }])])), /band/);
    });
  });
  it('too many objects in a view, and the error list itself is capped', () => {
    const many = Array.from({ length: IMPORT_LIMITS.MAX_OBJECTS_PER_VIEW + 1 }, () => obj());
    assert.match(errorsFor(file([view('left_front', many)])), /too many objects/);
    const broken = Array.from({ length: 200 }, () => ({ type: 'nope' }));
    const r = validateImport(file([view('left_front', broken)]), canvases);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length <= IMPORT_LIMITS.MAX_ERRORS);
  });
  it('ONE bad object rejects the whole file (nothing is applied half-way)', () => {
    const r = validateImport(file([view('left_front', [obj(), { ...obj(), x: 9 }, obj()])]), canvases);
    assert.equal(r.ok, false);
    assert.deepEqual(r.views, []);
  });
  it('text that is not JSON is reported, not thrown', () => {
    ['', '{', 'nope', '[1,2', '\u0000'].forEach((t) => assert.deepEqual(parseAndValidateImport(t, canvases).errors, ['file: is not valid JSON.']));
  });
});

describe('[DETERMINISTIC] fuzz: hostile input never crashes the importer', () => {
  // Deterministic pseudo-random so a failure is reproducible.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const weird = () => pick([null, undefined, 0, -1, 1e999, NaN, '', 'x', '#e5484d', true, false, [], {}, [null], { x: 0.5 }, () => 1, Symbol('s'), 10n ** 20n, 'a'.repeat(50000), { toString() { throw new Error('boom'); } }]);

  it('survives 3000 randomly corrupted files and only ever answers ok:true with fully-clean objects', () => {
    const base = JSON.parse(JSON.stringify(file([view('left_front', [obj('dotRing'), legacyRingObj(), { ...obj('hline'), ...patchOutline(obj('hline'), { enabled: true, thickness: 7 }) }, obj('text'), obj('fingerBand', 0.36, 0.3)]), view('right_front', [obj('freeline')])])));
    const mutate = (node, depth = 0) => {
      if (node && typeof node === 'object' && depth < 6) {
        const keys = Object.keys(node);
        const k = pick(keys);
        const roll = rnd();
        if (roll < 0.4) node[k] = weird();
        else if (roll < 0.5) delete node[k];
        else if (roll < 0.6) node[`extra${Math.floor(rnd() * 5)}`] = weird();
        else mutate(node[k], depth + 1);
      }
    };
    let accepted = 0; let rejected = 0;
    for (let i = 0; i < 3000; i += 1) {
      const copy = JSON.parse(JSON.stringify(base));
      for (let m = 0, n = 1 + Math.floor(rnd() * 4); m < n; m += 1) mutate(copy);
      const r = validateImport(copy, canvases);            // must not throw
      assert.equal(typeof r.ok, 'boolean');
      if (r.ok) {
        accepted += 1;
        r.views.flatMap((v) => v.objects).forEach((o) => {
          assert.match(o.id, UUID_RE);
          assert.ok(o.x >= 0 && o.x <= 1 && o.y >= 0 && o.y <= 1, 'coordinates in range');
          assert.match(o.color, /^#[0-9a-f]{3,8}$/i);
          assert.ok(o.opacity >= 0 && o.opacity <= 1);
          assert.deepEqual(JSON.parse(JSON.stringify(o)), o, 'JSON-safe');
        });
      } else {
        rejected += 1;
        assert.ok(r.errors.length > 0 && r.views.length === 0);
      }
    }
    assert.ok(accepted > 0 && rejected > 0, `both outcomes exercised (accepted ${accepted}, rejected ${rejected})`);
  });

  it('survives non-object top-level garbage and parse-level garbage', () => {
    [Symbol('x'), () => 1, 10n, new Date(), new Map(), Object.create(null), { format: EXPORT_FORMAT, version: EXPORT_VERSION, get views() { throw new Error('getter'); } }].forEach((d) => {
      const r = validateImport(d, canvases);
      assert.equal(r.ok, false);
    });
  });
});


// =====================================================================================================================
// Sharing/PDF task: attached rings, outline, Extra Large and unlimited thickness in files.
// =====================================================================================================================
describe('[DETERMINISTIC] files with rings, outlines, XL and very large thickness', () => {
  const manyRings = (n) => { let o = obj('dotRing'); for (let i = 1; i < n; i += 1) o = { ...o, ...addRing(o) }; return o; };
  const imported = (o) => { const r = validateImport(file([view('left_front', [o])]), canvases); assert.equal(r.ok, true, r.errors.join('; ')); return r.views[0].objects[0]; };

  it('a Dot + many rings round-trips an export → import exactly, with every ring\'s colour, thickness and outline', () => {
    let o = manyRings(25);
    o = { ...o, ...patchRingAt(o, 3, { color: '#111111', thickness: 4321, outline: { enabled: true, color: '#ffffff', thickness: 77 } }) };
    o = { ...o, ...patchOutline(o, { enabled: true, color: '#12a594', thickness: 15 }) };
    const exported = JSON.parse(JSON.stringify(buildExport({ name: 'P', protocolType: 'hand' }, [{ ...canvases[0], objects: [o] }, { ...canvases[1], objects: [] }])));
    const back = validateImport(exported, canvases);
    assert.equal(back.ok, true, back.errors.join('; '));
    const got = back.views[0].objects[0];
    assert.equal(got.type, 'dot', 'still one dot object');
    assert.deepEqual(got.metadata.rings, o.metadata.rings);
    assert.deepEqual(got.metadata.outline, o.metadata.outline);
    assert.notEqual(got.id, o.id, 'fresh id');
  });

  it('there is no ring-count limit: 600 rings import fine', () => {
    const o = manyRings(600);
    assert.equal(getRings(imported(o)).length, 600);
  });

  it('there is no thickness limit: huge object, ring and outline thickness all import unchanged', () => {
    let o = { ...obj('hline'), thickness: 7_000_000 };
    o = { ...o, ...patchOutline(o, { enabled: true, thickness: 2_500_000 }) };
    const g = imported(o);
    assert.equal(g.thickness, 7_000_000);
    assert.equal(g.metadata.outline.thickness, 2_500_000);
    const r = manyRings(2);
    const rr = { ...r, ...patchRingAt(r, 1, { thickness: 9_999_999 }) };
    assert.equal(getRings(imported(rr))[1].thickness, 9_999_999);
  });

  it('every size including "xl" (Extra Large) imports; anything else is refused', () => {
    ['small', 'medium', 'large', 'xl'].forEach((sizePreset) => {
      const o = obj('dot'); o.metadata = { ...o.metadata, sizePreset };
      assert.equal(imported(o).metadata.sizePreset, sizePreset);
    });
  });

  it('a ring imported without a colour takes the dot\'s colour (same fallback rule as the older ring); its outline defaults stay off', () => {
    const o = manyRings(2); o.color = '#46a758';
    delete o.metadata.rings[0].color; delete o.metadata.rings[1].color;
    const g = imported(o);
    assert.deepEqual(g.metadata.rings.map((r) => r.color), ['#46a758', '#46a758']);
  });

  it('every shape type accepts an outline on import', () => {
    ['dot', 'ring', 'hline', 'vline', 'arrow', 'triangle', 'invertedTriangle', 'rectangle', 'square'].forEach((tool) => {
      const o = obj(tool); const withO = { ...o, ...patchOutline(o, { enabled: true, color: '#00ff00', thickness: 12 }) };
      assert.deepEqual(imported(withO).metadata.outline, { enabled: true, color: '#00ff00', thickness: 12 }, tool);
    });
  });

  it('refuses malformed rings: not a list, entries that are not objects, bad / missing / zero / negative thickness, bad colour, bad ring outline', () => {
    const base = obj('dotRing');
    const bad = [
      [{ rings: 'x' }, /rings must be a list/], [{ rings: [3] }, /ring 1 must be an object/], [{ rings: [{ color: '#1a73e8' }] }, /thickness/],
      [{ rings: [{ thickness: 0 }] }, /thickness/], [{ rings: [{ thickness: -1 }] }, /thickness/], [{ rings: [{ thickness: '5' }] }, /thickness/],
      [{ rings: [{ thickness: 5, color: 'blue' }] }, /colour/], [{ rings: [{ thickness: 5, outline: 'x' }] }, /outline must be an object/],
      [{ rings: [{ thickness: 5, outline: { enabled: 1 } }] }, /outline\.enabled/], [{ rings: [{ thickness: 5, outline: { color: 'red' } }] }, /outline\.color/],
      [{ rings: [{ thickness: 5, outline: { thickness: 0 } }] }, /outline\.thickness/],
    ];
    bad.forEach(([meta, re]) => assert.match(errorsFor(file([view('left_front', [{ ...base, metadata: { ...base.metadata, ...meta } }])])), re, JSON.stringify(meta)));
  });

  it('refuses a malformed outline on a shape: not an object, non-boolean enabled, bad colour, zero / negative / text thickness', () => {
    const base = obj('hline');
    [['x', /outline must be an object/], [{ enabled: 'yes' }, /outline\.enabled/], [{ color: 'black' }, /outline\.color/], [{ thickness: 0 }, /outline\.thickness/], [{ thickness: -3 }, /outline\.thickness/], [{ thickness: 'x' }, /outline\.thickness/]]
      .forEach(([outline, re]) => assert.match(errorsFor(file([view('left_front', [{ ...base, metadata: { ...base.metadata, outline } }])])), re, JSON.stringify(outline)));
  });

  it('a file with an older single ring AND new rings objects side by side imports both, each in its own format', () => {
    const r = validateImport(file([view('left_front', [legacyRingObj(), obj('dotRing')])]), canvases);
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.ok(r.views[0].objects[0].metadata.ring);
    assert.ok(Array.isArray(r.views[0].objects[1].metadata.rings));
  });
});
