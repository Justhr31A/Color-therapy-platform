/** [DETERMINISTIC SOFTWARE TESTS] reference hand calibration tables — internal consistency checks only. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_HAND_POINTS, CALIBRATION_POINT_ORDER, CALIBRATION_LANDMARK_INDEXES, getReferencePointsForView,
} from '../src/tracking/referenceHandPoints.js';
import { assertClose, VIEW_KEYS } from './support/helpers.mjs';

describe('[DETERMINISTIC] reference hand points (structure & consistency)', () => {
  it('there is exactly one table per hand view the backend defines', () => {
    assert.deepEqual(Object.keys(REFERENCE_HAND_POINTS).sort(), [...VIEW_KEYS].sort());
  });
  it('calibration order and MediaPipe landmark indexes line up: wrist, thumb MCP, index MCP, middle MCP, ring MCP, pinky MCP = 0,2,5,9,13,17', () => {
    assert.deepEqual(CALIBRATION_POINT_ORDER, ['wrist', 'thumbMCP', 'indexMCP', 'middleMCP', 'ringMCP', 'pinkyMCP']);
    assert.deepEqual(CALIBRATION_LANDMARK_INDEXES, [0, 2, 5, 9, 13, 17]);
    assert.equal(CALIBRATION_POINT_ORDER.length, CALIBRATION_LANDMARK_INDEXES.length);
  });
  it('every view provides all 6 points as normalized coordinates strictly inside the image', () => {
    for (const view of VIEW_KEYS) {
      for (const name of CALIBRATION_POINT_ORDER) {
        const p = REFERENCE_HAND_POINTS[view][name];
        assert.ok(p && p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1, `${view}.${name} missing or out of range`);
      }
    }
  });
  it('getReferencePointsForView returns the points in calibration order, and null for an unknown view', () => {
    for (const view of VIEW_KEYS) {
      assert.deepEqual(getReferencePointsForView(view), CALIBRATION_POINT_ORDER.map((n) => REFERENCE_HAND_POINTS[view][n]));
    }
    assert.equal(getReferencePointsForView('nonsense'), null);
  });
  it('anatomical sanity: in every view the wrist is the lowest point and all five knuckles sit above it', () => {
    for (const view of VIEW_KEYS) {
      const t = REFERENCE_HAND_POINTS[view];
      for (const name of CALIBRATION_POINT_ORDER.slice(1)) assert.ok(t[name].y < t.wrist.y, `${view}.${name} is not above the wrist`);
    }
  });
  it('mirror symmetry: left_front and right_front are mirror images of each other (x -> 1 - x within 0.02)', () => {
    for (const name of CALIBRATION_POINT_ORDER) {
      const l = REFERENCE_HAND_POINTS.left_front[name]; const r = REFERENCE_HAND_POINTS.right_front[name];
      assertClose(l.x + r.x, 1, 0.02, `${name} x`); assertClose(l.y, r.y, 0.03, `${name} y`);
    }
  });
});
