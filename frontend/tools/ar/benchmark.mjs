/**
 * Synthetic hand-AR accuracy & stability benchmark (deterministic, exact ground truth — see syntheticHand.mjs).
 *
 *   npm run ar:benchmark            (from frontend/)  → prints tables, writes tools/ar/benchmark-results.json
 *
 * It runs the PRODUCTION code path (prepareArView + computeArFrame + the tracker) against generated hands and compares
 * mapping methods. It measures geometry and tracking logic only; it cannot measure what a real camera + MediaPipe
 * produce. Real-camera accuracy comes from the validation export (see docs/HAND_AR_ACCURACY.md).
 */
import { prepareArView, computeArFrame } from '../../src/tracking/arFrame.js';
import { createHandTracker } from '../../src/tracking/handTracker.js';
import { computeSimilarityTransform, applyTransform } from '../../src/tracking/similarityTransform.js';
import { summarizeErrors, checkThresholds, jitterRms, palmWidthOf } from '../../src/tracking/arMetrics.js';
import { ACCEPTANCE } from '../../src/tracking/arAcceptance.js';
import { VIEW_DIMS, prng, sampleMarkings, poseHand, randomPose, noisy, LEGACY_SIX } from './syntheticHand.mjs';

const VIEWS = Object.keys(VIEW_DIMS);
const VIDEO = { width: 1280, height: 720 };
const SIX = [0, 2, 5, 9, 13, 17];

const canvasWith = (view, markings) => ({
  viewKey: view, canvasType: 'hand', width: VIEW_DIMS[view][0], height: VIEW_DIMS[view][1],
  objects: markings.map((m, i) => ({ id: m.id, type: 'dot', x: m.norm.x, y: m.norm.y, width: 0.02, color: '#000', opacity: 1, zIndex: i })),
});
const resultOf = (lmPx, score = 0.95) => ({
  landmarks: [lmPx.map((p) => ({ x: p.x / VIDEO.width, y: p.y / VIDEO.height, z: 0 }))],
  handedness: [[{ categoryName: 'Left', score }]],
});

/** Predicted video-px positions keyed by marking id, for one frame and method. */
function predict(method, view, viewPrep, markings, lmPx) {
  if (method === 'legacy-similarity') {
    const [W, H] = VIEW_DIMS[view];
    const ref = LEGACY_SIX[view].map(([x, y]) => ({ x: x * W, y: y * H }));
    const t = computeSimilarityTransform(ref, SIX.map((i) => lmPx[i]));
    return new Map(markings.map((m) => [m.id, applyTransform(t, m.ref)]));
  }
  const mapping = method.startsWith('skeleton') ? 'skeleton' : 'similarity';
  const palmModel = method === 'skeleton-affine' ? 'affine' : 'perspective';
  const f = computeArFrame({ result: resultOf(lmPx), view: viewPrep, video: VIDEO, mapping, palmModel });
  if (f.calibration !== 'ok') return new Map();
  return new Map(f.mapped.map((m) => [m.id, { x: m.x * VIDEO.width, y: m.y * VIDEO.height }]));
}

export const METHODS = ['legacy-similarity', 'similarity', 'skeleton-affine', 'skeleton'];
export const METHOD_LABELS = {
  'legacy-similarity': 'Before: 1 similarity, OLD 6-point table',
  similarity: '1 similarity, corrected 6 points',
  'skeleton-affine': 'Skeleton, palm AFFINE + per-bone',
  skeleton: 'Skeleton, palm PERSPECTIVE + per-bone (prod)',
};

/** Static accuracy: N random poses per view per condition, every marking, per method. */
export function runAccuracy({ conditions = ['flat', 'natural', 'hard'], posesPerView = 25, noise = 0.004, seed = 7 } = {}) {
  const out = {};
  for (const condition of conditions) {
    out[condition] = {};
    const errs = Object.fromEntries(METHODS.map((m) => [m, { all: [], palm: [], fingers: [], thumb: [], byView: {} }]));
    const rng = prng(seed + condition.length * 101);
    for (const view of VIEWS) {
      const markings = sampleMarkings(view);
      const viewPrep = prepareArView(canvasWith(view, markings));
      for (let k = 0; k < posesPerView; k += 1) {
        const pose = randomPose(rng, condition, view, VIDEO);
        const gt = poseHand(view, markings, pose);
        const pw = palmWidthOf(gt.landmarks);
        const lm = noisy(gt.landmarks, rng, noise);
        for (const method of METHODS) {
          const pred = predict(method, view, viewPrep, markings, lm);
          const bucket = errs[method];
          bucket.byView[view] = bucket.byView[view] || [];
          for (const m of gt.markings) {
            const p = pred.get(m.id);
            const e = p ? Math.hypot(p.x - m.truth.x, p.y - m.truth.y) / pw : Infinity;
            bucket.all.push(e); bucket.byView[view].push(e);
            (m.body === 'palm' ? bucket.palm : m.body.startsWith('thumb') ? bucket.thumb : bucket.fingers).push(e);
          }
        }
      }
    }
    const t = ACCEPTANCE.synthetic[condition];
    const within = t ? t.within : 0.1;
    for (const method of METHODS) {
      const b = errs[method];
      const all = summarizeErrors(b.all, within);
      out[condition][method] = {
        all,
        palm: summarizeErrors(b.palm, within),
        fingers: summarizeErrors(b.fingers, within),
        thumb: summarizeErrors(b.thumb, within),
        byView: Object.fromEntries(Object.entries(b.byView).map(([v, e]) => [v, summarizeErrors(e, within)])),
        acceptance: t ? checkThresholds(all, t) : null,
      };
    }
  }
  return out;
}

/** Runs a timed sequence through computeArFrame with a tracker. frameFn(i, tMs) → { lm (exact), present, markings }. */
function runSequence(view, frames, frameFn, { fps = 30, noise = 0.005, seed = 3, tracker = createHandTracker(), mapping = 'skeleton' } = {}) {
  const rng = prng(seed);
  const markings = sampleMarkings(view).filter((_, i) => i % 3 === 0);
  const viewPrep = prepareArView(canvasWith(view, markings));
  const rows = [];
  for (let i = 0; i < frames; i += 1) {
    const t = (i * 1000) / fps;
    const f = frameFn(i, t, markings);
    const result = f.present ? resultOf(noisy(f.landmarks, rng, noise)) : { landmarks: [], handedness: [] };
    const frame = computeArFrame({ result, view: viewPrep, video: VIDEO, tracker, timestampMs: t, mapping });
    const pw = palmWidthOf(f.landmarks);
    const pred = new Map(frame.mapped.map((m) => [m.id, { x: m.x * VIDEO.width, y: m.y * VIDEO.height, v: m.visibility }]));
    rows.push({ t, present: f.present, pw, visible: frame.mapped.length > 0, state: frame.trackerState, f, pred });
  }
  return rows;
}

export function runTemporal({ view = 'left_front', seed = 11 } = {}) {
  const rng = prng(seed);
  const basePose = randomPose(rng, 'flat', view, VIDEO);
  basePose.center = { x: 640, y: 360 };
  const markingsAll = sampleMarkings(view);
  const at = (dx, dy, markings) => poseHand(view, markings, { ...basePose, center: { x: 640 + dx, y: 360 + dy } });
  const pw0 = palmWidthOf(at(0, 0, markingsAll).landmarks);
  const res = {};

  // 1. stationary jitter, raw vs tracked
  for (const [label, makeTracker] of [['raw', () => createHandTracker({ minCutoff: 1e6, beta: 0, predictMs: 0, acquireFrames: 1, fadeInMs: 0 })], ['tracked', () => createHandTracker()]]) {
    const rows = runSequence(view, 120, (i, t, mk) => ({ ...at(0, 0, mk), present: true }), { tracker: makeTracker(), noise: 0.005 });
    const ids = [...rows[rows.length - 1].pred.keys()];
    const per = ids.map((id) => jitterRms(rows.slice(20).map((r) => r.pred.get(id)).filter(Boolean)) / pw0);
    res[`stationaryJitter_${label}`] = per.reduce((s, x) => s + x, 0) / per.length;
  }
  // 2. shake: 4 Hz, 0.15 palm-width amplitude
  {
    const A = 0.15 * pw0;
    const rows = runSequence(view, 150, (i, t, mk) => ({ ...at(A * Math.sin(2 * Math.PI * 4 * t / 1000), 0, mk), present: true }));
    const errs = [];
    rows.slice(15).forEach((r) => r.f.markings.forEach((m) => { const p = r.pred.get(m.id); if (p) errs.push(Math.hypot(p.x - m.truth.x, p.y - m.truth.y) / r.pw); }));
    res.shake = summarizeErrors(errs, 0.1);
  }
  // 3. rapid sweep: 2.5 palm widths per second, left to right
  {
    const speed = 2.5 * pw0; // px/s
    const rows = runSequence(view, 45, (i, t, mk) => ({ ...at(-300 + speed * t / 1000, 0, mk), present: true }));
    const errs = [];
    rows.slice(10).forEach((r) => r.f.markings.forEach((m) => { const p = r.pred.get(m.id); if (p) errs.push(Math.hypot(p.x - m.truth.x, p.y - m.truth.y) / r.pw); }));
    res.rapid = summarizeErrors(errs, 0.1);
    // same sweep without temporal filtering (to show what the filter costs in lag)
    const rows2 = runSequence(view, 45, (i, t, mk) => ({ ...at(-300 + speed * t / 1000, 0, mk), present: true }), { tracker: createHandTracker({ minCutoff: 1e6, beta: 0, predictMs: 0, acquireFrames: 1, fadeInMs: 0 }) });
    const errs2 = [];
    rows2.slice(10).forEach((r) => r.f.markings.forEach((m) => { const p = r.pred.get(m.id); if (p) errs2.push(Math.hypot(p.x - m.truth.x, p.y - m.truth.y) / r.pw); }));
    res.rapidUnfiltered = summarizeErrors(errs2, 0.1);
    // the same filter without forward prediction
    const rows3 = runSequence(view, 45, (i, t, mk) => ({ ...at(-300 + speed * t / 1000, 0, mk), present: true }), { tracker: createHandTracker({ predictMs: 0 }) });
    const errs3 = [];
    rows3.slice(10).forEach((r) => r.f.markings.forEach((m) => { const p = r.pred.get(m.id); if (p) errs3.push(Math.hypot(p.x - m.truth.x, p.y - m.truth.y) / r.pw); }));
    res.rapidNoPredict = summarizeErrors(errs3, 0.1);
  }
  // 4. dropout 0.4 s then re-entry 0.3 palm widths away
  {
    const rows = runSequence(view, 75, (i, t, mk) => {
      const gone = t >= 1000 && t < 1400;
      const dx = t >= 1400 ? 0.3 * pw0 : 0;
      return { ...at(dx, 0, mk), present: !gone };
    });
    const back = rows.find((r) => r.t >= 1400 && r.visible);
    const hiddenAt = rows.find((r) => r.t >= 1000 && !r.visible);
    res.hideAfterLossMs = hiddenAt ? hiddenAt.t - 1000 : null;
    res.reacquireMs = back ? back.t - 1400 : null;
    if (back) {
      const errs = back.f.markings.map((m) => { const p = back.pred.get(m.id); return p ? Math.hypot(p.x - m.truth.x, p.y - m.truth.y) / back.pw : Infinity; });
      res.reacquireError = summarizeErrors(errs, 0.05);
    }
  }
  // 5. outlier landmarks: one landmark thrown 1 palm width away on 10 % of frames
  {
    for (const [label, opts] of [['withRejection', {}], ['withoutRejection', { outlierPalm: 1e9 }]]) {
      const r2 = prng(5);
      const rows = runSequence(view, 120, (i, t, mk) => {
        const g = at(0, 0, mk);
        if (i > 10 && r2.next() < 0.1) {
          const k = 1 + Math.floor(r2.next() * 20);
          g.landmarks = g.landmarks.map((p, j) => (j === k ? { x: p.x + pw0, y: p.y - pw0 * 0.5 } : p));
        }
        return { ...g, present: true };
      }, { tracker: createHandTracker(opts) });
      const errs = [];
      // ground truth comes from the clean pose
      const clean = at(0, 0, markingsAll.filter((_, i) => i % 3 === 0));
      rows.slice(15).forEach((r) => clean.markings.forEach((m) => { const p = r.pred.get(m.id); if (p) errs.push(Math.hypot(p.x - m.truth.x, p.y - m.truth.y) / pw0); }));
      res[`outliers_${label}`] = summarizeErrors(errs, 0.1);
    }
  }
  const T = ACCEPTANCE.temporal;
  res.acceptance = {
    stationaryJitter: res.stationaryJitter_tracked <= T.stationaryJitterRms,
    shake: res.shake.p95 <= T.shakeErrorP95,
    rapidLag: res.rapid.mean <= T.rapidLagMean,
    reacquire: res.reacquireMs != null && res.reacquireMs <= T.reacquireMs,
    reacquireError: res.reacquireError && res.reacquireError.max <= T.reacquireErrorMax,
  };
  return res;
}

/** Mapping cost per frame (ms) for a typical protocol view (30 markings), production path. */
export function runPerformance({ frames = 2000 } = {}) {
  const view = 'left_front';
  const markings = sampleMarkings(view).slice(0, 30);
  const viewPrep = prepareArView(canvasWith(view, markings));
  const rng = prng(1);
  const gt = poseHand(view, markings, randomPose(rng, 'natural', view, VIDEO));
  const tracker = createHandTracker();
  const result = resultOf(gt.landmarks);
  const t0 = performance.now();
  for (let i = 0; i < frames; i += 1) computeArFrame({ result, view: viewPrep, video: VIDEO, tracker, timestampMs: i * 33 });
  return { msPerFrame: (performance.now() - t0) / frames, markings: markings.length };
}

const fmt = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x));

if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const accuracy = runAccuracy();
  const temporal = runTemporal();
  const perf = runPerformance();
  for (const [cond, byMethod] of Object.entries(accuracy)) {
    console.log(`\n=== Static accuracy — condition "${cond}" (errors in palm widths) ===`);
    console.log('method'.padEnd(48), 'median   p95      max      within   | palm-med fing-med thumb-med | acceptance');
    for (const m of METHODS) {
      const r = byMethod[m];
      const acc = r.acceptance ? (r.acceptance.pass ? 'PASS' : `FAIL (${r.acceptance.fails.join('; ')})`) : '— (outside supported conditions)';
      console.log(METHOD_LABELS[m].padEnd(48), fmt(r.all.median), fmt(r.all.p95), fmt(r.all.max), `${(r.all.withinRate * 100).toFixed(1)}%`.padEnd(8), '|', fmt(r.palm.median), fmt(r.fingers.median), fmt(r.thumb.median), '|', acc);
    }
  }
  console.log('\n=== Temporal (skeleton + tracker, left_front, 30 fps, 0.5 % landmark noise) ===');
  console.log('stationary jitter RMS  raw', fmt(temporal.stationaryJitter_raw), ' tracked', fmt(temporal.stationaryJitter_tracked));
  console.log('shake 4 Hz            p95', fmt(temporal.shake.p95), ' median', fmt(temporal.shake.median));
  console.log('rapid 2.5 pw/s        mean', fmt(temporal.rapid.mean), ' (unfiltered', fmt(temporal.rapidUnfiltered.mean), ', filter without prediction', fmt(temporal.rapidNoPredict.mean), ')');
  console.log('dropout 0.4 s: hidden after', temporal.hideAfterLossMs, 'ms; visible again after', temporal.reacquireMs, 'ms; first-frame error max', fmt(temporal.reacquireError?.max));
  console.log('outliers (10 % frames): p95 with rejection', fmt(temporal.outliers_withRejection.p95), ' without', fmt(temporal.outliers_withoutRejection.p95));
  console.log('acceptance', JSON.stringify(temporal.acceptance));
  console.log(`\nperformance: ${perf.msPerFrame.toFixed(3)} ms per frame for ${perf.markings} markings (mapping + tracking only, Node ${process.version})`);
  const outFile = new URL('./benchmark-results.json', import.meta.url);
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), accuracy, temporal, perf }, null, 1));
  console.log('\nwrote', outFile.pathname);
}

// ---------------------------------------------------------------- palm model comparison (evaluation only)
/** Least-squares homography (h33 = 1) from ≥ 4 point pairs, by solving the 8×8 normal equations. */
export function fitHomography(src, dst) {
  const A = []; const b = [];
  src.forEach((p, i) => {
    const q = dst[i];
    A.push([p.x, p.y, 1, 0, 0, 0, -p.x * q.x, -p.y * q.x]); b.push(q.x);
    A.push([0, 0, 0, p.x, p.y, 1, -p.x * q.y, -p.y * q.y]); b.push(q.y);
  });
  const N = Array.from({ length: 8 }, () => new Array(9).fill(0));
  for (let r = 0; r < A.length; r += 1) for (let i = 0; i < 8; i += 1) { for (let j = 0; j < 8; j += 1) N[i][j] += A[r][i] * A[r][j]; N[i][8] += A[r][i] * b[r]; }
  for (let c = 0; c < 8; c += 1) {
    let piv = c; for (let r = c + 1; r < 8; r += 1) if (Math.abs(N[r][c]) > Math.abs(N[piv][c])) piv = r;
    [N[c], N[piv]] = [N[piv], N[c]];
    if (Math.abs(N[c][c]) < 1e-12) return null;
    for (let r = 0; r < 8; r += 1) if (r !== c) { const f = N[r][c] / N[c][c]; for (let k = c; k < 9; k += 1) N[r][k] -= f * N[c][k]; }
  }
  const h = N.map((row, i) => row[8] / N[i][i]);
  return (p) => { const w = h[6] * p.x + h[7] * p.y + 1; return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }; };
}

/** Palm markings only: the production palm AFFINE vs a palm HOMOGRAPHY, same 6 palm landmarks, with and without noise. */
export async function runPalmModelComparison({ posesPerView = 25, seed = 5 } = {}) {
  const { fitAffine, applyAffine, PALM_POLYGON } = await import('../../src/tracking/handSkeleton.js');
  const { referencePx } = await import('./syntheticHand.mjs');
  const out = {};
  for (const condition of ['flat', 'natural', 'hard']) {
    for (const noise of [0, 0.004, 0.01]) {
      const eA = []; const eH = [];
      const rng = prng(seed + condition.length);
      for (const view of VIEWS) {
        const markings = sampleMarkings(view).filter((m) => m.body === 'palm');
        const ref = referencePx(view);
        for (let k = 0; k < posesPerView; k += 1) {
          const gt = poseHand(view, markings, randomPose(rng, condition, view, VIDEO));
          const pw = palmWidthOf(gt.landmarks);
          const lm = noisy(gt.landmarks, rng, noise);
          const src = PALM_POLYGON.map((i) => ref[i]); const dst = PALM_POLYGON.map((i) => lm[i]);
          const A = fitAffine(src, dst, [1, 0.5, 1, 1, 1, 1]);
          const Hm = fitHomography(src, dst);
          for (const m of gt.markings) {
            const a = applyAffine(A, m.ref); eA.push(Math.hypot(a.x - m.truth.x, a.y - m.truth.y) / pw);
            const h = Hm ? Hm(m.ref) : { x: Infinity, y: Infinity }; eH.push(Math.hypot(h.x - m.truth.x, h.y - m.truth.y) / pw);
          }
        }
      }
      out[`${condition}@noise${noise}`] = { affine: summarizeErrors(eA, 0.1), homography: summarizeErrors(eH, 0.1) };
    }
  }
  return out;
}
