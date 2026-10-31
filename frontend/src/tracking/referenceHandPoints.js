/**
 * Reference hand-landmark positions, ONE set per Doctor Builder hand view.
 *
 * These are the same six stable points Step 6A asks for (wrist + the five
 * MCP/base-knuckle joints), expressed as normalized (0-1) coordinates in
 * the SAME coordinate system the Doctor's protocol objects already use for
 * that view — i.e. a fraction of that view's reference canvas width/height
 * (see backend/src/config/handAssets.js).
 *
 * HISTORICAL NOTE — the methodology below produced the ORIGINAL table, now replaced (see the code):
 *
 * METHODOLOGY (revised after the first real-device test showed the
 * original rough 10%-grid estimate wasn't accurate enough):
 *
 *   - wrist: each of the four PNGs has an explicit short vertical tick mark
 *     drawn at the base of the palm — this is almost certainly the
 *     artwork's own intended wrist-reference point, and was used directly.
 *     (Confirmed self-consistent: Left Front's tick sits at x=0.37 and
 *     Right Front's at x=0.63 — exact mirror images, as they should be.)
 *   - index/middle/ring/pinky MCP: each pair of adjacent fingers has a
 *     visible "valley" (a V-shape where the finger outlines meet). The
 *     MCP x-coordinate was taken as the midpoint between a finger's two
 *     flanking valleys (or valley + outer edge, for the index and pinky);
 *     the y-coordinate from the valley points themselves.
 *   - thumb MCP: the least certain of the six — the artwork only shows one
 *     ambiguous crease mark partway along the thumb (most likely the IP
 *     joint, since there's no separate mark for MCP vs CMC). Placed
 *     slightly palm-ward of that crease as the best available estimate.
 *
 * All 24 points (6 per view x 4 views) were read from dedicated zoomed
 * crops of the actual PNG files with a 2%-labeled grid, not eyeballed off
 * a full-image thumbnail. This is still visual estimation, not output from
 * an actual pose model run against the static images (no such run was
 * possible in the build environment) — treat these as "close," not
 * "exact," and expect the thumb point in particular to need the most
 * further adjustment from real-device feedback.
 */

import { BUILT_IN_REFERENCE_LANDMARKS } from './referenceLandmarks';

// The six points are now DERIVED from the measured 21-point skeleton (referenceLandmarks.js) — indices 0, 2, 5, 9, 13,
// 17 — so there is one source of truth. The earlier hand-estimated table placed the wrist on the edge of the wrist and
// the thumb MCP near the thumb tip; see referenceLandmarks.js and docs/HAND_AR_ACCURACY.md.
const SIX = { wrist: 0, thumbMCP: 2, indexMCP: 5, middleMCP: 9, ringMCP: 13, pinkyMCP: 17 };
export const REFERENCE_HAND_POINTS = Object.freeze(
  Object.fromEntries(
    Object.entries(BUILT_IN_REFERENCE_LANDMARKS).map(([view, table]) => [
      view,
      Object.freeze(Object.fromEntries(Object.entries(SIX).map(([name, i]) => [name, Object.freeze({ x: table[i][0], y: table[i][1] })]))),
    ])
  )
);

// The six calibration points, in a fixed order, paired with MediaPipe's
// HandLandmarker indices for the same anatomical joints (0=wrist,
// 2=thumb MCP, 5=index MCP, 9=middle MCP, 13=ring MCP, 17=pinky MCP).
export const CALIBRATION_POINT_ORDER = ['wrist', 'thumbMCP', 'indexMCP', 'middleMCP', 'ringMCP', 'pinkyMCP'];
export const CALIBRATION_LANDMARK_INDEXES = [0, 2, 5, 9, 13, 17];

/**
 * `viewKey` is e.g. 'left_front' — returns the ordered reference point
 * array matching CALIBRATION_POINT_ORDER, or null if this view has no
 * reference table (organ/body canvases, or an unrecognized key).
 */
export function getReferencePointsForView(viewKey) {
  const table = REFERENCE_HAND_POINTS[viewKey];
  if (!table) return null;
  return CALIBRATION_POINT_ORDER.map((name) => table[name]);
}

// 'left_front' / 'left_back' -> 'Left'; 'right_front' / 'right_back' -> 'Right'.
export function expectedHandSideForView(viewKey) {
  if (viewKey?.startsWith('left')) return 'Left';
  if (viewKey?.startsWith('right')) return 'Right';
  return null;
}
