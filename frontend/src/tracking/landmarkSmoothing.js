/**
 * Jitter smoothing for the live calibration points (wrist + five MCP knuckles, in VIDEO PIXELS) before the similarity
 * transform is fitted. MediaPipe's per-frame landmarks wobble by a few pixels even when the hand is still, and every
 * marking inherits that wobble through the transform.
 *
 * Method: a One Euro filter (Casiez et al., CHI 2012) per coordinate — a low-pass filter whose cut-off frequency rises
 * with speed. A still hand gets heavy smoothing (no shimmer); a moving hand gets light smoothing (little lag).
 *
 * Resolution / distance independence: the speed that opens the filter up is measured in PALM LENGTHS per second
 * (wrist -> middle-finger knuckle), not in pixels, so the same hand motion is treated the same at 640x480 or 1920x1080
 * and whether the hand is close to or far from the camera.
 *
 * The filter keeps no state across a tracking loss: `reset()` (or a gap longer than `maxGapMs`) starts fresh, so a hand
 * that re-enters the view is never dragged in from where it left.
 */

const DEFAULTS = Object.freeze({
  minCutoff: 1.2, //   Hz — smoothing strength when the hand is still (lower = smoother, more lag)
  beta: 2.0, //        how fast the cut-off rises with speed (per palm-length/second)
  dCutoff: 1.0, //     Hz — smoothing of the speed estimate itself
  maxGapMs: 250, //    a longer gap between frames counts as a new track
  palmIndexes: [0, 3], // where wrist and middle MCP are in the point list ([0, 9] for 21 landmarks)
});

const alphaFor = (cutoffHz, dtSec) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
};

/**
 * Palm length in pixels. `indexes` names the wrist and middle-MCP positions in `points`: [0, 3] for the 6 calibration
 * points (the default), [0, 9] for the full 21-point hand.
 */
export function palmLengthPx(points, indexes = [0, 3]) {
  const [i, j] = indexes;
  if (!Array.isArray(points) || points.length <= Math.max(i, j)) return 0;
  const a = points[i];
  const b = points[j];
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function createLandmarkSmoother(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  let prev = null; // { t, points: [{x,y}], speeds: [{x,y}] }

  function reset() {
    prev = null;
  }

  /**
   * `points`: [{x, y}] in video pixels, same order every frame. `timestampMs`: monotonic (performance.now()).
   * Returns a NEW array of smoothed points (input is never mutated).
   */
  /** `cutoffScale` (optional, > 0) multiplies minCutoff for this frame: < 1 smooths harder (e.g. a low-confidence frame). */
  function smooth(points, timestampMs, cutoffScale = 1) {
    if (!Array.isArray(points) || points.length === 0) {
      reset();
      return points;
    }
    const valid = points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!valid) {
      reset();
      return points;
    }
    const dtMs = prev ? timestampMs - prev.t : 0;
    if (!prev || prev.points.length !== points.length || !(dtMs > 0) || dtMs > cfg.maxGapMs) {
      prev = { t: timestampMs, points: points.map((p) => ({ x: p.x, y: p.y })), speeds: points.map(() => ({ x: 0, y: 0 })) };
      return prev.points.map((p) => ({ ...p }));
    }
    const dt = dtMs / 1000;
    const palm = palmLengthPx(prev.points, cfg.palmIndexes) || palmLengthPx(points, cfg.palmIndexes) || 1;
    const aD = alphaFor(cfg.dCutoff, dt);
    const out = [];
    const speeds = [];
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const q = prev.points[i];
      const s = prev.speeds[i];
      // speed in palm-lengths per second, low-pass filtered
      const vx = aD * ((p.x - q.x) / dt / palm) + (1 - aD) * s.x;
      const vy = aD * ((p.y - q.y) / dt / palm) + (1 - aD) * s.y;
      const speed = Math.hypot(vx, vy);
      const a = alphaFor(cfg.minCutoff * (cutoffScale > 0 ? cutoffScale : 1) + cfg.beta * speed, dt);
      out.push({ x: a * p.x + (1 - a) * q.x, y: a * p.y + (1 - a) * q.y });
      speeds.push({ x: vx, y: vy });
    }
    prev = { t: timestampMs, points: out, speeds };
    return out.map((p) => ({ ...p }));
  }

  /** The filtered speed of point i in palm-lengths per second ({x, y}), or null before two frames. */
  function velocity(i) {
    return prev && prev.speeds[i] ? { ...prev.speeds[i] } : null;
  }

  return { smooth, reset, velocity };
}

export const SMOOTHING_DEFAULTS = DEFAULTS;
