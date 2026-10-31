import { summarizeErrors, checkThresholds, jitterRms, quantile } from './arMetrics';
import { ACCEPTANCE } from './arAcceptance';

/**
 * REAL-CAMERA validation: what the developer readout (?debug=1) records and exports, and how it is scored.
 *
 * Nothing here touches images. A session holds only numbers — marking ids, pixel coordinates, timings, states — and is
 * exported as a JSON file the tester downloads themselves (never uploaded). The frozen frame used for labelling stays in
 * the page's memory and is discarded.
 *
 * Two kinds of evidence:
 *  - LABELS: on a frozen frame, the tester clicks a drawn marking, then clicks where it truly belongs on the hand (e.g.
 *    a small pen dot drawn on the skin at the protocol's spot before the session). error = distance / palm width.
 *  - RECORDINGS: per-frame marking positions + timings over a few seconds (hold still → jitter; move → loss and
 *    reacquisition statistics; fps; detection time).
 */
export const VALIDATION_FORMAT = 'ctpp-ar-validation/1';
export const MAX_RECORDED_FRAMES = 1800; // ~60 s at 30 fps

export function createValidationSession({ protocol = null, viewKey = null, mapping = 'skeleton', userAgent = '', tags = {} } = {}) {
  const labels = [];
  const recordings = [];
  let current = null;
  const tagMap = { ...tags };
  return {
    setTag(key, value) { tagMap[key] = value; },
    addLabel({ markingId, predicted, truth, palmWidthPx, videoWidth, videoHeight, note = '' }) {
      if (!predicted || !truth || !(palmWidthPx > 0)) return false;
      labels.push({ markingId: String(markingId), predicted, truth, palmWidthPx, videoWidth, videoHeight, note, at: Date.now() });
      return true;
    },
    startRecording(label = 'recording') { current = { label, frames: [] }; recordings.push(current); },
    stopRecording() { current = null; },
    get recording() { return Boolean(current); },
    recordFrame(frame) {
      if (!current || current.frames.length >= MAX_RECORDED_FRAMES) return;
      current.frames.push(frame); // { t, dt, detectMs, state, calibration, palmWidthPx, markings: [{id,x,y,v}] }
    },
    get labelCount() { return labels.length; },
    toJSON() {
      return { format: VALIDATION_FORMAT, createdAt: new Date().toISOString(), protocol, viewKey, mapping, userAgent, tags: { ...tagMap }, labels, recordings };
    },
  };
}

/** Scores one or more exported sessions against ACCEPTANCE.real. Pure. */
export function analyzeValidation(sessions) {
  const list = Array.isArray(sessions) ? sessions : [sessions];
  const T = ACCEPTANCE.real;
  const errors = [];
  const byView = {};
  for (const s of list) {
    for (const l of s.labels || []) {
      const e = Math.hypot(l.predicted.x - l.truth.x, l.predicted.y - l.truth.y) / l.palmWidthPx;
      errors.push(e);
      const key = `${s.viewKey || '?'}${s.tags && s.tags.lighting ? ` / ${s.tags.lighting}` : ''}`;
      (byView[key] = byView[key] || []).push(e);
    }
  }
  const alignment = summarizeErrors(errors, T.within);

  // Timing, loss/reacquisition and jitter from recordings.
  const dts = []; const detects = []; let lossCount = 0; let seconds = 0; const reacq = []; const jitters = [];
  for (const s of list) {
    for (const r of s.recordings || []) {
      const fr = r.frames || [];
      if (fr.length > 1) seconds += (fr[fr.length - 1].t - fr[0].t) / 1000;
      let lostAt = null;
      for (let i = 0; i < fr.length; i += 1) {
        const f = fr[i];
        if (i > 0) dts.push(f.t - fr[i - 1].t);
        if (Number.isFinite(f.detectMs)) detects.push(f.detectMs);
        const visible = f.markings && f.markings.length > 0;
        const prevVisible = i > 0 && fr[i - 1].markings && fr[i - 1].markings.length > 0;
        if (prevVisible && !visible) { lossCount += 1; lostAt = f.t; }
        if (!prevVisible && visible && lostAt != null) { reacq.push(f.t - lostAt); lostAt = null; }
      }
      if (/still|jitter/i.test(r.label || '')) {
        // stationary jitter per marking, in palm widths, over frames where it is visible
        const ids = new Set(fr.flatMap((f) => (f.markings || []).map((m) => m.id)));
        for (const id of ids) {
          const pts = fr.map((f) => { const m = (f.markings || []).find((x) => x.id === id); return m && f.palmWidthPx > 0 ? { x: m.x / f.palmWidthPx, y: m.y / f.palmWidthPx } : null; }).filter(Boolean);
          if (pts.length >= 10) jitters.push(jitterRms(pts));
        }
      }
    }
  }
  const sortedDt = [...dts].sort((a, b) => a - b);
  const sortedDetect = [...detects].sort((a, b) => a - b);
  const medianDt = quantile(sortedDt, 0.5);
  const fps = medianDt > 0 ? 1000 / medianDt : NaN;
  const stationaryJitter = jitters.length ? jitters.reduce((s, x) => s + x, 0) / jitters.length : NaN;
  const reacquireMs = reacq.length ? quantile([...reacq].sort((a, b) => a - b), 0.5) : NaN;

  const checks = {
    alignment: alignment.n ? checkThresholds(alignment, T) : { pass: false, fails: ['no labelled samples'] },
    stationaryJitter: Number.isFinite(stationaryJitter) ? stationaryJitter <= T.stationaryJitterRms : null,
    reacquire: Number.isFinite(reacquireMs) ? reacquireMs <= T.reacquireMs : null,
    fps: Number.isFinite(fps) ? fps >= T.minFps : null,
  };
  return {
    alignment,
    byView: Object.fromEntries(Object.entries(byView).map(([k, e]) => [k, summarizeErrors(e, T.within)])),
    fps,
    detectMs: { median: quantile(sortedDetect, 0.5), p95: quantile(sortedDetect, 0.95) },
    lossesPerMinute: seconds > 0 ? (lossCount / seconds) * 60 : NaN,
    reacquireMs,
    stationaryJitter,
    thresholds: T,
    checks,
  };
}

/** The drawn marking closest to `point` (video px) within `maxDist` px, or null — for "click a marking" labelling. */
export function nearestMarking(markings, point, maxDist = 40) {
  let best = null;
  let bestD = maxDist;
  for (const m of markings || []) {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
    const d = Math.hypot(m.x - point.x, m.y - point.y);
    if (d <= bestD) { best = m; bestD = d; }
  }
  return best;
}
