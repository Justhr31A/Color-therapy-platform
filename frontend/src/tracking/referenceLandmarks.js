/**
 * The 21-point hand skeleton of each REFERENCE hand diagram, in MediaPipe HandLandmarker order:
 *
 *   0 wrist · 1 thumb CMC · 2 thumb MCP · 3 thumb IP · 4 thumb tip
 *   5-8 index MCP/PIP/DIP/tip · 9-12 middle · 13-16 ring · 17-20 little
 *
 * Normalized 0..1 against each view's own PNG (x = fraction of width, y = fraction of height) — the same space the
 * Protocol Studio saves markings in. Separate tables per view: palm-facing and back-of-hand are different surfaces and
 * nothing here maps one onto the other.
 *
 * HOW THESE WERE MEASURED (on the PNGs in backend/assets/hands, not guessed off a thumbnail):
 *   - PIP / DIP / thumb IP: the centre of each drawn joint crease (front) or knuckle line (back), found as connected
 *     components of the line art, projected onto the finger's centreline (builder/config/fingerGuides.js).
 *   - MCP: the drawn finger-root line + 0.02 of the height (the knuckle sits just proximal to the finger root).
 *   - Tips: the fingertip contour moved ~35 px inwards along the finger (where MediaPipe puts the tip landmark).
 *   - Wrist: the centre of the drawn wrist crease.
 *   - Thumb MCP: centre of the thumb at its drawn MCP crease; thumb CMC: between wrist and thumb MCP, towards the thumb
 *     (the least certain point — it is down-weighted in the palm fit).
 * right_front is the exact mirror of left_front (the PNGs are mirror images); right_back was measured on its own PNG.
 *
 * These replace the 6-point table that fed the old single-transform fit. That table had the WRIST on the outer edge of
 * the wrist (0.37–0.40 palm lengths from the wrist centre in every view) and the THUMB "MCP" near the thumb's IP joint /
 * tip (0.18–0.36 palm lengths off) — the two largest sources of marking misplacement. See docs/HAND_AR_ACCURACY.md.
 *
 * They are still measurements of a DRAWING. An administrator can refine them per view at /admin/hand-reference
 * (preview on one device, then commit the exported JSON here).
 */
export const LANDMARK_NAMES = Object.freeze([
  'wrist',
  'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip',
  'index_mcp', 'index_pip', 'index_dip', 'index_tip',
  'middle_mcp', 'middle_pip', 'middle_dip', 'middle_tip',
  'ring_mcp', 'ring_pip', 'ring_dip', 'ring_tip',
  'little_mcp', 'little_pip', 'little_dip', 'little_tip',
]);

export const BUILT_IN_REFERENCE_LANDMARKS = Object.freeze({
  left_front: Object.freeze([
    [0.61, 0.955], [0.4, 0.84], [0.235, 0.7], [0.18, 0.59], [0.0724, 0.478], [0.3834, 0.465], [0.3749, 0.316],
    [0.369, 0.212], [0.362, 0.091], [0.5587, 0.444], [0.5495, 0.27], [0.5428, 0.143], [0.537, 0.033], [0.7322, 0.459],
    [0.7303, 0.264], [0.7293, 0.16], [0.7282, 0.044], [0.8906, 0.491], [0.9004, 0.372], [0.9074, 0.287], [0.9155, 0.189],
  ]),
  right_front: Object.freeze([
    [0.39, 0.955], [0.6, 0.84], [0.765, 0.7], [0.82, 0.59], [0.9276, 0.478], [0.6166, 0.465], [0.6251, 0.316],
    [0.631, 0.212], [0.638, 0.091], [0.4413, 0.444], [0.4505, 0.27], [0.4572, 0.143], [0.463, 0.033], [0.2678, 0.459],
    [0.2697, 0.264], [0.2707, 0.16], [0.2718, 0.044], [0.1094, 0.491], [0.0996, 0.372], [0.0926, 0.287], [0.0845, 0.189],
  ]),
  left_back: Object.freeze([
    [0.383, 0.95], [0.6, 0.83], [0.75, 0.69], [0.84, 0.57], [0.9295, 0.477], [0.6175, 0.457], [0.6266, 0.294],
    [0.6322, 0.194], [0.638, 0.09], [0.4401, 0.457], [0.4501, 0.263], [0.4559, 0.152], [0.4621, 0.032], [0.2677, 0.464],
    [0.2692, 0.305], [0.2705, 0.18], [0.2718, 0.044], [0.1091, 0.486], [0.1001, 0.381], [0.0942, 0.313], [0.0835, 0.189],
  ]),
  right_back: Object.freeze([
    [0.495, 0.94], [0.32, 0.82], [0.2, 0.683], [0.127, 0.564], [0.0566, 0.471], [0.3073, 0.449], [0.3004, 0.291],
    [0.2963, 0.194], [0.2918, 0.09], [0.4493, 0.441], [0.4417, 0.264], [0.4372, 0.158], [0.4318, 0.032], [0.5892, 0.448],
    [0.5881, 0.296], [0.5871, 0.176], [0.5861, 0.043], [0.7173, 0.481], [0.7241, 0.378], [0.7288, 0.307], [0.7368, 0.187],
  ]),});

export const REFERENCE_VIEW_KEYS = Object.freeze(Object.keys(BUILT_IN_REFERENCE_LANDMARKS));

/** localStorage key used by the admin reference tool's "preview on this device". Never read by anyone else's browser. */
export const LOCAL_OVERRIDE_KEY = 'ctpp.referenceLandmarks.v1';

/** True when `table` is a usable 21-point table: 21 pairs of finite numbers inside 0..1. */
export function isValidLandmarkTable(table) {
  return Array.isArray(table) && table.length === 21
    && table.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n) && n >= 0 && n <= 1));
}

/** The admin tool's per-device override ({ viewKey: [[x,y]×21] }), or null. Never throws (storage can be blocked). */
export function readLocalOverride(storage = (typeof window !== 'undefined' ? window.localStorage : null)) {
  try {
    if (!storage) return null;
    const raw = storage.getItem(LOCAL_OVERRIDE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const out = {};
    for (const key of REFERENCE_VIEW_KEYS) if (isValidLandmarkTable(data[key])) out[key] = data[key];
    return Object.keys(out).length ? out : null;
  } catch (e) {
    return null;
  }
}

/**
 * The 21 normalized reference landmarks for a view as [{x, y}], or null for a non-hand / unknown view.
 * `override` ({ viewKey: table }) wins for the views it contains.
 */
export function getReferenceLandmarks(viewKey, override = null) {
  const table = (override && isValidLandmarkTable(override[viewKey]) && override[viewKey]) || BUILT_IN_REFERENCE_LANDMARKS[viewKey];
  if (!table) return null;
  return table.map(([x, y]) => ({ x, y }));
}
