import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getReferencePointsForView } from '../../src/tracking/referenceHandPoints.js';

const require = createRequire(import.meta.url);
// The backend's asset registry is the source of the reference canvas sizes (width/height per view).
export const HAND_ASSETS = require('../../../backend/src/config/handAssets.js').HAND_ASSETS;
export const VIEW_KEYS = Object.keys(HAND_ASSETS);

/** Ground-truth similarity transform (rotate by theta, scale by s, translate) — used to SYNTHESISE "live" points. */
export function rst(p, s, theta, tx, ty) {
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  return { x: s * (p.x * c - p.y * sn) + tx, y: s * (p.x * sn + p.y * c) + ty };
}

export function assertClose(actual, expected, eps, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${message} expected ${expected} but got ${actual} (difference ${Math.abs(actual - expected)}, allowed ${eps})`
  );
}

/** The 6 calibration reference points of a view, converted to that view's reference PIXEL space. */
export function refPixelsFor(viewKey) {
  const { width, height } = HAND_ASSETS[viewKey];
  return getReferencePointsForView(viewKey).map((p) => ({ x: p.x * width, y: p.y * height }));
}

export const VIDEO = { width: 1280, height: 720 };
