/**
 * [DETERMINISTIC SOFTWARE TESTS] geometric hand-chirality gate + handedness label.
 * Verifies the geometry that decides "is this the hand the protocol was drawn for". Whether MediaPipe
 * detects a real hand reliably is real-device validation, not something these tests can show.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chiralitySign, referenceChiralitySign, liveChiralitySign } from '../src/tracking/handChirality.js';
import { correctHandedness } from '../src/tracking/handedness.js';
import { getReferencePointsForView, expectedHandSideForView } from '../src/tracking/referenceHandPoints.js';
import { rst, VIEW_KEYS } from './support/helpers.mjs';

const EXPECTED_SIGNS = { left_front: 1, right_front: -1, left_back: -1, right_back: 1 };
const W = { x: 0, y: 0 }; const I = { x: 10, y: -20 }; const P = { x: 40, y: -10 };

/** Builds a 21-landmark array (MediaPipe topology) where indexes 0/5/17 come from the given three points. */
function landmarksFrom(wrist, index, pinky) {
  const arr = Array.from({ length: 21 }, (_, i) => ({ x: 0.5 + i * 0.001, y: 0.5 - i * 0.001 }));
  arr[0] = wrist; arr[5] = index; arr[17] = pinky;
  return arr;
}

describe('[DETERMINISTIC] chirality sign', () => {
  it('reference tables: left_front +1, right_front -1, left_back -1, right_back +1 (alternating; front/back mirror pairs opposite)', () => {
    for (const view of VIEW_KEYS) assert.equal(referenceChiralitySign(getReferencePointsForView(view)), EXPECTED_SIGNS[view], view);
    assert.equal(EXPECTED_SIGNS.left_front, -EXPECTED_SIGNS.right_front);
    assert.equal(EXPECTED_SIGNS.left_back, -EXPECTED_SIGNS.right_back);
  });

  it('is unchanged by rotation, uniform scaling and translation (so hand pose/distance cannot flip it)', () => {
    for (const view of VIEW_KEYS) {
      const pts = getReferencePointsForView(view);
      for (const [s, th] of [[0.2, 0], [3, 1.2], [1, -2.9], [0.05, 3.1]]) {
        const moved = pts.map((p) => rst(p, s, th, 500, -300));
        assert.equal(referenceChiralitySign(moved), EXPECTED_SIGNS[view], `${view} s=${s} th=${th}`);
      }
    }
  });

  it('is unchanged by non-uniform positive stretching (e.g. a wide video frame)', () => {
    const pts = getReferencePointsForView('left_front').map((p) => ({ x: p.x * 1.78, y: p.y * 0.4 }));
    assert.equal(referenceChiralitySign(pts), 1);
  });

  it('FLIPS under a mirror image — that is exactly what distinguishes a left hand from a right hand', () => {
    for (const view of VIEW_KEYS) {
      const mirrored = getReferencePointsForView(view).map((p) => ({ x: -p.x, y: p.y }));
      assert.equal(referenceChiralitySign(mirrored), -EXPECTED_SIGNS[view], view);
    }
    assert.equal(chiralitySign(W, I, P), -chiralitySign(W, { x: -I.x, y: I.y }, { x: -P.x, y: P.y }));
  });

  it('returns 0 for degenerate/collinear input rather than guessing a hand', () => {
    assert.equal(chiralitySign({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }), 0);
    assert.equal(referenceChiralitySign(null), 0);
    assert.equal(referenceChiralitySign([{ x: 0, y: 0 }]), 0);
    assert.equal(liveChiralitySign(null), 0);
    assert.equal(liveChiralitySign(Array.from({ length: 20 }, () => ({ x: 0, y: 0 }))), 0, 'needs a full 21-landmark hand');
  });

  it('live sign reads landmarks 0 (wrist), 5 (index MCP), 17 (pinky MCP) and matches the reference convention', () => {
    for (const view of VIEW_KEYS) {
      const [wrist, , indexMCP, , , pinkyMCP] = getReferencePointsForView(view);
      assert.equal(liveChiralitySign(landmarksFrom(wrist, indexMCP, pinkyMCP)), referenceChiralitySign(getReferencePointsForView(view)), view);
    }
  });
});

describe('[DETERMINISTIC] handedness label + which side each view expects', () => {
  it('correctHandedness passes the label through unchanged when the pixels are not mirrored (the only way the app calls it)', () => {
    assert.equal(correctHandedness('Left', false), 'Left');
    assert.equal(correctHandedness('Right', false), 'Right');
    assert.equal(correctHandedness('Left'), 'Left');
    assert.equal(correctHandedness(null), null);
    assert.equal(correctHandedness(undefined, true), null);
  });
  it('and swaps only when the pixel data really is mirrored', () => {
    assert.equal(correctHandedness('Left', true), 'Right');
    assert.equal(correctHandedness('Right', true), 'Left');
    assert.equal(correctHandedness('Unknown', true), 'Unknown');
  });
  it('guard: the camera page must keep passing isPixelDataMirrored=false (the value validated on the real device)', () => {
    // The per-frame hand logic moved from the page into tracking/arFrame.js; both files are checked.
    const src = ['../src/pages/patient/CameraSessionPage.jsx', '../src/tracking/arFrame.js']
      .map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
    const calls = [...src.matchAll(/correctHandedness\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ''));
    assert.ok(calls.length > 0, 'expected at least one call');
    for (const args of calls) assert.ok(args.endsWith(',false'), `correctHandedness(${args}) is not passing false`);
  });
  it('each view expects the hand side its name says', () => {
    assert.equal(expectedHandSideForView('left_front'), 'Left');
    assert.equal(expectedHandSideForView('left_back'), 'Left');
    assert.equal(expectedHandSideForView('right_front'), 'Right');
    assert.equal(expectedHandSideForView('right_back'), 'Right');
    assert.equal(expectedHandSideForView('body_front'), null);
    assert.equal(expectedHandSideForView(undefined), null);
  });
});
