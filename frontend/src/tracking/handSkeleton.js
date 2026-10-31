/**
 * Skeleton-driven mapping of protocol markings onto a live hand: 2D LINEAR BLEND SKINNING over the 21-point hand.
 *
 * Why not one transform for the whole hand (the previous design)? A finger moves on its own: when it bends, spreads or
 * is longer/shorter than the drawing's, a single similarity/affine fitted to the palm puts its markings beside the
 * finger. Here every anatomical REGION has its own transform, fitted every frame:
 *
 *   palm                    weighted least-squares AFFINE over wrist, thumb CMC, and the four finger MCPs
 *                           (affine absorbs different palm proportions and mild foreshortening)
 *   each finger / thumb bone a bone frame: ALONG the bone it scales with the bone's live/reference length (so a finger
 *                           that is longer, or foreshortened by bending towards the camera, is followed); ACROSS the bone
 *                           it scales with the hand's overall scale (a finger's width does not change when it bends)
 *
 * Every marking gets fixed SKINNING WEIGHTS over those regions, computed once from where it sits on the reference
 * diagram (Gaussian falloff with distance to each bone / the palm polygon, in palm-length units). Its live transform is
 * the weighted blend of its regions' transforms — so a ring on the middle phalanx follows that phalanx, a palm dot
 * follows the palm, and a marking on a joint blends smoothly between the two bones (no seams where regions meet).
 * A doctor can pin a marking to one region (`landmarkReference.region`) to stop it blending at all.
 *
 * Coordinates: reference PIXELS (normalized × the view's canvas size) in, video PIXELS out. Pure; no allocation-heavy
 * work per frame beyond 16 small matrices.
 */

export const FINGERS = Object.freeze(['thumb', 'index', 'middle', 'ring', 'little']);
const FIRST = { thumb: 1, index: 5, middle: 9, ring: 13, little: 17 };
const SEGMENTS = { thumb: ['metacarpal', 'proximal', 'distal'], other: ['proximal', 'middle', 'distal'] };

/** Every bone region: { id: 'index.middle', finger, a, b } where a→b are landmark indexes along the bone. */
export const BONES = Object.freeze(
  FINGERS.flatMap((finger) => {
    const base = FIRST[finger];
    const names = finger === 'thumb' ? SEGMENTS.thumb : SEGMENTS.other;
    return names.map((seg, k) => Object.freeze({ id: `${finger}.${seg}`, finger, a: base + k, b: base + k + 1 }));
  })
);

export const PALM = 'palm';
/** Palm polygon (landmark indexes, in order around the palm) and its fit weights (the thumb CMC is the least certain). */
export const PALM_POLYGON = Object.freeze([0, 1, 5, 9, 13, 17]);
const PALM_FIT_WEIGHTS = Object.freeze([1, 0.5, 1, 1, 1, 1]);

export const REGION_IDS = Object.freeze([PALM, ...BONES.map((b) => b.id)]);

const SEG_LABEL = { metacarpal: 'base (metacarpal)', proximal: 'base segment', middle: 'middle segment', distal: 'tip segment' };
const FINGER_LABEL = { thumb: 'Thumb', index: 'Index finger', middle: 'Middle finger', ring: 'Ring finger', little: 'Little finger' };
/** Human label for a region id ("Index finger – middle segment"). */
export function regionLabel(id) {
  if (id === PALM) return 'Palm';
  const [finger, seg] = String(id).split('.');
  return FINGER_LABEL[finger] && SEG_LABEL[seg] ? `${FINGER_LABEL[finger]} – ${SEG_LABEL[seg]}` : null;
}
export const isRegionId = (id) => REGION_IDS.includes(id);

// ---------------------------------------------------------------- small geometry
const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y });
const dot = (p, q) => p.x * q.x + p.y * q.y;
const len = (p) => Math.hypot(p.x, p.y);

/** Distance from p to segment a–b, and the clamped parameter t along it. */
export function segmentDistance(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return { d: Math.hypot(p.x - (a.x + t * ab.x), p.y - (a.y + t * ab.y)), t };
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i]; const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToPolygon(p, poly) {
  if (pointInPolygon(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i += 1) best = Math.min(best, segmentDistance(p, poly[i], poly[(i + 1) % poly.length]).d);
  return best;
}

/** Palm length (wrist → middle MCP) and palm width (index MCP → little MCP) of a 21-point hand, in its own units. */
export function palmLength(lm) { return Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y); }
export function palmWidth(lm) { return Math.hypot(lm[17].x - lm[5].x, lm[17].y - lm[5].y); }

// ---------------------------------------------------------------- skinning weights
export const SKIN_DEFAULTS = Object.freeze({
  sigma: 0.06, //      Gaussian falloff, in palm lengths: a neighbouring finger's bone (≈0.17 away) gets < 2 % weight
  minWeight: 0.02, //  weights below this are dropped (then renormalized)
  maxRegions: 4,
});

/**
 * Skinning weights for one reference point.
 *   pRef:   { x, y } reference pixels
 *   refLm:  21 reference landmarks in reference pixels
 *   anchor: optional { region } — a doctor-pinned region (weight 1, no blending)
 *   finger: optional finger name ('index'…; Finger Band objects) — only that finger's bones are considered
 * Returns { weights: [{ region, w }] (sum 1, largest first), primary, confidence, pinned }.
 * `confidence` (0..1) is the primary region's weight: low values mean the point sits between regions (ambiguous).
 */
export function computeSkinWeights(pRef, refLm, { anchor = null, finger = null, options = {} } = {}) {
  const cfg = { ...SKIN_DEFAULTS, ...options };
  if (anchor && isRegionId(anchor.region)) {
    return { weights: [{ region: anchor.region, w: 1 }], primary: anchor.region, confidence: 1, pinned: true };
  }
  const L = palmLength(refLm) || 1;
  const sigma = cfg.sigma * L;
  const fingerName = FINGERS.includes(finger) ? finger : null;
  const candidates = [];
  if (!fingerName) {
    const poly = PALM_POLYGON.map((i) => refLm[i]);
    candidates.push({ region: PALM, d: distanceToPolygon(pRef, poly) });
  }
  for (const bone of BONES) {
    if (fingerName && bone.finger !== fingerName) continue;
    candidates.push({ region: bone.id, d: segmentDistance(pRef, refLm[bone.a], refLm[bone.b]).d });
  }
  let weights = candidates.map((c) => ({ region: c.region, w: Math.exp(-((c.d / sigma) ** 2)), d: c.d }));
  const total0 = weights.reduce((s, x) => s + x.w, 0);
  if (!(total0 > 1e-12)) {
    // Far from everything (e.g. below the wrist): follow the nearest region only.
    const nearest = candidates.reduce((m, c) => (c.d < m.d ? c : m));
    return { weights: [{ region: nearest.region, w: 1 }], primary: nearest.region, confidence: 1, pinned: false };
  }
  weights = weights
    .map((x) => ({ region: x.region, w: x.w / total0 }))
    .filter((x) => x.w >= cfg.minWeight)
    .sort((a, b) => b.w - a.w)
    .slice(0, cfg.maxRegions);
  const total = weights.reduce((s, x) => s + x.w, 0);
  weights = weights.map((x) => ({ region: x.region, w: x.w / total }));
  return { weights, primary: weights[0].region, confidence: weights[0].w, pinned: false };
}

// ---------------------------------------------------------------- per-frame region transforms
// An affine map is { a, b, c, d, e, f }:  x' = a·x + c·y + e,  y' = b·x + d·y + f  (canvas setTransform order).
export const applyAffine = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
export const affineScale = (m) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));

function solve3(A, v) {
  // Cramer's rule for a symmetric 3×3 system.
  const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-12) return null;
  const col = (k) => A.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

/** Weighted least-squares affine from reference points to live points (≥ 3 non-collinear pairs), or null. */
export function fitAffine(refPts, livePts, weights = null) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const bx = [0, 0, 0]; const by = [0, 0, 0];
  for (let i = 0; i < refPts.length; i += 1) {
    const w = weights ? weights[i] : 1;
    const r = [refPts[i].x, refPts[i].y, 1];
    for (let j = 0; j < 3; j += 1) {
      for (let k = 0; k < 3; k += 1) A[j][k] += w * r[j] * r[k];
      bx[j] += w * r[j] * livePts[i].x;
      by[j] += w * r[j] * livePts[i].y;
    }
  }
  const sx = solve3(A, bx); const sy = solve3(A, by);
  if (!sx || !sy) return null;
  return { a: sx[0], c: sx[1], e: sx[2], b: sy[0], d: sy[1], f: sy[2] };
}

/**
 * The bone's affine (reference px → live px): along the bone it stretches by liveLength/refLength; across the bone it
 * scales by `acrossScale` (the hand's overall scale). Both frames are right-handed the same way, so a hand that passed
 * the chirality check keeps its orientation.
 */
export function boneAffine(rA, rB, lA, lB, acrossScale) {
  const ru = sub(rB, rA); const rl = len(ru);
  const lu = sub(lB, lA); const ll = len(lu);
  if (!(rl > 1e-9) || !(ll > 1e-9)) return null;
  const u = { x: ru.x / rl, y: ru.y / rl }; const n = { x: -u.y, y: u.x };
  const u2 = { x: lu.x / ll, y: lu.y / ll }; const n2 = { x: -u2.y, y: u2.x };
  const s = ll / rl;
  // L = s·u2·uᵀ + k·n2·nᵀ
  const k = acrossScale;
  const a = s * u2.x * u.x + k * n2.x * n.x;
  const c = s * u2.x * u.y + k * n2.x * n.y;
  const b = s * u2.y * u.x + k * n2.y * n.x;
  const d = s * u2.y * u.y + k * n2.y * n.y;
  return { a, b, c, d, e: lA.x - (a * rA.x + c * rA.y), f: lA.y - (b * rA.x + d * rA.y) };
}

/**
 * All region transforms for one frame: { palm: affine, 'index.middle': affine, … }, or null when the palm cannot be
 * fitted. `refLm` reference px, `liveLm` live video px (21 each).
 */
export function computeRegionTransforms(refLm, liveLm) {
  const palm = fitAffine(PALM_POLYGON.map((i) => refLm[i]), PALM_POLYGON.map((i) => liveLm[i]), PALM_FIT_WEIGHTS);
  if (!palm) return null;
  // Across-bone scale = the hand's overall scale, measured on the palm (robust to fingers bending towards the camera).
  const handScale = (palmLength(liveLm) + palmWidth(liveLm)) / ((palmLength(refLm) + palmWidth(refLm)) || 1);
  const out = { [PALM]: palm };
  for (const bone of BONES) {
    out[bone.id] = boneAffine(refLm[bone.a], refLm[bone.b], liveLm[bone.a], liveLm[bone.b], handScale) || palm;
  }
  return out;
}

/** The blended affine for one marking: Σ wᵢ·Mᵢ over its skinning weights. */
export function blendAffine(weights, transforms) {
  const m = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };
  let total = 0;
  for (const { region, w } of weights) {
    const t = transforms[region];
    if (!t) continue;
    m.a += w * t.a; m.b += w * t.b; m.c += w * t.c; m.d += w * t.d; m.e += w * t.e; m.f += w * t.f;
    total += w;
  }
  if (!(total > 0)) return transforms[PALM] || null;
  if (Math.abs(total - 1) > 1e-9) { m.a /= total; m.b /= total; m.c /= total; m.d /= total; m.e /= total; m.f /= total; }
  return m;
}

/** Weighted reliability of a marking from per-region reliabilities (0..1; regions not listed count as 1). */
export function blendReliability(weights, reliability) {
  if (!reliability) return 1;
  let r = 0;
  for (const { region, w } of weights) r += w * (reliability[region] ?? 1);
  return r;
}

// ---------------------------------------------------------------- perspective palm (homography)
/**
 * The palm is close to a plane, so under a real (perspective) camera its true motion is a HOMOGRAPHY, not an affine:
 * a tilted palm is foreshortened more at its far side. On the synthetic benchmark (curved palm, perspective, noise up to
 * 1 % of palm width) a homography fitted on the 6 palm landmarks reduced palm-marking error 2–3× versus the affine; see
 * docs/HAND_AR_ACCURACY.md. It has more freedom (8 vs 6 parameters from 6 points), so it is only used when it is
 * WELL-CONDITIONED (checked every frame by `homographyIsSane`); otherwise the affine is used.
 *
 * Returned as a 3×3 row-major array [h0..h8]. Hartley-normalised, weighted least squares.
 */
function normaliser(pts) {
  const n = pts.length;
  const c = pts.reduce((a, p) => ({ x: a.x + p.x / n, y: a.y + p.y / n }), { x: 0, y: 0 });
  const d = pts.reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0) / n || 1;
  const k = Math.SQRT2 / d;
  return { apply: (p) => ({ x: (p.x - c.x) * k, y: (p.y - c.y) * k }), T: [k, 0, -k * c.x, 0, k, -k * c.y, 0, 0, 1], Tinv: [1 / k, 0, c.x, 0, 1 / k, c.y, 0, 0, 1] };
}
const mul3 = (A, B) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]));

export function fitHomography(src, dst, weights = null) {
  if (src.length < 4) return null;
  const ns = normaliser(src); const nd = normaliser(dst);
  const S = src.map(ns.apply); const D = dst.map(nd.apply);
  const N = Array.from({ length: 8 }, () => new Array(9).fill(0));
  const addRow = (row, rhs, w) => { for (let i = 0; i < 8; i += 1) { for (let j = 0; j < 8; j += 1) N[i][j] += w * row[i] * row[j]; N[i][8] += w * row[i] * rhs; } };
  S.forEach((p, i) => {
    const q = D[i]; const w = weights ? weights[i] : 1;
    addRow([p.x, p.y, 1, 0, 0, 0, -p.x * q.x, -p.y * q.x], q.x, w);
    addRow([0, 0, 0, p.x, p.y, 1, -p.x * q.y, -p.y * q.y], q.y, w);
  });
  for (let c = 0; c < 8; c += 1) {
    let piv = c;
    for (let r = c + 1; r < 8; r += 1) if (Math.abs(N[r][c]) > Math.abs(N[piv][c])) piv = r;
    [N[c], N[piv]] = [N[piv], N[c]];
    if (Math.abs(N[c][c]) < 1e-10) return null;
    for (let r = 0; r < 8; r += 1) if (r !== c) { const f = N[r][c] / N[c][c]; for (let k = c; k < 9; k += 1) N[r][k] -= f * N[c][k]; }
  }
  const hn = [...N.map((row, i) => row[8] / N[i][i]), 1];
  const H = mul3(nd.Tinv, mul3(hn, ns.T));
  if (!H.every(Number.isFinite) || Math.abs(H[8]) < 1e-12) return null;
  return H.map((v) => v / H[8]);
}

export function applyHomography(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/** First-order (affine) approximation of H around p: exact at p, so it blends with the bone affines like any region. */
export function linearizeHomography(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  const q = applyHomography(H, p);
  const a = (H[0] - q.x * H[6]) / w; const c = (H[1] - q.x * H[7]) / w;
  const b = (H[3] - q.y * H[6]) / w; const d = (H[4] - q.y * H[7]) / w;
  return { a, b, c, d, e: q.x - (a * p.x + c * p.y), f: q.y - (b * p.x + d * p.y) };
}

/**
 * Accept the homography only if, over the PALM (its 6 landmarks and the midpoints between them — the only area the palm
 * transform serves; fingers follow their own bones): the projective denominator stays well positive (no horizon / flip),
 * orientation is preserved, and it never departs from the palm affine by more than `maxDeviation` palm widths (a large
 * departure fitted from 6 noisy points is noise, not perspective).
 */
export function homographyIsSane(H, refLm, affine, liveLm, { maxDeviation = 0.25 } = {}) {
  if (!H) return false;
  const pw = palmWidth(liveLm) || 1;
  const poly = PALM_POLYGON.map((i) => refLm[i]);
  const probes = [...poly, ...poly.map((p, i) => ({ x: (p.x + poly[(i + 1) % poly.length].x) / 2, y: (p.y + poly[(i + 1) % poly.length].y) / 2 }))];
  const w0 = H[6] * refLm[0].x + H[7] * refLm[0].y + H[8];
  const affineFlip = affine.a * affine.d - affine.b * affine.c <= 0;
  for (const p of probes) {
    const w = H[6] * p.x + H[7] * p.y + H[8];
    if (!(w / w0 > 0.5 && w / w0 < 2)) return false;
    const L = linearizeHomography(H, p);
    if ((L.a * L.d - L.b * L.c <= 0) !== affineFlip) return false;
    const h = applyHomography(H, p); const a = applyAffine(affine, p);
    if (Math.hypot(h.x - a.x, h.y - a.y) / pw > maxDeviation) return false;
  }
  return true;
}

/** The palm homography for a frame (or null when it should not be trusted). */
export function computePalmHomography(refLm, liveLm, palmAffine) {
  const H = fitHomography(PALM_POLYGON.map((i) => refLm[i]), PALM_POLYGON.map((i) => liveLm[i]), PALM_FIT_WEIGHTS);
  return homographyIsSane(H, refLm, palmAffine, liveLm) ? H : null;
}
