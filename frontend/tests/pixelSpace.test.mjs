/**
 * [DETERMINISTIC SOFTWARE TESTS] normalized <-> pixel coordinate handling.
 *
 * Includes the regression test for the real bug found on a real device: fitting the transform on raw
 * 0-1 fractions is wrong because the reference image (tall) and the video frame (wide) have different
 * aspect ratios. The fix fits in PIXEL space. Both behaviours are demonstrated here numerically.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSimilarityTransform, applyTransform } from '../src/tracking/similarityTransform.js';
import { getReferencePointsForView } from '../src/tracking/referenceHandPoints.js';
import { assertClose, rst, HAND_ASSETS, VIEW_KEYS, VIDEO } from './support/helpers.mjs';

describe('[DETERMINISTIC] normalized <-> pixel round trip', () => {
  it('normalized -> reference pixels -> normalized returns the original value for every view', () => {
    for (const view of VIEW_KEYS) {
      const { width, height } = HAND_ASSETS[view];
      for (let x = 0; x <= 1; x += 0.125) {
        for (let y = 0; y <= 1; y += 0.125) {
          assertClose((x * width) / width, x, 1e-12, `${view} x`);
          assertClose((y * height) / height, y, 1e-12, `${view} y`);
        }
      }
    }
  });

  it('every reference calibration point lands inside its own reference image', () => {
    for (const view of VIEW_KEYS) {
      const { width, height } = HAND_ASSETS[view];
      for (const p of getReferencePointsForView(view)) {
        assert.ok(p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1, `${view}: normalized point out of range`);
        assert.ok(p.x * width < width && p.y * height < height);
      }
    }
  });
});

describe('[DETERMINISTIC] regression: the transform must be fitted in PIXEL space, not on raw 0-1 fractions', () => {
  const view = 'left_front';
  const { width: RW, height: RH } = HAND_ASSETS[view];
  const refNorm = getReferencePointsForView(view);
  const refPix = refNorm.map((p) => ({ x: p.x * RW, y: p.y * RH }));

  // A "live" hand: the SAME physical shape, scaled/rotated/moved inside a WIDE 1280x720 video frame.
  const s = 0.2445; const theta = 0.12; const tx = 640; const ty = 250;
  const livePix = refPix.map((p) => rst(p, s, theta, tx, ty));
  const liveNorm = livePix.map((p) => ({ x: p.x / VIDEO.width, y: p.y / VIDEO.height })); // what MediaPipe reports

  // dots the doctor might place: near the calibration points' centroid, and far from it
  const savedDots = [{ x: 0.5, y: 0.62 }, { x: 0.15, y: 0.3 }, { x: 0.85, y: 0.9 }, { x: 0.4, y: 0.5 }];

  it('FIXED behaviour: pixel-space fit reproduces the true position of every dot (error ~ 0)', () => {
    const t = computeSimilarityTransform(refPix, liveNorm.map((p) => ({ x: p.x * VIDEO.width, y: p.y * VIDEO.height })));
    for (const d of savedDots) {
      const got = applyTransform(t, { x: d.x * RW, y: d.y * RH });
      const want = rst({ x: d.x * RW, y: d.y * RH }, s, theta, tx, ty);
      assertClose(got.x, want.x, 1e-6, 'x px'); assertClose(got.y, want.y, 1e-6, 'y px');
    }
  });

  it('OLD behaviour (fit on raw fractions) is measurably wrong — this is why the bug existed', () => {
    const tWrong = computeSimilarityTransform(refNorm, liveNorm);
    let worst = 0;
    for (const d of savedDots) {
      const got = applyTransform(tWrong, d); // normalized in, normalized out
      const want = rst({ x: d.x * RW, y: d.y * RH }, s, theta, tx, ty);
      worst = Math.max(worst, Math.hypot((got.x - want.x / VIDEO.width) * VIDEO.width, (got.y - want.y / VIDEO.height) * VIDEO.height));
    }
    assert.ok(worst > 5, `expected the old approach to be off by several pixels, but worst error was only ${worst.toFixed(3)} px`);
  });
});
