import { createLandmarkSmoother } from './landmarkSmoothing';
import { BONES, PALM, palmLength, palmWidth } from './handSkeleton';

/**
 * Temporal tracking of the 21 live landmarks, frame by frame, using real timestamps. Pure state machine — no browser
 * APIs — so every behaviour below is tested with synthetic sequences.
 *
 *   searching  ──good frame×N──▶  tracking  ──bad frame──▶  holding (≤ holdMs, fading)  ──timeout──▶  lost
 *        ▲                            ▲                          │ good frame near the last pose: continue (no snap)
 *        └──────────── reset ─────────┴──────────────────────────┘ good frame far away: start again (re-acquire)
 *
 * Per frame it:
 *   1. rejects single-landmark OUTLIERS: a point that jumps far from where the rest of the hand says it should be is
 *      replaced by its prediction (at most `maxOutlierFrames` frames in a row; more than `maxOutliers` points at once =
 *      the whole frame is unreliable and is treated as a dropout);
 *   2. smooths with a One Euro filter whose strength follows the detection confidence (shaky frames smooth harder);
 *   3. predicts forward by `predictMs` (constant velocity) to offset the filter's lag — see docs/HAND_AR_ACCURACY.md;
 *   4. reports an overlay opacity (`alpha`): fades in after acquisition, fades out while holding, 0 when lost — the
 *      overlay never keeps showing confident markings on a hand that is no longer tracked;
 *   5. reports per-region RELIABILITY: a bone whose length (relative to the palm) is far from the calibrated baseline is
 *      foreshortened / curled / mis-detected, so markings on it fade instead of claiming precision.
 *
 * `usable` comes from the caller's per-frame verdict. Only a plain dropout (no hand / low confidence) is HELD; a wrong
 * hand or two hands must hide at once (`hideNow`).
 */
export const TRACKER_DEFAULTS = Object.freeze({
  acquireFrames: 3,
  holdMs: 160,
  fadeInMs: 140,
  reacquireRadius: 0.5, //   palm lengths: within this of the last pose a returning hand continues smoothly
  outlierPalm: 0.3, //       a point this far (palm lengths) from its prediction…
  outlierMedianFactor: 4, // …and this many times the median deviation is an outlier
  maxOutliers: 4,
  maxOutlierFrames: 3,
  // Filter settings chosen by a sweep on the synthetic benchmark (tools/ar/benchmark.mjs, 4 views × 5 seeds: jitter,
  // 4 Hz shake, 2.5 palm/s sweep). minCutoff 1.2 / beta 2 / no prediction (the first version) lagged in the shake test.
  // Re-check on real recordings: real MediaPipe noise and frame timing differ from the synthetic ones.
  predictMs: 20,
  minCutoff: 2.0,
  beta: 20,
  reliabilityTolerance: 0.25, //  bone/palm ratio may differ this much from the baseline at full reliability…
  reliabilityFalloff: 0.25, //    …and fades to 0 over this much more
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Bone lengths divided by palm length — the hand's own proportions (scale-free). */
export function boneRatios(lm) {
  const L = palmLength(lm) || 1;
  const out = {};
  for (const b of BONES) out[b.id] = Math.hypot(lm[b.b].x - lm[b.a].x, lm[b.b].y - lm[b.a].y) / L;
  out[PALM] = palmWidth(lm) / L;
  return out;
}

/** Reliability (0..1) of each region given live proportions vs a baseline. */
export function regionReliability(liveRatios, baseline, { reliabilityTolerance, reliabilityFalloff } = TRACKER_DEFAULTS) {
  const out = {};
  for (const key of Object.keys(liveRatios)) {
    const base = baseline && baseline[key];
    if (!(base > 0)) { out[key] = 1; continue; }
    const dev = Math.abs(liveRatios[key] / base - 1);
    out[key] = clamp01(1 - (dev - reliabilityTolerance) / reliabilityFalloff);
  }
  // A finger's bones share the fate of the proximal one (a curled finger hides its whole chain beyond the bad bone).
  for (const finger of ['thumb', 'index', 'middle', 'ring', 'little']) {
    const chain = BONES.filter((b) => b.finger === finger).map((b) => b.id);
    let worst = 1;
    for (const id of chain) { worst = Math.min(worst, out[id] ?? 1); out[id] = worst; }
  }
  return out;
}

export function createHandTracker(options = {}) {
  const cfg = { ...TRACKER_DEFAULTS, ...options };
  const smoother = createLandmarkSmoother({ minCutoff: cfg.minCutoff, beta: cfg.beta, palmIndexes: [0, 9] });
  let state = 'searching';
  let goodRun = 0;
  let last = null; //        last filtered landmarks (px)
  let prevFiltered = null; // the one before, for velocity
  let lastT = 0;
  let prevT = 0;
  let trackingSince = 0;
  let holdStart = 0;
  let outlierRun = new Array(21).fill(0);
  let baseline = null;
  const stats = { frames: 0, outliersReplaced: 0, framesRejected: 0, losses: 0, reacquisitions: 0 };

  function resetTrack() {
    smoother.reset();
    last = null; prevFiltered = null;
    goodRun = 0;
    outlierRun = new Array(21).fill(0);
  }

  function reset() {
    resetTrack();
    state = 'searching';
  }

  function predict(t) {
    if (!last) return null;
    if (!prevFiltered || !(lastT > prevT)) return last;
    const k = (t - lastT) / (lastT - prevT);
    return last.map((p, i) => ({ x: p.x + (p.x - prevFiltered[i].x) * k, y: p.y + (p.y - prevFiltered[i].y) * k }));
  }

  /** Replaces outlier points by their prediction. Returns { points, replaced } or null when the frame is unreliable. */
  function rejectOutliers(raw, t) {
    const pred = predict(t);
    if (!pred) return { points: raw, replaced: 0 };
    const L = palmLength(pred) || palmLength(raw) || 1;
    const dev = raw.map((p, i) => Math.hypot(p.x - pred[i].x, p.y - pred[i].y) / L);
    const sorted = [...dev].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const bad = dev.map((d) => d > cfg.outlierPalm && d > cfg.outlierMedianFactor * Math.max(median, 0.01));
    const count = bad.filter(Boolean).length;
    if (count > cfg.maxOutliers) return null;
    let replaced = 0;
    const points = raw.map((p, i) => {
      if (bad[i] && outlierRun[i] < cfg.maxOutlierFrames) { outlierRun[i] += 1; replaced += 1; return pred[i]; }
      outlierRun[i] = 0;
      return p;
    });
    return { points, replaced };
  }

  function emit(t, landmarks, alpha) {
    const ratios = landmarks ? boneRatios(landmarks) : null;
    return {
      state,
      landmarks,
      alpha: clamp01(alpha),
      reliability: ratios ? regionReliability(ratios, baseline, cfg) : null,
      ratios,
      stats: { ...stats },
    };
  }

  /**
   * One frame. `landmarks`: 21 points in video px (or null), `score`: detection confidence 0..1, `timestampMs`:
   * performance.now(), `usable`: the frame passed the per-frame checks, `hideNow`: hide immediately (wrong hand, …).
   */
  function update({ landmarks = null, score = 1, timestampMs, usable = false, hideNow = false }) {
    const t = timestampMs;
    stats.frames += 1;

    if (hideNow) {
      if (state === 'tracking' || state === 'holding') stats.losses += 1;
      reset();
      return emit(t, null, 0);
    }

    if (!usable || !landmarks || landmarks.length !== 21) {
      if (state === 'tracking') { state = 'holding'; holdStart = t; }
      if (state === 'holding') {
        const held = t - holdStart;
        if (held <= cfg.holdMs && last) return emit(t, last, 1 - held / cfg.holdMs);
        state = 'lost'; stats.losses += 1; resetTrack();
      }
      if (state === 'acquiring') { state = 'searching'; resetTrack(); }
      return emit(t, null, 0);
    }

    // A usable frame.
    if (state === 'holding' && last) {
      const L = palmLength(last) || 1;
      const moved = Math.hypot(landmarks[9].x - last[9].x, landmarks[9].y - last[9].y) / L;
      if (moved <= cfg.reacquireRadius) {
        state = 'tracking'; stats.reacquisitions += 1; // continue smoothly from where it was
      } else {
        resetTrack(); state = 'acquiring'; // somewhere else entirely: start again, do not drag it across
      }
    }
    if (state === 'searching' || state === 'lost') { resetTrack(); state = 'acquiring'; }

    let points = landmarks;
    if (state === 'tracking') {
      const r = rejectOutliers(landmarks, t);
      if (!r) {
        stats.framesRejected += 1;
        // Treat as a dropout: hold the last pose briefly.
        state = 'holding'; holdStart = t;
        return emit(t, last, 1);
      }
      points = r.points;
      stats.outliersReplaced += r.replaced;
    }

    const confidenceScale = 0.4 + 0.6 * clamp01((score - 0.5) / 0.45); // score 0.5 → 0.4× cutoff (heavier smoothing)
    const filtered = smoother.smooth(points, t, confidenceScale);
    prevFiltered = last; prevT = lastT;
    last = filtered; lastT = t;

    if (state === 'acquiring') {
      goodRun += 1;
      if (goodRun < cfg.acquireFrames) return emit(t, null, 0);
      state = 'tracking'; trackingSince = t;
    }

    let out = filtered;
    if (cfg.predictMs > 0 && prevFiltered && lastT > prevT) {
      const k = cfg.predictMs / (lastT - prevT);
      out = filtered.map((p, i) => ({ x: p.x + (p.x - prevFiltered[i].x) * k, y: p.y + (p.y - prevFiltered[i].y) * k }));
    }
    const alpha = cfg.fadeInMs > 0 ? (t - trackingSince) / cfg.fadeInMs : 1;
    return emit(t, out, Math.max(alpha, 0.15));
  }

  return {
    update,
    reset,
    /** Baseline proportions from calibration (boneRatios of a calibrated hand); null clears it. */
    setBaseline(ratios) { baseline = ratios ? { ...ratios } : null; },
    getBaseline() { return baseline ? { ...baseline } : null; },
    get state() { return state; },
  };
}
