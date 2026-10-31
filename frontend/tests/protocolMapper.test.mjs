/**
 * [DETERMINISTIC SOFTWARE TESTS] protocol mapping (src/tracking/protocolMapper.js) — the REAL module.
 * Verifies the math of mapping saved protocol objects onto a synthetic "live hand". It does NOT prove the
 * overlay is placed correctly on a real person's hand — see docs/REAL_DEVICE_VALIDATION.md.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapProtocolObjects } from '../src/tracking/protocolMapper.js';
import { computeSimilarityTransform, transformScale } from '../src/tracking/similarityTransform.js';
import { assertClose, rst, refPixelsFor, HAND_ASSETS, VIEW_KEYS, VIDEO } from './support/helpers.mjs';
import { RING_GAP_BASES } from '../src/builder/config/sizePresets.js';

const ALL_TYPES = ['dot', 'ring', 'hline', 'vline', 'freeline', 'invertedTriangle', 'triangle', 'rectangle', 'square', 'arrow'];
// The AR layer currently maps ONLY these. Update this list deliberately when a new type gets AR support.
const AR_SUPPORTED = ['dot', 'ring'];

const TRANSFORMS = {
  translation: [1, 0, 300, 200],
  rotation: [1, 0.6, 400, 250],
  scaling: [2.4, 0, 350, 300],
  combined: [0.245, -0.45, 640, 250],
};

function setup(view, [s, theta, tx, ty]) {
  const ref = refPixelsFor(view);
  const transform = computeSimilarityTransform(ref, ref.map((p) => rst(p, s, theta, tx, ty)));
  const { width, height } = HAND_ASSETS[view];
  return { transform, refW: width, refH: height, truth: (nx, ny) => rst({ x: nx * width, y: ny * height }, s, theta, tx, ty) };
}
const map = (objs, ctx) => mapProtocolObjects(objs, ctx.transform, ctx.refW, ctx.refH, VIDEO.width, VIDEO.height);

const dot = { id: 'd1', type: 'dot', x: 0.5, y: 0.62, width: 0.03, height: 0.03, thickness: 0, color: '#e5484d', opacity: 0.7, rotation: 0 };
const ring = { id: 'r1', type: 'ring', x: 0.45, y: 0.5, width: 0.08, height: 0.08, thickness: 4, color: '#1a73e8', opacity: 0.9, rotation: 0 };

describe('[DETERMINISTIC] dot mapping', () => {
  for (const view of VIEW_KEYS) {
    for (const [name, params] of Object.entries(TRANSFORMS)) {
      it(`${view} · ${name}: center and radius are exactly the ground truth`, () => {
        const ctx = setup(view, params);
        const [m] = map([dot], ctx);
        const want = ctx.truth(dot.x, dot.y);
        assertClose(m.x * VIDEO.width, want.x, 1e-5, 'center x px'); assertClose(m.y * VIDEO.height, want.y, 1e-5, 'center y px');
        assertClose(m.radius * VIDEO.width, (dot.width / 2) * ctx.refW * params[0], 1e-5, 'radius px');
        assert.equal(m.type, 'dot'); assert.equal(m.id, 'd1'); assert.equal(m.color, '#e5484d'); assert.equal(m.opacity, 0.7);
      });
    }
  }
  it('falls back to the default dot size (0.03) when width is missing', () => {
    const ctx = setup('left_front', TRANSFORMS.scaling);
    const [m] = map([{ ...dot, width: null }], ctx);
    assertClose(m.radius * VIDEO.width, (0.03 / 2) * ctx.refW * 2.4, 1e-5);
  });
});

describe('[DETERMINISTIC] ring (circle) mapping', () => {
  for (const view of VIEW_KEYS) {
    for (const [name, params] of Object.entries(TRANSFORMS)) {
      it(`${view} · ${name}: center, radius and stroke width scale by the transform`, () => {
        const ctx = setup(view, params);
        const [m] = map([ring], ctx);
        const want = ctx.truth(ring.x, ring.y);
        assertClose(m.x * VIDEO.width, want.x, 1e-5, 'center x px'); assertClose(m.y * VIDEO.height, want.y, 1e-5, 'center y px');
        assertClose(m.radius * VIDEO.width, (ring.width / 2) * ctx.refW * params[0], 1e-5, 'radius px');
        // thickness is stored in ABSOLUTE reference pixels (schema.sql), so it scales by the transform scale directly
        assertClose(m.strokeWidth * VIDEO.width, ring.thickness * params[0], 1e-5, 'stroke px');
        assert.equal(m.type, 'ring'); assert.equal(m.color, '#1a73e8'); assert.equal(m.opacity, 0.9);
      });
    }
  }
  it('falls back to the default ring size (0.08) and thickness (4) when missing', () => {
    const ctx = setup('left_front', TRANSFORMS.scaling);
    const [m] = map([{ ...ring, width: null, thickness: 0 }], ctx);
    assertClose(m.radius * VIDEO.width, (0.08 / 2) * ctx.refW * 2.4, 1e-5);
    assertClose(m.strokeWidth * VIDEO.width, 4 * 2.4, 1e-5);
  });
});

describe('[DETERMINISTIC] Dot + Ring mapping', () => {
  // A Dot + Ring is still ONE object of type 'dot' — the ring lives in metadata.ring, exactly as Protocol
  // Studio and the published protocol store it. Nothing here is a second, AR-specific representation.
  const dotRing = (ringOverrides = {}) => ({
    id: 'dr1', type: 'dot', x: 0.5, y: 0.62, width: 0.03, height: 0.03, thickness: 0, color: '#e5484d', opacity: 0.8, rotation: 0,
    metadata: { ring: { enabled: true, color: '#1a73e8', sizePreset: 'large', scale: 1, width: 0.12, thicknessPreset: 'medium', thicknessScale: 1, thickness: 4, ...ringOverrides } },
  });
  const refDotRadiusPx = (ctx) => (0.03 / 2) * ctx.refW;
  const expectedRingRadiusPx = (ctx, ring, gapPx) => refDotRadiusPx(ctx) + gapPx + ring.thickness / 2;

  it('a plain dot (no metadata.ring) never gets a ring field — Dot-only AR is byte-identical to before', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const [m] = map([dot], ctx);
    assert.equal('ring' in m, false);
  });

  it('a legacy STANDALONE ring object (type "ring", not a composite) still maps exactly as before', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const [m] = map([ring], ctx);
    assert.equal(m.type, 'ring');
    assertClose(m.radius * VIDEO.width, (ring.width / 2) * ctx.refW * TRANSFORMS.combined[0], 1e-5);
  });

  it('a disabled ring on a dot maps as a plain dot: no ring field at all', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const [m] = map([dotRing({ enabled: false })], ctx);
    assert.equal(m.type, 'dot');
    assert.equal('ring' in m, false);
  });

  it('a Dot + Ring with independent colours maps each colour independently', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const o = dotRing({ color: '#1a73e8' });
    const [m] = map([{ ...o, color: '#e5484d' }], ctx);
    assert.equal(m.color, '#e5484d', 'the dot keeps its own colour');
    assert.equal(m.ring.color, '#1a73e8', 'the ring keeps its own, independent colour');
  });

  it('a LEGACY ring with no colour of its own falls back to the dot colour, same as Protocol Studio', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const o = dotRing();
    delete o.metadata.ring.color;
    const [m] = map([{ ...o, color: '#46a758' }], ctx);
    assert.equal(m.ring.color, '#46a758');
  });

  it('an explicit gap changes the mapped ring radius, and small/medium/large map to exactly the right reference-pixel gap (then scaled)', () => {
    const ctx = setup('left_front', TRANSFORMS.scaling);
    ['small', 'medium', 'large'].forEach((preset) => {
      const gapPx = RING_GAP_BASES[preset];
      const o = dotRing({ gapPreset: preset, gapScale: 1, gap: gapPx });
      const [m] = map([o], ctx);
      const wantRefRadius = expectedRingRadiusPx(ctx, o.metadata.ring, gapPx);
      assertClose(m.ring.radius * VIDEO.width, wantRefRadius * TRANSFORMS.scaling[0], 1e-6, `${preset} gap`);
    });
  });

  it('a custom gap scale maps to exactly base-times-scale, then through the transform', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const gapPx = RING_GAP_BASES.medium * 1.75;
    const o = dotRing({ gapPreset: 'medium', gapScale: 1.75, gap: gapPx });
    const [m] = map([o], ctx);
    const wantRefRadius = expectedRingRadiusPx(ctx, o.metadata.ring, gapPx);
    assertClose(m.ring.radius * VIDEO.width, wantRefRadius * TRANSFORMS.combined[0], 1e-6);
  });

  it('ring thickness is preserved: the mapped stroke width equals the reference thickness scaled by the transform, exactly like a standalone ring', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const o = dotRing({ thickness: 9 });
    const [m] = map([o], ctx);
    assertClose(m.ring.strokeWidth * VIDEO.width, 9 * TRANSFORMS.combined[0], 1e-6);
  });

  it('a LEGACY Dot + Ring with no gap fields at all derives the gap its existing width already implies, so it renders at the SAME size as before this feature existed', () => {
    const ctx = setup('left_front', TRANSFORMS.scaling);
    const o = dotRing(); // no gap/gapPreset/gapScale — only the pre-gap sizePreset/scale/width fields
    assert.equal('gap' in o.metadata.ring, false);
    const [m] = map([o], ctx);
    // What the OLD (pre-gap) mapping would have produced, straight from ring.width:
    const oldRefRadiusPx = (o.metadata.ring.width / 2) * ctx.refW;
    assertClose(m.ring.radius * VIDEO.width, oldRefRadiusPx * TRANSFORMS.scaling[0], 1e-4, 'no visual change for legacy data');
  });

  for (const [name, params] of Object.entries(TRANSFORMS)) {
    it(`${name}: moving/rotating/scaling the hand carries the dot AND its ring together, using the SAME transform`, () => {
      const ctx = setup('left_front', params);
      const o = dotRing({ gapPreset: 'medium', gapScale: 1, gap: RING_GAP_BASES.medium });
      const [m] = map([o], ctx);
      const want = ctx.truth(o.x, o.y);
      assertClose(m.x * VIDEO.width, want.x, 1e-5, 'dot centre');
      assertClose(m.y * VIDEO.height, want.y, 1e-5, 'dot centre');
      // The ring has no position of its own — it is centred on the SAME transformed point as the dot.
      assertClose(m.x * VIDEO.width, want.x, 1e-5, 'ring shares the dot\'s transformed centre');
      const wantRefRadius = expectedRingRadiusPx(ctx, o.metadata.ring, RING_GAP_BASES.medium);
      assertClose(m.ring.radius * VIDEO.width, wantRefRadius * params[0], 1e-5, 'ring radius scales with the fitted transform');
      assertClose(m.ring.strokeWidth * VIDEO.width, o.metadata.ring.thickness * params[0], 1e-5, 'ring stroke scales with the fitted transform');
    });
  }

  it('does not mutate the saved Dot + Ring object it is given', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const o = dotRing({ gapPreset: 'large', gapScale: 1, gap: RING_GAP_BASES.large });
    const frozen = Object.freeze({ ...o, metadata: Object.freeze({ ring: Object.freeze({ ...o.metadata.ring }) }) });
    const before = JSON.stringify(frozen);
    assert.doesNotThrow(() => map([frozen], ctx));
    assert.equal(JSON.stringify(frozen), before);
  });

  it('the mapped output is the SAME published object mapped once — a Dot + Ring never becomes two array entries', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const mapped = map([dotRing()], ctx);
    assert.equal(mapped.length, 1, 'one input object, one mapped entry — the ring never becomes a second, separate mapped object');
    assert.equal(mapped[0].type, 'dot');
    assert.equal('id' in mapped[0].ring, false, 'the ring is a property of the dot, not its own addressable mapped object');
  });
});

describe('[DETERMINISTIC] all currently supported object types', () => {
  const objectOf = (type, i) => ({ id: `o-${type}`, type, x: 0.2 + i * 0.05, y: 0.3, width: 0.1, height: 0.1, rotation: 0, color: '#000', thickness: 3, opacity: 1, points: type === 'freeline' ? [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] : null });

  it('of the 10 protocol object types, exactly dot and ring are mapped to the live hand today; the other 8 are skipped (not crashed on)', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const mapped = map(ALL_TYPES.map(objectOf), ctx);
    assert.deepEqual(mapped.map((m) => m.type).sort(), [...AR_SUPPORTED].sort());
  });
  it('an unknown/future object type is ignored rather than throwing', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    assert.deepEqual(map([{ id: 'x', type: 'hologram', x: 0.5, y: 0.5 }], ctx), []);
  });
});

describe('[DETERMINISTIC] mapper hygiene', () => {
  it('dot output is byte-identical whether or not a ring is on the same canvas (no cross-contamination)', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const alone = map([dot], ctx)[0];
    const together = map([dot, ring], ctx).find((m) => m.type === 'dot');
    assert.deepEqual(together, alone);
  });
  it('does not mutate the saved protocol objects it is given', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const frozen = [Object.freeze({ ...dot }), Object.freeze({ ...ring })];
    const before = JSON.stringify(frozen);
    assert.doesNotThrow(() => map(frozen, ctx));
    assert.equal(JSON.stringify(frozen), before);
  });
  it('returns [] for missing inputs instead of throwing', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    assert.deepEqual(mapProtocolObjects(null, ctx.transform, 1, 1, 1, 1), []);
    assert.deepEqual(mapProtocolObjects([dot], null, 1, 1, 1, 1), []);
    assert.deepEqual(mapProtocolObjects([dot], ctx.transform, 0, 1, 1, 1), []);
    assert.deepEqual(mapProtocolObjects([dot], ctx.transform, 1, 1, 1, 0), []);
    assert.deepEqual(map([], ctx), []);
  });
  it('outputs are normalized to the VIDEO frame: a hand centred in the frame yields values inside 0..1', () => {
    const ctx = setup('left_front', [0.2, 0, VIDEO.width / 2 - 150, VIDEO.height / 2 - 200]);
    const [m] = map([dot], ctx);
    assert.ok(m.x > 0 && m.x < 1 && m.y > 0 && m.y < 1, `got (${m.x}, ${m.y})`);
  });
  it('the scale used for size equals the fitted transform scale (radius is never estimated separately)', () => {
    const ctx = setup('left_front', TRANSFORMS.combined);
    const [m] = map([ring], ctx);
    assertClose(m.radius * VIDEO.width, (ring.width / 2) * ctx.refW * transformScale(ctx.transform), 1e-9);
  });
});
