/**
 * Fits a 2D similarity transform (uniform scale + rotation + translation —
 * 4 degrees of freedom, no shear/stretch) that best maps `refPoints` onto
 * `livePoints`, using every corresponding pair. This is deliberately the
 * simplest transform that can express "this hand is somewhere else, some
 * size, and turned some amount" (Step 6A: position, scale, orientation)
 * without claiming anything more precise — a real hand isn't rigid, so a
 * closer per-finger fit would be overfitting for what this stage needs to
 * prove.
 *
 * Closed-form least-squares solution via complex numbers: treat each 2D
 * point as a complex number x+iy. The optimal scale+rotation is the complex
 * number `a` minimizing sum(|a*refCentered_i - liveCentered_i|^2), which has
 * a direct closed-form solution (no iteration needed):
 *
 *   a = sum(conj(refCentered_i) * liveCentered_i) / sum(|refCentered_i|^2)
 *
 * |a| is the fitted scale, arg(a) is the fitted rotation. Translation is
 * recovered from the two centroids.
 */

function centroid(points) {
  const n = points.length;
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / n, y: sum.y / n };
}

/**
 * Returns { a: {re, im}, refCentroid, liveCentroid } or null if the
 * reference/live point sets are degenerate (e.g. fewer than 2 points, or
 * the reference points are all coincident so scale/rotation are undefined).
 */
export function computeSimilarityTransform(refPoints, livePoints) {
  if (!refPoints || !livePoints || refPoints.length < 2 || refPoints.length !== livePoints.length) {
    return null;
  }

  const refCentroid = centroid(refPoints);
  const liveCentroid = centroid(livePoints);

  let numRe = 0;
  let numIm = 0;
  let den = 0;

  for (let i = 0; i < refPoints.length; i += 1) {
    const rx = refPoints[i].x - refCentroid.x;
    const ry = refPoints[i].y - refCentroid.y;
    const lx = livePoints[i].x - liveCentroid.x;
    const ly = livePoints[i].y - liveCentroid.y;

    // conj(r) * l = (rx - i*ry) * (lx + i*ly) = (rx*lx + ry*ly) + i*(rx*ly - ry*lx)
    numRe += rx * lx + ry * ly;
    numIm += rx * ly - ry * lx;
    den += rx * rx + ry * ry;
  }

  if (den < 1e-9) return null; // reference points are (nearly) coincident — can't fit scale/rotation

  return {
    a: { re: numRe / den, im: numIm / den },
    refCentroid,
    liveCentroid,
  };
}

/** Maps a point from reference-view space into live-camera-normalized space using a fitted transform. */
export function applyTransform(transform, point) {
  const cx = point.x - transform.refCentroid.x;
  const cy = point.y - transform.refCentroid.y;
  const { re, im } = transform.a;
  // complex multiply (re + i*im) * (cx + i*cy)
  const x = re * cx - im * cy + transform.liveCentroid.x;
  const y = re * cy + im * cx + transform.liveCentroid.y;
  return { x, y };
}

/** The fitted uniform scale factor (1.0 = same size, 0.5 = half size, etc). */
export function transformScale(transform) {
  return Math.sqrt(transform.a.re * transform.a.re + transform.a.im * transform.a.im);
}

/** The fitted rotation, in radians. */
export function transformRotation(transform) {
  return Math.atan2(transform.a.im, transform.a.re);
}

/** The fitted translation component (where the reference-space origin (0,0) lands). */
export function transformTranslation(transform) {
  return applyTransform(transform, { x: 0, y: 0 });
}
