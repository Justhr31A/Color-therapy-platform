/**
 * Finger guides — where each finger runs on each of the four reference hand
 * images, used ONLY by the authoring Studio to place and orient a Finger Band
 * so it wraps across a finger instead of floating as a generic circle.
 *
 * For each view and finger:
 *   base  — the knuckle (where the finger meets the palm)      } normalized 0..1
 *   tip   — the fingertip                                       } (fraction of that
 *   width — the finger's apparent width (fraction of canvas width)  image's width/height)
 *
 * HOW THESE WERE MADE: measured on the actual PNG files by segmenting the
 * hand outline and tracing each finger's centreline (the thumb along the ridge
 * of the distance transform), then checked by drawing them on the images.
 * They are APPROXIMATE authoring aids, accurate to a few percent — good for
 * placing and orienting a band, NOT a calibrated model of any real hand.
 *
 * They are deliberately separate from tracking/referenceHandPoints.js (the AR
 * calibration), which is untouched. Nothing here feeds AR. A future AR
 * finger-band mapping will use `landmarkReference` on the object, which is
 * reserved and left null by this phase.
 *
 * If a hand PNG is ever replaced these must be re-measured (the PNG checksum
 * test in the backend flags any change).
 */
export const FINGER_GUIDES = Object.freeze({
  left_front: {
    thumb: { base: { x: 0.262, y: 0.667 }, tip: { x: 0.059, y: 0.464 }, width: 0.176 },
    index: { base: { x: 0.382, y: 0.44 }, tip: { x: 0.361, y: 0.073 }, width: 0.145 },
    middle: { base: { x: 0.558, y: 0.43 }, tip: { x: 0.536, y: 0.015 }, width: 0.154 },
    ring: { base: { x: 0.732, y: 0.44 }, tip: { x: 0.728, y: 0.026 }, width: 0.148 },
    little: { base: { x: 0.894, y: 0.45 }, tip: { x: 0.917, y: 0.171 }, width: 0.144 },
  },
  right_front: {
    thumb: { base: { x: 0.74, y: 0.667 }, tip: { x: 0.943, y: 0.463 }, width: 0.176 },
    index: { base: { x: 0.619, y: 0.43 }, tip: { x: 0.639, y: 0.073 }, width: 0.144 },
    middle: { base: { x: 0.441, y: 0.43 }, tip: { x: 0.463, y: 0.015 }, width: 0.154 },
    ring: { base: { x: 0.268, y: 0.43 }, tip: { x: 0.272, y: 0.026 }, width: 0.148 },
    little: { base: { x: 0.106, y: 0.46 }, tip: { x: 0.082, y: 0.171 }, width: 0.144 },
  },
  left_back: {
    thumb: { base: { x: 0.741, y: 0.666 }, tip: { x: 0.943, y: 0.463 }, width: 0.178 },
    index: { base: { x: 0.619, y: 0.43 }, tip: { x: 0.639, y: 0.072 }, width: 0.145 },
    middle: { base: { x: 0.442, y: 0.42 }, tip: { x: 0.463, y: 0.014 }, width: 0.153 },
    ring: { base: { x: 0.268, y: 0.43 }, tip: { x: 0.272, y: 0.026 }, width: 0.148 },
    little: { base: { x: 0.106, y: 0.45 }, tip: { x: 0.082, y: 0.171 }, width: 0.144 },
  },
  right_back: {
    thumb: { base: { x: 0.213, y: 0.659 }, tip: { x: 0.046, y: 0.457 }, width: 0.143 },
    index: { base: { x: 0.306, y: 0.42 }, tip: { x: 0.291, y: 0.072 }, width: 0.116 },
    middle: { base: { x: 0.448, y: 0.41 }, tip: { x: 0.431, y: 0.014 }, width: 0.123 },
    ring: { base: { x: 0.589, y: 0.42 }, tip: { x: 0.586, y: 0.025 }, width: 0.119 },
    little: { base: { x: 0.72, y: 0.44 }, tip: { x: 0.738, y: 0.169 }, width: 0.116 },
  },
});

export const GUIDED_VIEW_KEYS = Object.freeze(Object.keys(FINGER_GUIDES));
