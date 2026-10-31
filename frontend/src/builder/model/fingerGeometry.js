import { FINGER_GUIDES } from '../config/fingerGuides';

/**
 * Geometry of a Finger Band relative to a finger's guide line (see
 * config/fingerGuides.js). Pure functions, no React.
 *
 * All angles/distances are computed in CANVAS PIXEL space (normalized x/y are
 * scaled by the canvas's reference width/height first) because the hand images
 * are not square: an angle worked out on raw 0..1 fractions would be wrong.
 *
 * `canvas` below is any object with reference `width` and `height`.
 */
const LEGACY_FINGER_ALIASES = { pinky: 'little' };
const round4 = (n) => Math.round(n * 10000) / 10000;
const round2 = (n) => Math.round(n * 100) / 100;

export function canonicalFingerName(finger) {
  if (typeof finger !== 'string') return null;
  const key = finger.trim().toLowerCase();
  return LEGACY_FINGER_ALIASES[key] || key;
}

export function hasGuides(viewKey) {
  return Boolean(FINGER_GUIDES[viewKey]);
}

export function getGuide(viewKey, finger) {
  const view = FINGER_GUIDES[viewKey];
  const name = canonicalFingerName(finger);
  return view && name && view[name] ? view[name] : null;
}

export const clamp01 = (t) => Math.min(1, Math.max(0, t));

/** Wraps a band rotation into (-90, 90]; a band looks identical after a half turn. */
export function normalizeBandDeg(deg) {
  let d = ((deg % 180) + 180) % 180; // 0..180
  if (d > 90) d -= 180;
  return round2(d);
}

/** Point on the finger's axis at position t (0 = knuckle, 1 = fingertip), normalized. */
export function axisPoint(viewKey, finger, t) {
  const g = getGuide(viewKey, finger);
  if (!g) return null;
  const tt = clamp01(t);
  return { x: round4(g.base.x + (g.tip.x - g.base.x) * tt), y: round4(g.base.y + (g.tip.y - g.base.y) * tt) };
}

/** Direction of the finger axis in degrees (pixel space), pointing from knuckle to tip. */
export function axisAngleDeg(viewKey, finger, canvas) {
  const g = getGuide(viewKey, finger);
  if (!g) return null;
  const dx = (g.tip.x - g.base.x) * canvas.width;
  const dy = (g.tip.y - g.base.y) * canvas.height;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** Rotation that lays a (horizontal-by-default) band ACROSS the finger, plus an optional manual offset. */
export function bandRotationDeg(viewKey, finger, canvas, offset = 0) {
  const a = axisAngleDeg(viewKey, finger, canvas);
  if (a === null) return null;
  return normalizeBandDeg(a + 90 + offset);
}

/** Where a band sits (normalized centre + rotation) for finger/position/offset. Null if the view has no guide. */
export function bandPlacement(viewKey, finger, t, canvas, rotationOffset = 0) {
  const p = axisPoint(viewKey, finger, t);
  if (!p) return null;
  return { x: p.x, y: p.y, rotation: bandRotationDeg(viewKey, finger, canvas, rotationOffset) };
}

/** Projects a normalized point onto the finger's axis segment. */
export function projectToAxis(viewKey, finger, canvas, nx, ny) {
  const g = getGuide(viewKey, finger);
  if (!g) return null;
  const bx = g.base.x * canvas.width;
  const by = g.base.y * canvas.height;
  const vx = (g.tip.x - g.base.x) * canvas.width;
  const vy = (g.tip.y - g.base.y) * canvas.height;
  const len2 = vx * vx + vy * vy;
  const px = nx * canvas.width - bx;
  const py = ny * canvas.height - by;
  const t = clamp01(len2 === 0 ? 0 : (px * vx + py * vy) / len2);
  const point = axisPoint(viewKey, finger, t);
  return { t: Math.round(t * 1000) / 1000, x: point.x, y: point.y };
}

/** The finger whose axis is closest to a normalized point, with the position along it. */
export function nearestFinger(viewKey, canvas, nx, ny) {
  const view = FINGER_GUIDES[viewKey];
  if (!view) return null;
  let best = null;
  Object.keys(view).forEach((finger) => {
    const proj = projectToAxis(viewKey, finger, canvas, nx, ny);
    const distancePx = Math.hypot((proj.x - nx) * canvas.width, (proj.y - ny) * canvas.height);
    if (!best || distancePx < best.distancePx) best = { finger, t: proj.t, distancePx };
  });
  return best;
}
