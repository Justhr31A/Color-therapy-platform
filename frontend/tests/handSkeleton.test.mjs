/**
 * [DETERMINISTIC SOFTWARE TESTS] the 21-point reference skeletons and the skeleton (per-region) mapping.
 * Synthetic geometry with exact expected answers — no camera, no MediaPipe.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN_REFERENCE_LANDMARKS, LANDMARK_NAMES, getReferenceLandmarks, readLocalOverride, isValidLandmarkTable, LOCAL_OVERRIDE_KEY,
} from '../src/tracking/referenceLandmarks.js';
import { REFERENCE_HAND_POINTS } from '../src/tracking/referenceHandPoints.js';
import {
  BONES, REGION_IDS, PALM, regionLabel, segmentDistance, pointInPolygon, fitAffine, applyAffine, affineScale, boneAffine,
  computeRegionTransforms, computeSkinWeights, blendAffine, blendReliability, palmLength,
} from '../src/tracking/handSkeleton.js';
import { prepareArView, computeArFrame } from '../src/tracking/arFrame.js';
import { computeCoverMapping, videoPointToCanvas, canvasBufferSize, clientPointToVideo } from '../src/tracking/videoCover.js';
import { describeAnchor, anchorPatch, AMBIGUOUS_BELOW } from '../src/builder/model/anchors.js';
import { assertClose } from './support/helpers.mjs';

const DIMS = { left_front: [1586, 1982], right_front: [1585, 1983], left_back: [1585, 1981], right_back: [1971, 2010] };
const refPx = (view) => getReferenceLandmarks(view).map((p) => ({ x: p.x * DIMS[view][0], y: p.y * DIMS[view][1] }));
const similarity = (s, deg, tx, ty) => { const r = (deg * Math.PI) / 180; return (p) => ({ x: s * (Math.cos(r) * p.x - Math.sin(r) * p.y) + tx, y: s * (Math.sin(r) * p.x + Math.cos(r) * p.y) + ty }); };
const rotateAbout = (p, o, deg) => { const r = (deg * Math.PI) / 180; const x = p.x - o.x; const y = p.y - o.y; return { x: o.x + Math.cos(r) * x - Math.sin(r) * y, y: o.y + Math.sin(r) * x + Math.cos(r) * y }; };

describe('[DETERMINISTIC] 21-point reference skeletons', () => {
  it('one 21-point table per view, every point inside the image, MediaPipe order', () => {
    assert.deepEqual(Object.keys(BUILT_IN_REFERENCE_LANDMARKS).sort(), Object.keys(DIMS).sort());
    assert.equal(LANDMARK_NAMES.length, 21);
    for (const v of Object.keys(DIMS)) assert.ok(isValidLandmarkTable(BUILT_IN_REFERENCE_LANDMARKS[v]), v);
  });
  it('anatomical order: along every finger the joints run MCP → tip away from the wrist, and the wrist is lowest', () => {
    for (const v of Object.keys(DIMS)) {
      const P = refPx(v);
      for (const start of [5, 9, 13, 17]) {
        for (let k = 0; k < 3; k += 1) assert.ok(P[start + k + 1].y < P[start + k].y, `${v} ${LANDMARK_NAMES[start + k + 1]} above ${LANDMARK_NAMES[start + k]}`);
      }
      assert.ok(P.every((p, i) => i === 0 || p.y < P[0].y), `${v}: wrist is the lowest point`);
      // the thumb chain moves monotonically away from the wrist
      const d = (i) => Math.hypot(P[i].x - P[0].x, P[i].y - P[0].y);
      assert.ok(d(1) < d(2) && d(2) < d(3) && d(3) < d(4), `${v}: thumb chain`);
    }
  });
  it('left_front / right_front are exact mirror images; the 6 legacy points are DERIVED from the 21 (one source of truth)', () => {
    BUILT_IN_REFERENCE_LANDMARKS.left_front.forEach(([x, y], i) => {
      assertClose(x + BUILT_IN_REFERENCE_LANDMARKS.right_front[i][0], 1, 1e-9); assertClose(y, BUILT_IN_REFERENCE_LANDMARKS.right_front[i][1], 1e-9);
    });
    for (const v of Object.keys(DIMS)) {
      const t = BUILT_IN_REFERENCE_LANDMARKS[v];
      assert.deepEqual(REFERENCE_HAND_POINTS[v].wrist, { x: t[0][0], y: t[0][1] });
      assert.deepEqual(REFERENCE_HAND_POINTS[v].thumbMCP, { x: t[2][0], y: t[2][1] });
      assert.deepEqual(REFERENCE_HAND_POINTS[v].pinkyMCP, { x: t[17][0], y: t[17][1] });
    }
  });
  it('regression guard for the two measured root causes: wrist at the wrist CENTRE, thumb MCP not near the thumb tip', () => {
    for (const v of Object.keys(DIMS)) {
      const P = refPx(v);
      const L = palmLength(P);
      // the wrist sits between the palm's two sides (index MCP / little MCP x-range), not on the edge
      const lo = Math.min(P[5].x, P[17].x); const hi = Math.max(P[5].x, P[17].x);
      assert.ok(P[0].x > lo + 0.15 * (hi - lo) && P[0].x < hi - 0.15 * (hi - lo), `${v}: wrist x is central`);
      // the thumb MCP is closer to the wrist than the thumb IP and far from the tip
      assert.ok(Math.hypot(P[2].x - P[4].x, P[2].y - P[4].y) > 0.3 * L, `${v}: thumb MCP is not at the tip`);
    }
  });
  it('a device-local admin override is read safely and only for valid tables; storage errors never throw', () => {
    const table = BUILT_IN_REFERENCE_LANDMARKS.left_front.map(([x, y]) => [x, Math.min(1, y + 0.01)]);
    const store = { getItem: (k) => (k === LOCAL_OVERRIDE_KEY ? JSON.stringify({ left_front: table, right_back: [[2, 2]] }) : null) };
    const o = readLocalOverride(store);
    assert.deepEqual(Object.keys(o), ['left_front']);
    assertClose(getReferenceLandmarks('left_front', o)[0].y, table[0][1], 1e-12);
    assert.equal(getReferenceLandmarks('right_back', o)[0].x, BUILT_IN_REFERENCE_LANDMARKS.right_back[0][0]);
    assert.equal(readLocalOverride({ getItem: () => { throw new Error('blocked'); } }), null);
    assert.equal(readLocalOverride({ getItem: () => '{not json' }), null);
    assert.equal(readLocalOverride(null), null);
    assert.equal(getReferenceLandmarks('body_front'), null);
  });
});

describe('[DETERMINISTIC] geometry primitives', () => {
  it('segment distance and point-in-polygon', () => {
    assert.deepEqual(segmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), { d: 3, t: 0.5 });
    assert.equal(segmentDistance({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }).d, 5);
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    assert.equal(pointInPolygon({ x: 5, y: 5 }, sq), true);
    assert.equal(pointInPolygon({ x: 15, y: 5 }, sq), false);
  });
  it('fitAffine recovers an exact affine (incl. shear / different x-y scale) from ≥ 3 points; null when degenerate', () => {
    const M = { a: 1.3, b: 0.2, c: -0.4, d: 0.8, e: 50, f: -20 };
    const ref = [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 30, y: 90 }, { x: 70, y: 60 }];
    const fit = fitAffine(ref, ref.map((p) => applyAffine(M, p)));
    for (const k of Object.keys(M)) assertClose(fit[k], M[k], 1e-9, k);
    assert.equal(fitAffine([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]), null);
  });
  it('boneAffine maps the reference bone exactly onto the live bone; across the bone it scales by the given hand scale', () => {
    const m = boneAffine({ x: 0, y: 0 }, { x: 0, y: -100 }, { x: 200, y: 200 }, { x: 260, y: 120 }, 0.5);
    const a = applyAffine(m, { x: 0, y: 0 }); const b = applyAffine(m, { x: 0, y: -100 });
    assertClose(a.x, 200, 1e-9); assertClose(a.y, 200, 1e-9); assertClose(b.x, 260, 1e-9); assertClose(b.y, 120, 1e-9);
    // a point 20 px to the side of the bone ends up 10 px to the side (across scale 0.5), along-bone length 100→100
    const side = applyAffine(m, { x: 20, y: -50 }); const mid = applyAffine(m, { x: 0, y: -50 });
    assertClose(Math.hypot(side.x - mid.x, side.y - mid.y), 10, 1e-9);
  });
  it('display geometry: devicePixelRatio buffer keeps the box aspect; a click maps back to the exact video pixel (mirrored or not)', () => {
    assert.deepEqual(canvasBufferSize(400, 300, 2.5), { width: 800, height: 600, ratio: 2 });
    assert.deepEqual(canvasBufferSize(400, 300, undefined), { width: 400, height: 300, ratio: 1 });
    const buf = canvasBufferSize(390, 700, 3);
    const cover = computeCoverMapping(1280, 720, buf.width, buf.height);
    const v = { x: 700, y: 400 };
    const c = videoPointToCanvas(v.x / 1280, v.y / 720, 1280, 720, cover); // buffer px
    const css = { x: c.x / buf.ratio, y: c.y / buf.ratio };
    const back = clientPointToVideo(css.x, css.y, { cssWidth: 390, bufferRatio: buf.ratio }, cover);
    assertClose(back.x, v.x, 1e-9); assertClose(back.y, v.y, 1e-9);
    const backM = clientPointToVideo(390 - css.x, css.y, { cssWidth: 390, bufferRatio: buf.ratio, mirrored: true }, cover);
    assertClose(backM.x, v.x, 1e-9); assertClose(backM.y, v.y, 1e-9);
  });
});

describe('[DETERMINISTIC] skinning weights (which part of the hand a marking follows)', () => {
  const P = refPx('left_front');
  const mid = (a, b, t = 0.5) => ({ x: P[a].x + (P[b].x - P[a].x) * t, y: P[a].y + (P[b].y - P[a].y) * t });

  it('a marking in the middle of a phalanx follows that phalanx; one in the palm follows the palm', () => {
    for (const bone of BONES) {
      const w = computeSkinWeights(mid(bone.a, bone.b), P);
      assert.equal(w.primary, bone.id, bone.id);
      if (!bone.id.startsWith('thumb.metacarpal')) assert.ok(w.confidence > 0.6, `${bone.id} confidence ${w.confidence}`);
    }
    const palmC = { x: (P[0].x + P[9].x) / 2, y: (P[0].y + P[9].y) / 2 };
    assert.equal(computeSkinWeights(palmC, P).primary, PALM);
  });
  it('weights sum to 1, are sorted, and a neighbouring finger gets (almost) nothing', () => {
    const w = computeSkinWeights(mid(10, 11), P); // middle finger, middle segment
    assertClose(w.weights.reduce((s, x) => s + x.w, 0), 1, 1e-9);
    assert.ok(w.weights.every((x, i, a) => i === 0 || a[i - 1].w >= x.w));
    assert.equal(w.weights.some((x) => x.region.startsWith('index') || x.region.startsWith('ring')), false);
  });
  it('on a joint the marking blends the two bones (continuity), and moving along the finger changes weights smoothly', () => {
    const atPip = computeSkinWeights(P[10], P);
    const regions = atPip.weights.map((x) => x.region);
    assert.ok(regions.includes('middle.proximal') && regions.includes('middle.middle'));
    let prev = null;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const p = { x: P[9].x + (P[11].x - P[9].x) * t, y: P[9].y + (P[11].y - P[9].y) * t };
      const w = Object.fromEntries(computeSkinWeights(p, P).weights.map((x) => [x.region, x.w]));
      if (prev) for (const k of new Set([...Object.keys(w), ...Object.keys(prev)])) assert.ok(Math.abs((w[k] || 0) - (prev[k] || 0)) < 0.35, `jump at t=${t.toFixed(2)} ${k}`);
      prev = w;
    }
  });
  it('a doctor-pinned anchor overrides blending; a finger band only considers its own finger', () => {
    assert.deepEqual(computeSkinWeights(mid(10, 11), P, { anchor: { region: 'ring.distal' } }).weights, [{ region: 'ring.distal', w: 1 }]);
    const w = computeSkinWeights(mid(14, 15), P, { finger: 'index' }); // a point on the ring finger, band says index
    assert.ok(w.weights.every((x) => x.region.startsWith('index.')));
    assert.ok(REGION_IDS.length === 16 && regionLabel('index.middle') === 'Index finger – middle segment' && regionLabel('nope') === null);
  });
  it('blending: identical region transforms blend to themselves; reliability is the weighted mean', () => {
    const M = { a: 2, b: 0, c: 0, d: 2, e: 5, f: 6 };
    const out = blendAffine([{ region: 'palm', w: 0.3 }, { region: 'index.middle', w: 0.7 }], { palm: M, 'index.middle': M });
    for (const k of Object.keys(M)) assertClose(out[k], M[k], 1e-12);
    assertClose(blendReliability([{ region: 'palm', w: 0.5 }, { region: 'index.middle', w: 0.5 }], { 'index.middle': 0 }), 0.5, 1e-12);
  });
});

describe('[DETERMINISTIC] skeleton mapping vs the old whole-hand fit', () => {
  const view = 'left_front';
  const [W, H] = DIMS[view];
  const P = refPx(view);
  const T = similarity(0.3, 12, 600, 380);
  const VIDEO = { width: 1280, height: 720 };
  const canvas = (objects) => ({ viewKey: view, canvasType: 'hand', width: W, height: H, objects });
  const dot = (id, p) => ({ id, type: 'dot', x: p.x / W, y: p.y / H, width: 0.02, color: '#00f', opacity: 1, zIndex: 1 });
  const result = (live) => ({ landmarks: [live.map((p) => ({ x: p.x / VIDEO.width, y: p.y / VIDEO.height, z: 0 }))], handedness: [[{ categoryName: 'Left', score: 0.95 }]] });
  const run = (objects, live, mapping) => computeArFrame({ result: result(live), view: prepareArView(canvas(objects)), video: VIDEO, mapping });
  const posOf = (f, id) => { const m = f.mapped.find((x) => x.id === id); return { x: m.x * VIDEO.width, y: m.y * VIDEO.height }; };

  it('a rigidly moved hand: every region transform equals the hand motion (exact), so nothing drifts', () => {
    const live = P.map(T);
    const tr = computeRegionTransforms(P, live);
    for (const id of REGION_IDS) {
      for (const q of [P[0], P[8], { x: 500, y: 700 }]) { const a = applyAffine(tr[id], q); const b = T(q); assertClose(a.x, b.x, 1e-6, id); assertClose(a.y, b.y, 1e-6, id); }
      assertClose(affineScale(tr[id]), 0.3, 1e-9, id);
    }
  });

  it('a BENT index finger (middle + tip segments rotated 35° at the PIP): its marking follows; the old whole-hand fit does not', () => {
    const tipMark = { x: P[7].x + (P[8].x - P[7].x) * 0.5, y: P[7].y + (P[8].y - P[7].y) * 0.5 }; // on the index tip segment
    const bent = P.map((p, i) => (i >= 7 && i <= 8 ? rotateAbout(p, P[6], 35) : p));
    const truth = T(rotateAbout(tipMark, P[6], 35));
    const live = bent.map(T);
    const pw = Math.hypot(live[17].x - live[5].x, live[17].y - live[5].y);
    const sk = posOf(run([dot('m', tipMark)], live, 'skeleton'), 'm');
    const si = posOf(run([dot('m', tipMark)], live, 'similarity'), 'm');
    const eSk = Math.hypot(sk.x - truth.x, sk.y - truth.y) / pw;
    const eSi = Math.hypot(si.x - truth.x, si.y - truth.y) / pw;
    assert.ok(eSk < 0.02, `skeleton error ${eSk}`);
    assert.ok(eSi > 0.2, `whole-hand fit error should be large, got ${eSi}`);
  });

  it('a LONGER middle finger (+15 %, the person\'s own proportions): a fingertip marking stays on the tip', () => {
    const mark = { x: P[11].x + (P[12].x - P[11].x) * 0.6, y: P[11].y + (P[12].y - P[11].y) * 0.6 };
    const longer = (p) => ({ x: P[9].x + (p.x - P[9].x) * 1.15, y: P[9].y + (p.y - P[9].y) * 1.15 });
    const live = P.map((p, i) => (i >= 10 && i <= 12 ? longer(p) : p)).map(T);
    const truth = T(longer(mark));
    const pw = Math.hypot(live[17].x - live[5].x, live[17].y - live[5].y);
    const sk = posOf(run([dot('m', mark)], live, 'skeleton'), 'm');
    assert.ok(Math.hypot(sk.x - truth.x, sk.y - truth.y) / pw < 0.01);
  });

  it('a WIDER palm (+12 % across, shear-free stretch): palm markings stay put (the palm affine absorbs proportions)', () => {
    const u = { x: P[9].x - P[0].x, y: P[9].y - P[0].y }; const l = Math.hypot(u.x, u.y); const ux = u.x / l; const uy = u.y / l;
    const wide = (p) => { const dx = p.x - P[0].x; const dy = p.y - P[0].y; const a = dx * ux + dy * uy; const b = (-dx * uy + dy * ux) * 1.12; return { x: P[0].x + a * ux - b * uy, y: P[0].y + a * uy + b * ux }; };
    const mark = { x: (P[0].x + P[9].x + P[13].x) / 3, y: (P[0].y + P[9].y + P[13].y) / 3 };
    const live = P.map(wide).map(T);
    const truth = T(wide(mark));
    const pw = Math.hypot(live[17].x - live[5].x, live[17].y - live[5].y);
    const sk = posOf(run([dot('m', mark)], live, 'skeleton'), 'm');
    assert.ok(Math.hypot(sk.x - truth.x, sk.y - truth.y) / pw < 0.01);
  });

  it('a ring keeps its proportions on its own finger and a pinned palm marking ignores a moving finger', () => {
    const ringMark = { ...dot('r', { x: P[6].x * 0.5 + P[7].x * 0.5, y: P[6].y * 0.5 + P[7].y * 0.5 }), type: 'ring', width: 0.06, thickness: 6 };
    const pinned = { ...dot('p', P[6]), landmarkReference: { region: 'palm', source: 'doctor' } };
    const live = P.map(T);
    const f = run([ringMark, pinned], live, 'skeleton');
    const r = f.mapped.find((m) => m.id === 'r');
    assertClose((r.radius * VIDEO.width) / ((0.06 / 2) * W), 0.3, 1e-6);
    assertClose((r.strokeWidth * VIDEO.width) / 6, 0.3, 1e-6);
    // bend the index finger: the pinned palm marking (sitting on the PIP in the drawing) must not move
    const bent = P.map((p, i) => (i >= 6 && i <= 8 ? rotateAbout(p, P[5], 30) : p)).map(T);
    const p1 = posOf(f, 'p'); const p2 = posOf(run([ringMark, pinned], bent, 'skeleton'), 'p');
    assertClose(p1.x, p2.x, 1e-6); assertClose(p1.y, p2.y, 1e-6);
  });
});

describe('[DETERMINISTIC] Studio camera anchors (stored in landmarkReference)', () => {
  const [W, H] = DIMS.left_front;
  const P = refPx('left_front');
  const canvas = { viewKey: 'left_front', canvasType: 'hand', width: W, height: H };
  const at = (p) => ({ id: 'o', type: 'dot', x: p.x / W, y: p.y / H, landmarkReference: null });

  it('automatic anchor names the region; a spot between regions is flagged as ambiguous rather than guessed', () => {
    const onPhalanx = describeAnchor(at({ x: (P[10].x + P[11].x) / 2, y: (P[10].y + P[11].y) / 2 }), canvas);
    assert.equal(onPhalanx.mode, 'auto'); assert.equal(onPhalanx.region, 'middle.middle'); assert.equal(onPhalanx.ambiguous, false);
    // at the root of the middle finger, just past its knuckle: is it "palm" or "finger base"? Genuinely ambiguous.
    const root = { x: P[9].x + (P[10].x - P[9].x) * 0.12, y: P[9].y + (P[10].y - P[9].y) * 0.12 };
    const between = describeAnchor(at(root), canvas);
    assert.equal(between.ambiguous, true, `confidence ${between.confidence} should be < ${AMBIGUOUS_BELOW}`);
    assert.ok(between.alternatives.length >= 2);
  });
  it('pinning and un-pinning are plain patches; a pin that no longer matches the marking\'s place is reported', () => {
    assert.deepEqual(anchorPatch('index.distal'), { landmarkReference: { region: 'index.distal', source: 'doctor' } });
    assert.deepEqual(anchorPatch(null), { landmarkReference: null });
    assert.deepEqual(anchorPatch('not-a-region'), { landmarkReference: null });
    const o = { ...at(P[8]), landmarkReference: { region: 'index.distal', source: 'doctor' } };
    assert.equal(describeAnchor(o, canvas).mismatch, false);
    assert.equal(describeAnchor({ ...o, x: P[20].x / W, y: P[20].y / H }, canvas).mismatch, true);
    assert.equal(describeAnchor(o, { viewKey: 'body_front', canvasType: 'organ', width: 10, height: 10 }).mode, 'none');
  });
});

describe('[DETERMINISTIC] perspective palm (homography)', async () => {
  const { fitHomography, applyHomography, linearizeHomography, homographyIsSane, computePalmHomography, fitAffine: fitA, PALM_POLYGON: POLY } = await import('../src/tracking/handSkeleton.js');
  const P = refPx('left_front');
  const Htrue = [0.31, 0.05, 210, -0.04, 0.29, 80, 0.00012, -0.00008, 1];
  it('recovers an exact projective map from the palm landmarks, and its linearisation is exact at the point', () => {
    const src = POLY.map((i) => P[i]); const dst = src.map((p) => applyHomography(Htrue, p));
    const H = fitHomography(src, dst);
    for (const q of [P[0], { x: 700, y: 1200 }, P[13]]) {
      const a = applyHomography(H, q); const b = applyHomography(Htrue, q);
      assertClose(a.x, b.x, 1e-6); assertClose(a.y, b.y, 1e-6);
      const L = linearizeHomography(H, q); const l = applyAffine(L, q);
      assertClose(l.x, b.x, 1e-6); assertClose(l.y, b.y, 1e-6);
    }
  });
  it('a tilted (foreshortened) palm: perspective beats the affine on palm markings', () => {
    const live = P.map((p) => applyHomography(Htrue, p));
    const affine = fitA(POLY.map((i) => P[i]), POLY.map((i) => live[i]), [1, 0.5, 1, 1, 1, 1]);
    const H = computePalmHomography(P, live, affine);
    assert.ok(H, 'accepted');
    const m = { x: (P[0].x + P[5].x + P[17].x) / 3, y: (P[0].y + P[5].y + P[17].y) / 3 };
    const truth = applyHomography(Htrue, m);
    const eH = Math.hypot(applyHomography(H, m).x - truth.x, applyHomography(H, m).y - truth.y);
    const eA = Math.hypot(applyAffine(affine, m).x - truth.x, applyAffine(affine, m).y - truth.y);
    assert.ok(eH < 1e-6 && eA > 1, `perspective ${eH} vs affine ${eA}`);
  });
  it('an ill-conditioned fit (a palm landmark thrown far off) is rejected → the affine is used', () => {
    const live = P.map((p) => applyHomography(Htrue, p));
    live[17] = { x: live[17].x + 400, y: live[17].y - 300 };
    const affine = fitA(POLY.map((i) => P[i]), POLY.map((i) => live[i]), [1, 0.5, 1, 1, 1, 1]);
    const H = fitHomography(POLY.map((i) => P[i]), POLY.map((i) => live[i]), [1, 0.5, 1, 1, 1, 1]);
    assert.equal(homographyIsSane(H, P, affine, live), false);
    assert.equal(fitHomography(POLY.slice(0, 3).map((i) => P[i]), POLY.slice(0, 3).map((i) => live[i])), null, 'needs ≥ 4 points');
  });
});
