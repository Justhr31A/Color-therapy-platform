/**
 * [DETERMINISTIC SOFTWARE TESTS] the public protocol -> live camera AR pipeline, without a camera or a browser.
 *
 * Synthetic MediaPipe results are built by taking a view's reference knuckle points and moving them with a KNOWN
 * similarity transform into a video frame — so the exact place every marking must land is known in advance. This proves
 * the maths and the decisions (which protocol, which view, which hand, when to hide). It does NOT prove what a real
 * camera and a real hand produce — see docs/REAL_DEVICE_VALIDATION.md.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableViews, selectViewCanvas, loadPublishedForCamera, fetchCameraEnabled, cameraPath, cameraSessionFor,
} from '../src/camera/publicCameraData.js';
import { requestCameraStream, acceptOrReleaseStream, stopStream, CAMERA_STATUS } from '../src/camera/useCamera.js';
import { prepareArView, computeArFrame, AR_OBJECT_TYPES, CONFIDENCE_THRESHOLD } from '../src/tracking/arFrame.js';
import { createLandmarkSmoother, palmLengthPx } from '../src/tracking/landmarkSmoothing.js';
import { orderForDrawing, mapObjectsForOverlay } from '../src/tracking/protocolMapper.js';
import { drawProtocolOverlay } from '../src/tracking/drawProtocolOverlay.js';
import { computeCoverMapping } from '../src/tracking/videoCover.js';
import { REFERENCE_HAND_POINTS, CALIBRATION_POINT_ORDER, CALIBRATION_LANDMARK_INDEXES } from '../src/tracking/referenceHandPoints.js';
import { cameraGuidance } from '../src/tracking/cameraGuidance.js';
import { getReferenceLandmarks } from '../src/tracking/referenceLandmarks.js';
import { TRACKER_ERRORS } from '../src/tracking/useHandLandmarker.js';
import { assertClose } from './support/helpers.mjs';

// ---------- fixtures ----------
const DIMS = { left_front: [1586, 1982], right_front: [1585, 1983], left_back: [1585, 1981], right_back: [1971, 2010] };
const canvasFor = (viewKey, objects) => ({ viewKey, canvasType: 'hand', label: viewKey, width: DIMS[viewKey][0], height: DIMS[viewKey][1], objects });
const dot = (o = {}) => ({ id: 'd', type: 'dot', x: 0.45, y: 0.5, width: 0.03, height: 0.03, rotation: 0, color: '#0000ff', opacity: 1, zIndex: 1, metadata: {}, ...o });
const ring = (o = {}) => ({ id: 'r', type: 'ring', x: 0.55, y: 0.3, width: 0.08, height: 0.08, rotation: 0, color: '#ff0000', thickness: 4, opacity: 1, zIndex: 1, metadata: {}, ...o });

const backPainRender = {
  contract: 'protocol-render/1',
  protocol: { slug: 'back-pain', name: 'Back Pain', displayName: 'Back Pain' },
  canvases: [
    canvasFor('left_front', [ring({ id: 'bp-ring', zIndex: 1 }), dot({ id: 'bp-dot', zIndex: 2 })]),
    canvasFor('right_front', []),
    canvasFor('left_back', [dot({ id: 'bp-lb', color: '#00aa00' })]),
    canvasFor('right_back', [dot({ id: 'bp-rb', color: '#aa00aa' })]),
  ],
};
const anxietyRender = {
  contract: 'protocol-render/1',
  protocol: { slug: 'anxiety', name: 'Anxiety', displayName: 'Anxiety' },
  canvases: [canvasFor('left_front', [dot({ id: 'ax-dot', color: '#ffcc00', x: 0.3, y: 0.7 })])],
};
const fakeClient = (handler) => ({ get: async (url) => handler(url) });

/** Known similarity (reference px -> video px): rotate by `deg`, scale by `s`, then place the reference centre at (cx, cy). */
function knownTransform(view, { s = 0.25, deg = 15, cx = 640, cy = 360 } = {}) {
  const [W, H] = DIMS[view];
  const pts = CALIBRATION_POINT_ORDER.map((n) => ({ x: REFERENCE_HAND_POINTS[view][n].x * W, y: REFERENCE_HAND_POINTS[view][n].y * H }));
  const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  const r = (deg * Math.PI) / 180;
  const apply = (p) => {
    const x = p.x - c.x; const y = p.y - c.y;
    return { x: s * (Math.cos(r) * x - Math.sin(r) * y) + cx, y: s * (Math.sin(r) * x + Math.cos(r) * y) + cy };
  };
  return { apply, scale: s };
}

/** A 21-landmark MediaPipe hand: the view's full reference skeleton moved by the known transform `t`. */
function syntheticHand(view, t, videoW, videoH, { mirror = false } = {}) {
  const [W, H] = DIMS[view];
  return getReferenceLandmarks(view).map((ref) => {
    let p = t.apply({ x: ref.x * W, y: ref.y * H });
    if (mirror) p = { x: videoW - p.x, y: p.y }; // the other hand: a mirror image
    return { x: p.x / videoW, y: p.y / videoH, z: 0 };
  });
}
const resultOf = (hands, score = 0.95) => ({ landmarks: hands, handedness: hands.map(() => [{ categoryName: 'Left', score }]) });

// ---------- tests ----------
describe('[DETERMINISTIC] public camera data: which protocol, which view', () => {
  it('lists the hand views a protocol has, in the fixed Left/Right Front, Left/Right Back order', () => {
    const shuffled = [backPainRender.canvases[3], backPainRender.canvases[0], backPainRender.canvases[2], backPainRender.canvases[1]];
    assert.deepEqual(availableViews(shuffled).map((v) => v.viewKey), ['left_front', 'right_front', 'left_back', 'right_back']);
    assert.deepEqual(availableViews(backPainRender.canvases).map((v) => v.markingCount), [2, 0, 1, 1]);
    assert.deepEqual(availableViews([{ viewKey: 'body_front', canvasType: 'organ', width: 10, height: 10, objects: [] }]), []);
    assert.deepEqual(availableViews(null), []);
  });

  it('selects exactly the requested view canvas, or null for one the protocol does not have', () => {
    assert.equal(selectViewCanvas(backPainRender.canvases, 'left_back').objects[0].id, 'bp-lb');
    assert.equal(selectViewCanvas(anxietyRender.canvases, 'right_back'), null);
  });

  it('loads a PUBLISHED protocol through the public render endpoint only — no login, no patient API', async () => {
    const calls = [];
    const out = await loadPublishedForCamera('back-pain', fakeClient((url) => { calls.push(url); return { data: backPainRender }; }));
    assert.deepEqual(calls, ['/public/protocols/back-pain/render']);
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.protocol, { slug: 'back-pain', name: 'Back Pain' });
    assert.equal(out.views.length, 4);
  });

  it('an unpublished / unknown protocol (404) is "notFound"; any other failure is "error"', async () => {
    assert.deepEqual(await loadPublishedForCamera('draft', fakeClient(() => { throw Object.assign(new Error('nf'), { status: 404 }); })), { status: 'notFound' });
    assert.deepEqual(await loadPublishedForCamera('x', fakeClient(() => { throw Object.assign(new Error('boom'), { status: 500 }); })), { status: 'error' });
    assert.deepEqual(await loadPublishedForCamera('x', fakeClient(() => ({ data: { nope: true } }))), { status: 'error' });
  });

  it('the camera is offered only when the backend says it is enabled; failures count as off', async () => {
    assert.equal(await fetchCameraEnabled(fakeClient(() => ({ data: { enabled: true } }))), true);
    assert.equal(await fetchCameraEnabled(fakeClient(() => ({ data: { enabled: false } }))), false);
    assert.equal(await fetchCameraEnabled(fakeClient(() => ({ data: { enabled: 'yes' } }))), false);
    assert.equal(await fetchCameraEnabled(fakeClient(() => { throw new Error('offline'); })), false);
  });

  it('builds the camera address for a protocol view', () => {
    assert.equal(cameraPath('back-pain', 'left_front'), '/protocols/back-pain/camera/left_front');
    assert.equal(cameraPath('back pain'), '/protocols/back%20pain/camera');
  });

  it('opening Camera for Back Pain runs on Back Pain\'s canvas for the selected view, with a switch to every view', () => {
    const loaded = { status: 'ok', protocol: { slug: 'back-pain', name: 'Back Pain' }, canvases: backPainRender.canvases, views: availableViews(backPainRender.canvases) };
    const s = cameraSessionFor(loaded, 'back-pain', 'left_front');
    assert.equal(s.kind, 'session');
    assert.equal(s.title, 'Back Pain');
    assert.equal(s.viewLabel, 'Left Front');
    assert.deepEqual(s.canvas.objects.map((o) => o.id), ['bp-ring', 'bp-dot']);
    assert.deepEqual(s.viewLinks.map((v) => [v.viewKey, v.active]), [['left_front', true], ['right_front', false], ['left_back', false], ['right_back', false]]);
    assert.equal(s.viewLinks[2].to, '/protocols/back-pain/camera/left_back');
  });

  it('switching hand view selects that view\'s own markings and a new session key (fresh session, no stale overlay)', () => {
    const loaded = { status: 'ok', protocol: { slug: 'back-pain', name: 'Back Pain' }, canvases: backPainRender.canvases, views: availableViews(backPainRender.canvases) };
    const a = cameraSessionFor(loaded, 'back-pain', 'left_front');
    const b = cameraSessionFor(loaded, 'back-pain', 'right_back');
    assert.deepEqual(b.canvas.objects.map((o) => o.id), ['bp-rb']);
    assert.notEqual(a.sessionKey, b.sessionKey);
  });

  it('switching protocol (Back Pain -> Anxiety) shows ONLY Anxiety\'s markings, under a different session key', () => {
    const bp = cameraSessionFor({ status: 'ok', protocol: { slug: 'back-pain', name: 'Back Pain' }, canvases: backPainRender.canvases, views: availableViews(backPainRender.canvases) }, 'back-pain', 'left_front');
    const ax = cameraSessionFor({ status: 'ok', protocol: { slug: 'anxiety', name: 'Anxiety' }, canvases: anxietyRender.canvases, views: availableViews(anxietyRender.canvases) }, 'anxiety', 'left_front');
    assert.deepEqual(ax.canvas.objects.map((o) => o.id), ['ax-dot']);
    assert.equal(ax.title, 'Anxiety');
    assert.notEqual(ax.sessionKey, bp.sessionKey);
  });

  it('a missing or unknown view redirects to the protocol\'s first hand view; no hand views at all is reported', () => {
    const loaded = { status: 'ok', protocol: { slug: 'anxiety', name: 'Anxiety' }, canvases: anxietyRender.canvases, views: availableViews(anxietyRender.canvases) };
    assert.deepEqual(cameraSessionFor(loaded, 'anxiety', undefined), { kind: 'redirect', to: '/protocols/anxiety/camera/left_front' });
    assert.deepEqual(cameraSessionFor(loaded, 'anxiety', 'right_back'), { kind: 'redirect', to: '/protocols/anxiety/camera/left_front' });
    assert.deepEqual(cameraSessionFor({ status: 'ok', protocol: { slug: 'x', name: 'X' }, canvases: [], views: [] }, 'x', 'left_front'), { kind: 'noViews' });
    assert.equal(cameraSessionFor({ status: 'notFound' }, 'x', 'left_front'), null);
  });
});

describe('[DETERMINISTIC] one AR frame: detection states', () => {
  const VW = 1280; const VH = 720;
  const view = prepareArView(canvasFor('left_front', [ring({ id: 'r1' }), dot({ id: 'd1' })]));
  const t = knownTransform('left_front');

  it('no hand: "not-detected", nothing to draw', () => {
    for (const result of [null, { landmarks: [], handedness: [] }]) {
      const f = computeArFrame({ result, view, video: { width: VW, height: VH } });
      assert.equal(f.calibration, 'not-detected');
      assert.deepEqual(f.mapped, []);
    }
  });

  it('two hands on the public camera: "multiple-hands", nothing drawn', () => {
    const h = syntheticHand('left_front', t, VW, VH);
    const f = computeArFrame({ result: resultOf([h, h]), view, video: { width: VW, height: VH }, multiHandCheck: true });
    assert.equal(f.calibration, 'multiple-hands');
    assert.deepEqual(f.mapped, []);
  });

  it('a low-confidence detection is not drawn on', () => {
    const f = computeArFrame({ result: resultOf([syntheticHand('left_front', t, VW, VH)], CONFIDENCE_THRESHOLD - 0.01), view, video: { width: VW, height: VH } });
    assert.equal(f.calibration, 'low-confidence');
    assert.deepEqual(f.mapped, []);
  });

  it('the wrong hand (a mirror image) is blocked: "wrong-hand", nothing drawn, reported as the other side', () => {
    const f = computeArFrame({ result: resultOf([syntheticHand('left_front', t, VW, VH, { mirror: true })]), view, video: { width: VW, height: VH } });
    assert.equal(f.calibration, 'wrong-hand');
    assert.equal(f.finalHandSide, 'Right');
    assert.deepEqual(f.mapped, []);
  });

  it('every one of the four views accepts its own hand and rejects the mirror image', () => {
    for (const vk of Object.keys(DIMS)) {
      const v = prepareArView(canvasFor(vk, [dot()]));
      const tv = knownTransform(vk);
      assert.equal(computeArFrame({ result: resultOf([syntheticHand(vk, tv, VW, VH)]), view: v, video: { width: VW, height: VH } }).calibration, 'ok', vk);
      assert.equal(computeArFrame({ result: resultOf([syntheticHand(vk, tv, VW, VH, { mirror: true })]), view: v, video: { width: VW, height: VH } }).calibration, 'wrong-hand', vk);
    }
  });

  it('a view with nothing drawable says so instead of drawing', () => {
    const empty = prepareArView(canvasFor('left_front', [{ id: 'u', type: 'somethingNew', x: 0.5, y: 0.5 }]));
    assert.equal(computeArFrame({ result: resultOf([syntheticHand('left_front', t, VW, VH)]), view: empty, video: { width: VW, height: VH } }).calibration, 'no-objects');
  });

  it('the guidance tells "not found yet" apart from "hand left the view" (tracking loss)', () => {
    assert.equal(cameraGuidance({ calibration: 'not-detected', expectedHandSide: 'Left', hadHand: false }).state, 'searching');
    assert.equal(cameraGuidance({ calibration: 'not-detected', expectedHandSide: 'Left', hadHand: true }).state, 'lost');
    assert.match(cameraGuidance({ calibration: 'wrong-hand', expectedHandSide: 'Left' }).message, /left hand/);
    // with the view known it names the side too (the geometric check cannot tell other hand from other side)
    assert.equal(cameraGuidance({ calibration: 'wrong-hand', expectedHandSide: 'Left', viewKey: 'left_back' }).message, 'Please show your left hand with the back of the hand facing the camera.');
    assert.equal(cameraGuidance({ calibration: 'wrong-hand', expectedHandSide: 'Right', viewKey: 'right_front' }).message, 'Please show your right hand with the palm facing the camera.');
    assert.equal(cameraGuidance({ calibration: 'ok' }).tone, 'ok');
  });
});

describe('[DETERMINISTIC] one AR frame: markings land where the doctor put them', () => {
  const view = prepareArView(canvasFor('left_front', [ring({ id: 'r1', x: 0.55, y: 0.3, width: 0.08, thickness: 4 }), dot({ id: 'd1', x: 0.45, y: 0.5, width: 0.03 })]));
  const [W, H] = DIMS.left_front;

  for (const [VW, VH] of [[1280, 720], [640, 480], [1920, 1080], [720, 1280]]) {
    it(`at ${VW}x${VH}: dot and ring centres, radius and stroke follow the known hand transform exactly`, () => {
      const t = knownTransform('left_front', { s: VW / 5000, deg: -20, cx: VW * 0.45, cy: VH * 0.55 });
      const f = computeArFrame({ result: resultOf([syntheticHand('left_front', t, VW, VH)]), view, video: { width: VW, height: VH } });
      assert.equal(f.calibration, 'ok');
      const d = f.mapped.find((m) => m.id === 'd1');
      const r = f.mapped.find((m) => m.id === 'r1');
      const expD = t.apply({ x: 0.45 * W, y: 0.5 * H });
      const expR = t.apply({ x: 0.55 * W, y: 0.3 * H });
      assertClose(d.x * VW, expD.x, 1e-6); assertClose(d.y * VH, expD.y, 1e-6);
      assertClose(r.x * VW, expR.x, 1e-6); assertClose(r.y * VH, expR.y, 1e-6);
      assertClose(d.radius * VW, (0.03 / 2) * W * t.scale, 1e-6);
      assertClose(r.radius * VW, (0.08 / 2) * W * t.scale, 1e-6);
      assertClose(r.strokeWidth * VW, 4 * t.scale, 1e-6);
      assert.equal(d.color, '#0000ff');
      assert.equal(r.color, '#ff0000');
    });
  }

  it('closer to the camera (twice as big) doubles every size; farther (half) halves it — positions still exact', () => {
    const VW = 1280; const VH = 720;
    const near = knownTransform('left_front', { s: 0.4 });
    const far = knownTransform('left_front', { s: 0.2 });
    const fn = computeArFrame({ result: resultOf([syntheticHand('left_front', near, VW, VH)]), view, video: { width: VW, height: VH } });
    const ff = computeArFrame({ result: resultOf([syntheticHand('left_front', far, VW, VH)]), view, video: { width: VW, height: VH } });
    const rn = fn.mapped.find((m) => m.id === 'r1'); const rf = ff.mapped.find((m) => m.id === 'r1');
    assertClose(rn.radius / rf.radius, 2, 1e-9);
    assertClose(rn.strokeWidth / rf.strokeWidth, 2, 1e-9);
  });

  it('lines/shapes and finger bands get the hand transform as a matrix (rotation and scale carried exactly)', () => {
    const VW = 1280; const VH = 720;
    const v = prepareArView(canvasFor('left_front', [
      { id: 'band', type: 'fingerBand', x: 0.55, y: 0.25, width: 0.08, height: 0.02, rotation: 0, color: '#ff8800', thickness: 6, opacity: 0.8, zIndex: 1, finger: 'middle', metadata: {} },
      { id: 'line', type: 'hline', x: 0.5, y: 0.6, width: 0.2, height: 0, rotation: 30, color: '#00ff00', thickness: 3, opacity: 1, zIndex: 2, metadata: {} },
    ]));
    const t = knownTransform('left_front', { s: 0.3, deg: 40 });
    const f = computeArFrame({ result: resultOf([syntheticHand('left_front', t, VW, VH)]), view: v, video: { width: VW, height: VH } });
    assert.equal(f.calibration, 'ok');
    const [band, line] = f.mapped;
    assert.equal(band.type, 'fingerBand');
    assert.equal(line.type, 'shape');
    for (const m of [band, line]) {
      assertClose(Math.hypot(m.matrix.a, m.matrix.b), 0.3, 1e-9);
      assertClose((Math.atan2(m.matrix.b, m.matrix.a) * 180) / Math.PI, 40, 1e-9);
      assert.ok(m.primitives.length > 0);
    }
  });

  it('the overlay keeps the doctor\'s layering: zIndex order across dots AND shapes, ties in saved order', () => {
    const objs = [
      { id: 'top-line', type: 'hline', x: 0.5, y: 0.5, width: 0.2, height: 0, rotation: 0, color: '#000', thickness: 2, opacity: 1, zIndex: 5, metadata: {} },
      dot({ id: 'bottom-dot', zIndex: 1 }),
      ring({ id: 'mid-ring-a', zIndex: 3 }),
      ring({ id: 'mid-ring-b', zIndex: 3 }),
    ];
    assert.deepEqual(orderForDrawing(objs).map((o) => o.id), ['bottom-dot', 'mid-ring-a', 'mid-ring-b', 'top-line']);
    const t = knownTransform('left_front');
    const v = prepareArView(canvasFor('left_front', objs));
    const f = computeArFrame({ result: resultOf([syntheticHand('left_front', t, 1280, 720)]), view: v, video: { width: 1280, height: 720 } });
    assert.deepEqual(f.mapped.map((m) => m.id), ['bottom-dot', 'mid-ring-a', 'mid-ring-b', 'top-line']);
  });

  it('only supported types are mapped; an unknown type is skipped, never thrown on', () => {
    assert.ok(AR_OBJECT_TYPES.includes('text') && AR_OBJECT_TYPES.includes('fingerBand') && AR_OBJECT_TYPES.includes('ring'));
    const t = knownTransform('left_front');
    const v = prepareArView(canvasFor('left_front', [dot({ id: 'ok' }), { id: 'weird', type: 'hologram', x: 0.5, y: 0.5 }]));
    const f = computeArFrame({ result: resultOf([syntheticHand('left_front', t, 1280, 720)]), view: v, video: { width: 1280, height: 720 } });
    assert.deepEqual(f.mapped.map((m) => m.id), ['ok']);
    assert.deepEqual(mapObjectsForOverlay(null, null, 1, 1, 1, 1), []);
  });

  it('two protocols prepared for the same view never share markings', () => {
    const t = knownTransform('left_front');
    const hand = resultOf([syntheticHand('left_front', t, 1280, 720)]);
    const bp = computeArFrame({ result: hand, view: prepareArView(backPainRender.canvases[0]), video: { width: 1280, height: 720 } });
    const ax = computeArFrame({ result: hand, view: prepareArView(anxietyRender.canvases[0]), video: { width: 1280, height: 720 } });
    assert.deepEqual(bp.mapped.map((m) => m.id), ['bp-ring', 'bp-dot']);
    assert.deepEqual(ax.mapped.map((m) => m.id), ['ax-dot']);
  });
});

describe('[DETERMINISTIC] landmark smoothing (jitter vs lag)', () => {
  const base = CALIBRATION_POINT_ORDER.map((n) => ({ x: REFERENCE_HAND_POINTS.left_front[n].x * 400 + 300, y: REFERENCE_HAND_POINTS.left_front[n].y * 400 + 100 }));
  const shift = (pts, dx, dy) => pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  // deterministic pseudo-random jitter
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };

  it('a still hand passes through unchanged', () => {
    const s = createLandmarkSmoother();
    let out;
    for (let i = 0; i < 30; i += 1) out = s.smooth(base, i * 33);
    out.forEach((p, i) => { assertClose(p.x, base[i].x, 1e-9); assertClose(p.y, base[i].y, 1e-9); });
  });

  it('per-frame jitter on a still hand is strongly reduced', () => {
    const s = createLandmarkSmoother();
    let rawVar = 0; let outVar = 0; let n = 0;
    for (let i = 0; i < 120; i += 1) {
      const noisy = base.map((p) => ({ x: p.x + rnd() * 6, y: p.y + rnd() * 6 }));
      const out = s.smooth(noisy, i * 33);
      if (i > 10) {
        rawVar += (noisy[0].x - base[0].x) ** 2; outVar += (out[0].x - base[0].x) ** 2; n += 1;
      }
    }
    assert.ok(outVar / n < (rawVar / n) * 0.35, `jitter variance ${outVar / n} should be well under raw ${rawVar / n}`);
  });

  it('a real move is followed quickly (no long lag)', () => {
    const s = createLandmarkSmoother();
    for (let i = 0; i < 10; i += 1) s.smooth(base, i * 33);
    const moved = shift(base, 120, 0);
    let out;
    for (let i = 10; i < 18; i += 1) out = s.smooth(moved, i * 33); // ~260 ms after the move
    assert.ok(Math.abs(out[0].x - moved[0].x) < 6, `still ${Math.abs(out[0].x - moved[0].x).toFixed(1)}px behind after ~260ms`);
  });

  it('reset / a long gap (tracking loss) starts fresh — a re-entering hand is not dragged from where it left', () => {
    const s = createLandmarkSmoother();
    for (let i = 0; i < 10; i += 1) s.smooth(base, i * 33);
    const elsewhere = shift(base, 400, 200);
    assert.deepEqual(s.smooth(elsewhere, 10 * 33 + 1000), elsewhere); // gap > maxGapMs
    s.reset();
    assert.deepEqual(s.smooth(base, 5000), base);
  });

  it('is resolution independent: the same motion in a 2x larger frame is smoothed identically (scaled)', () => {
    const a = createLandmarkSmoother(); const b = createLandmarkSmoother();
    const big = (pts) => pts.map((p) => ({ x: p.x * 2, y: p.y * 2 }));
    let oa; let ob;
    for (let i = 0; i < 20; i += 1) {
      const p = shift(base, i * 4 + (i % 2) * 3, 0);
      oa = a.smooth(p, i * 33); ob = b.smooth(big(p), i * 33);
    }
    oa.forEach((p, i) => { assertClose(ob[i].x, p.x * 2, 1e-6); assertClose(ob[i].y, p.y * 2, 1e-6); });
    assert.ok(palmLengthPx(base) > 0);
  });

  it('computeArFrame resets the smoother whenever the hand is unusable', () => {
    let resets = 0;
    const spy = { reset: () => { resets += 1; }, smooth: (p) => p };
    const view = prepareArView(canvasFor('left_front', [dot()]));
    computeArFrame({ result: null, view, video: { width: 1280, height: 720 }, smoother: spy });
    computeArFrame({ result: resultOf([syntheticHand('left_front', knownTransform('left_front'), 1280, 720, { mirror: true })]), view, video: { width: 1280, height: 720 }, smoother: spy });
    assert.equal(resets, 2);
  });
});

describe('[DETERMINISTIC] overlay rendering details', () => {
  function recordingCtx() {
    const ops = [];
    const ctx = { globalAlpha: 1 };
    for (const m of ['save', 'restore', 'beginPath', 'fill', 'stroke', 'moveTo', 'lineTo', 'closePath', 'rect', 'arc', 'translate', 'rotate', 'fillText', 'quadraticCurveTo']) {
      ctx[m] = (...a) => ops.push([m, ...a]);
    }
    ctx.setTransform = (...a) => ops.push(['setTransform', ...a]);
    ctx.scale = (...a) => ops.push(['scale', ...a]);
    return { ctx, ops };
  }
  const textShape = { id: 't', type: 'shape', primitives: [{ kind: 'text', text: 'L4', size: 40, fill: '#000', transform: { tx: 10, ty: 20, rot: 0 } }], matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };
  const cover = computeCoverMapping(1280, 720, 1280, 720);

  it('text is flipped back for the mirrored selfie camera so it stays readable', () => {
    const m = recordingCtx();
    drawProtocolOverlay(m.ctx, 1280, 720, cover, [textShape], { mirrored: true });
    assert.ok(m.ops.some((o) => o[0] === 'scale' && o[1] === -1 && o[2] === 1));
    const n = recordingCtx();
    drawProtocolOverlay(n.ctx, 1280, 720, cover, [textShape]);
    assert.equal(n.ops.some((o) => o[0] === 'scale'), false, 'no flip on the (unmirrored) rear camera');
  });

  it('shapes are drawn under hand matrix x cover mapping (one setTransform), then restored', () => {
    const m = recordingCtx();
    const c2 = computeCoverMapping(1280, 720, 1466, 825);
    drawProtocolOverlay(m.ctx, 1280, 720, c2, [{ ...textShape, matrix: { a: 0.5, b: 0, c: 0, d: 0.5, e: 100, f: 50 } }]);
    const st = m.ops.find((o) => o[0] === 'setTransform');
    assertClose(st[1], c2.scale * 0.5, 1e-12);
    assertClose(st[5], c2.scale * 100 + c2.offsetX, 1e-9);
    assertClose(st[6], c2.scale * 50 + c2.offsetY, 1e-9);
    assert.equal(m.ops.filter((o) => o[0] === 'save').length, m.ops.filter((o) => o[0] === 'restore').length);
  });

  it('an empty / missing list draws nothing and does not throw', () => {
    const m = recordingCtx();
    drawProtocolOverlay(m.ctx, 1280, 720, cover, []);
    drawProtocolOverlay(m.ctx, 1280, 720, cover, undefined);
    assert.equal(m.ops.length, 0);
  });
});

describe('[DETERMINISTIC] camera stream lifecycle (no real camera)', () => {
  const fakeStream = () => {
    const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
    return { tracks, getTracks: () => tracks };
  };
  const err = (name) => Object.assign(new Error(name), { name });

  it('asks for the rear camera first', async () => {
    const asked = [];
    const s = fakeStream();
    const out = await requestCameraStream({ getUserMedia: async (c) => { asked.push(c); return s; } });
    assert.equal(out.stream, s);
    assert.equal(out.facing, 'environment');
    assert.deepEqual(asked[0].video.facingMode, { ideal: 'environment' });
    assert.equal(asked[0].audio, false, 'never asks for the microphone');
  });

  it('falls back to any camera when the rear one cannot satisfy the constraints', async () => {
    let n = 0;
    const s = fakeStream();
    const out = await requestCameraStream({ getUserMedia: async () => { n += 1; if (n === 1) throw err('OverconstrainedError'); return s; } });
    assert.equal(out.facing, 'user');
    assert.equal(out.stream, s);
  });

  it('turns permission denial, no camera, busy camera and no API into specific statuses', async () => {
    assert.deepEqual(await requestCameraStream({ getUserMedia: async () => { throw err('NotAllowedError'); } }), { status: CAMERA_STATUS.DENIED });
    assert.deepEqual(await requestCameraStream({ getUserMedia: async () => { throw err('NotFoundError'); } }), { status: CAMERA_STATUS.UNAVAILABLE });
    assert.deepEqual(await requestCameraStream({ getUserMedia: async () => { throw err('NotReadableError'); } }), { status: CAMERA_STATUS.ERROR });
    assert.deepEqual(await requestCameraStream(undefined), { status: CAMERA_STATUS.UNSUPPORTED });
  });

  it('a stream that arrives after the person has left (stale request) is released immediately', () => {
    const late = fakeStream();
    assert.equal(acceptOrReleaseStream(1, 2, late), false);
    assert.equal(late.tracks[0].stopped, true);
    const current = fakeStream();
    assert.equal(acceptOrReleaseStream(3, 3, current), true);
    assert.equal(current.tracks[0].stopped, false);
  });

  it('stopping releases every track and detaches the video', () => {
    const s = fakeStream();
    const video = { srcObject: s };
    stopStream(s, video);
    assert.equal(s.tracks[0].stopped, true);
    assert.equal(video.srcObject, null);
    stopStream(null, null); // safe with nothing
  });

  it('model-loading failures have specific, actionable messages', () => {
    assert.match(TRACKER_ERRORS.unsupported, /browser/);
    assert.match(TRACKER_ERRORS.runtime, /engine/);
    assert.match(TRACKER_ERRORS.model, /model/);
  });
});
