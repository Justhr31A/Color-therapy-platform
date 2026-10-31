/**
 * ACCEPTANCE THRESHOLDS for hand-AR alignment — fixed BEFORE any evaluation was run (see docs/HAND_AR_ACCURACY.md).
 * Do not loosen these to make a result pass; report the failure instead.
 *
 * Unit: every distance is in PALM WIDTHS (live distance index-MCP → little-MCP), so results are comparable across
 * camera resolutions, distances and hand sizes. For an adult palm (~8 cm), 0.05 palm width ≈ 4 mm.
 *
 * SYNTHETIC thresholds apply to deterministic generated sequences with exact ground truth (frontend/tools/ar/). They
 * test the geometry and the tracking logic, NOT what a real camera and MediaPipe produce.
 * REAL thresholds apply to labelled real-camera recordings (the validation export, tools/ar/validation-report.mjs).
 */
export const ACCEPTANCE = Object.freeze({
  synthetic: Object.freeze({
    // Supported condition 1 — flat open hand facing the camera (tilt ≤ 10°), any position/rotation/scale, own proportions.
    flat: Object.freeze({ median: 0.02, p95: 0.05, within: 0.08, withinRate: 0.99 }),
    // Supported condition 2 — natural pose: tilt ≤ 20°, each finger joint flexed ≤ 25°, spread ±8°, proportions ±12 %.
    natural: Object.freeze({ median: 0.04, p95: 0.1, within: 0.1, withinRate: 0.95 }),
    // 'hard' (tilt ≤ 35°, flexion ≤ 50°) is OUTSIDE the supported conditions: measured and reported, no threshold.
  }),
  temporal: Object.freeze({
    stationaryJitterRms: 0.004, //  marking RMS motion with a still hand and 0.5 % landmark noise
    shakeErrorP95: 0.06, //          p95 error during a 4 Hz, 0.15-palm hand shake
    rapidLagMean: 0.06, //           mean error added during a 2.5 palm-width/s sweep
    reacquireMs: 200, //             overlay visible again after a 0.4 s dropout
    reacquireErrorMax: 0.05, //      and placed correctly on the first visible frame (no snap from the old place)
  }),
  real: Object.freeze({
    median: 0.06, p95: 0.15, within: 0.1, withinRate: 0.9,
    stationaryJitterRms: 0.01,
    reacquireMs: 500,
    minFps: 24,
  }),
});
