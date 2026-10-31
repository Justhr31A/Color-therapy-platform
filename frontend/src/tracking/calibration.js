import { palmLength, palmWidth } from './handSkeleton';
import { boneRatios } from './handTracker';

/**
 * Guided calibration: the minimum practical step that makes the overlay more reliable for THIS person's hand.
 *
 * The person holds the requested hand (right side facing the camera) flat, fingers straight and gently spread, inside
 * the frame, for ~0.5 s. Each frame is checked; rejected frames say exactly what to fix. When enough consecutive frames
 * pass and the hand is steady, we record the hand's own PROPORTIONS (bone lengths / palm length). The tracker then uses
 * that baseline to tell a finger that bends towards the camera, curls, or is mis-detected (its projected length no
 * longer matches) and fades the markings on it instead of showing them in a falsely precise place.
 *
 * What calibration does NOT do: it does not change where markings are placed on a flat hand (that comes from the
 * reference skeleton and the live landmarks), and it cannot tell palm from back of the hand — see docs/HAND_AR_ACCURACY.md.
 *
 * Inputs are MediaPipe's normalized landmarks (x, y in 0..1 of the video frame, z = relative depth, same scale as x).
 */
export const CALIBRATION_DEFAULTS = Object.freeze({
  marginFrac: 0.02, //       every landmark at least this far inside the frame
  minPalmFrac: 0.14, //      palm length ≥ this fraction of the frame's shorter side (hand big enough to measure)
  maxPalmFrac: 0.7, //       …and not so close that the fingers leave the frame on any movement
  minScore: 0.8,
  minStraightness: 0.9, //   per finger: |MCP→tip| / (sum of its bone lengths)
  maxTiltZ: 0.35, //         |Δz| across / along the palm relative to its size: hand turned away from the camera
  steadyMs: 500,
  maxMotion: 0.05, //        palm lengths of wrist/middle-MCP movement allowed while steady
});

export const CALIBRATION_MESSAGES = Object.freeze({
  'no-hand': 'Show your hand to the camera.',
  'out-of-frame': 'Move your hand so the whole hand, wrist included, is inside the picture.',
  'too-small': 'Bring your hand closer to the camera.',
  'too-close': 'Move your hand a little further from the camera.',
  'low-confidence': 'Use brighter, even light and hold your hand still.',
  'fingers-bent': 'Straighten your fingers and spread them slightly.',
  tilted: 'Turn your hand so it faces the camera directly (flat, not tilted).',
  moving: 'Hold still for a moment…',
});

const FINGER_CHAINS = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], little: [17, 18, 19, 20] };

/** Per-frame check. Returns { ok, reasons: [code], metrics }. `video` = { width, height } in px. */
export function assessCalibrationFrame({ landmarks, score = 0, video, options = {} }) {
  const cfg = { ...CALIBRATION_DEFAULTS, ...options };
  if (!Array.isArray(landmarks) || landmarks.length !== 21) return { ok: false, reasons: ['no-hand'], metrics: {} };
  const px = landmarks.map((p) => ({ x: p.x * video.width, y: p.y * video.height }));
  const reasons = [];
  const m = cfg.marginFrac;
  if (landmarks.some((p) => p.x < m || p.x > 1 - m || p.y < m || p.y > 1 - m)) reasons.push('out-of-frame');
  const L = palmLength(px);
  const shortSide = Math.min(video.width, video.height);
  const palmFrac = L / shortSide;
  if (palmFrac < cfg.minPalmFrac) reasons.push('too-small');
  if (palmFrac > cfg.maxPalmFrac) reasons.push('too-close');
  if (score < cfg.minScore) reasons.push('low-confidence');
  const straightness = {};
  for (const [finger, chain] of Object.entries(FINGER_CHAINS)) {
    if (finger === 'thumb') continue; // the thumb is naturally angled; it is not required to be straight
    let sum = 0;
    for (let k = 0; k < chain.length - 1; k += 1) sum += Math.hypot(px[chain[k + 1]].x - px[chain[k]].x, px[chain[k + 1]].y - px[chain[k]].y);
    const direct = Math.hypot(px[chain[3]].x - px[chain[0]].x, px[chain[3]].y - px[chain[0]].y);
    straightness[finger] = sum > 0 ? direct / sum : 0;
  }
  if (Object.values(straightness).some((s) => s < cfg.minStraightness)) reasons.push('fingers-bent');
  // Tilt from MediaPipe's relative depth (z has roughly the same scale as x).
  const zScale = palmLength(landmarks.map((p) => ({ x: p.x, y: p.y * (video.height / video.width) }))) || 1;
  const across = Math.abs((landmarks[5].z ?? 0) - (landmarks[17].z ?? 0)) / zScale;
  const along = Math.abs((landmarks[0].z ?? 0) - (landmarks[9].z ?? 0)) / zScale;
  if (across > cfg.maxTiltZ || along > cfg.maxTiltZ) reasons.push('tilted');
  return { ok: reasons.length === 0, reasons, metrics: { palmFrac, straightness, tiltAcross: across, tiltAlong: along, palmWidthPx: palmWidth(px) } };
}

/**
 * Collects steady, passing frames. update() → { status: 'collecting' | 'done', progress 0..1, reasons, baseline }.
 * `baseline` (when done) = { ratios: boneRatios, frames, palmWidthPx } averaged over the steady window.
 */
export function createCalibrator(options = {}) {
  const cfg = { ...CALIBRATION_DEFAULTS, ...options };
  let window_ = []; // { t, px, ratios }
  let done = null;

  function reset() { window_ = []; done = null; }

  function update({ landmarks, score, video, timestampMs }) {
    if (done) return { status: 'done', progress: 1, reasons: [], baseline: done };
    const a = assessCalibrationFrame({ landmarks, score, video, options: cfg });
    if (!a.ok) { window_ = []; return { status: 'collecting', progress: 0, reasons: a.reasons, baseline: null }; }
    const px = landmarks.map((p) => ({ x: p.x * video.width, y: p.y * video.height }));
    const first = window_[0];
    if (first) {
      const L = palmLength(first.px) || 1;
      const moved = Math.max(
        Math.hypot(px[0].x - first.px[0].x, px[0].y - first.px[0].y),
        Math.hypot(px[9].x - first.px[9].x, px[9].y - first.px[9].y)
      ) / L;
      if (moved > cfg.maxMotion) {
        window_ = [];
        return { status: 'collecting', progress: 0, reasons: ['moving'], baseline: null };
      }
    }
    window_.push({ t: timestampMs, px, ratios: boneRatios(px), palmWidthPx: a.metrics.palmWidthPx });
    const span = timestampMs - window_[0].t;
    if (span < cfg.steadyMs) return { status: 'collecting', progress: Math.min(0.99, span / cfg.steadyMs), reasons: [], baseline: null };
    const keys = Object.keys(window_[0].ratios);
    const ratios = {};
    for (const k of keys) ratios[k] = window_.reduce((s, f) => s + f.ratios[k], 0) / window_.length;
    done = { ratios, frames: window_.length, palmWidthPx: window_.reduce((s, f) => s + f.palmWidthPx, 0) / window_.length };
    return { status: 'done', progress: 1, reasons: [], baseline: done };
  }

  return { update, reset, get done() { return Boolean(done); } };
}

/** The first rejection reason as a sentence for the person (most actionable first). */
export function calibrationMessage(reasons) {
  const order = ['no-hand', 'out-of-frame', 'too-small', 'too-close', 'tilted', 'fingers-bent', 'low-confidence', 'moving'];
  const first = order.find((r) => reasons && reasons.includes(r));
  return first ? CALIBRATION_MESSAGES[first] : 'Hold your hand flat, fingers straight and slightly spread…';
}

