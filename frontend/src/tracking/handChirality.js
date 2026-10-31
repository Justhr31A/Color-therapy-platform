/**
 * WHY THIS EXISTS (read before touching): after two real-device tests where
 * a hardcoded assumption about MediaPipe's Left/Right labeling convention
 * turned out wrong in two DIFFERENT ways on two different setups, relying
 * on that label for anything load-bearing (gating the AR mapping, deciding
 * which hand to display) was the wrong approach — it depends on an
 * assumption about MediaPipe's training convention and/or the platform's
 * camera driver that cannot be verified without a real device, and has now
 * failed twice.
 *
 * This module sidesteps that question entirely. It never asks "is this a
 * left or right hand, per MediaPipe's semantics" — it asks a strictly
 * geometric question that needs no external convention at all: "does the
 * live hand's joint arrangement have the same 2D chirality (winding
 * direction) as the reference image for the view the patient selected?"
 *
 * The math (verified numerically, see the test suite):
 *   sign(cross((indexMCP-wrist), (pinkyMCP-wrist)))
 * is invariant under any rotation + uniform scale + translation (which is
 * all our similarity transform can ever represent), and is FLIPPED under
 * any mirror reflection. Since a real hand and its mirror image are
 * related by a reflection (not a rotation), this sign is exactly the
 * signal needed to detect "wrong hand" or any mirroring inconsistency —
 * and, critically, it ALSO predicts when the similarity transform fit
 * would be geometrically invalid (forcing a rotation-only transform onto a
 * mirrored point correspondence always produces a distorted fit), which is
 * very likely the direct cause of the "dot significantly misplaced" bug,
 * not just reference-point imprecision.
 *
 * MediaPipe's own "handedness" label is NOT used for gating anywhere in
 * this app anymore. It is only ever shown in the debug panel as a
 * diagnostic value to compare against this geometric check.
 */

function crossZ(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

/** Returns -1, 0, or 1. 0 means degenerate (wrist/index/pinky nearly colinear — hand edge-on to camera, or bad detection). */
export function chiralitySign(wrist, indexMCP, pinkyMCP) {
  const v1x = indexMCP.x - wrist.x;
  const v1y = indexMCP.y - wrist.y;
  const v2x = pinkyMCP.x - wrist.x;
  const v2y = pinkyMCP.y - wrist.y;
  const cross = crossZ(v1x, v1y, v2x, v2y);
  if (Math.abs(cross) < 1e-6) return 0;
  return cross > 0 ? 1 : -1;
}

/**
 * `referencePoints` is the ordered array from getReferencePointsForView()
 * (CALIBRATION_POINT_ORDER: wrist, thumbMCP, indexMCP, middleMCP, ringMCP,
 * pinkyMCP) — indices 0, 2, 5 are wrist/indexMCP/pinkyMCP.
 */
export function referenceChiralitySign(referencePoints) {
  if (!referencePoints || referencePoints.length < 6) return 0;
  return chiralitySign(referencePoints[0], referencePoints[2], referencePoints[5]);
}

/**
 * `landmarks` is MediaPipe's raw 21-point array for one hand (result.landmarks[0]).
 * Indices 0, 5, 17 are wrist/indexMCP/pinkyMCP in MediaPipe's own topology.
 */
export function liveChiralitySign(landmarks) {
  if (!landmarks || landmarks.length < 21) return 0;
  return chiralitySign(landmarks[0], landmarks[5], landmarks[17]);
}
