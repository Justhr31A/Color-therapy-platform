/**
 * [DETERMINISTIC SOFTWARE TESTS — SYNTHETIC ACCURACY] the acceptance gate for the hand-AR geometry and tracking logic.
 *
 * Generated 3D hands (own proportions, finger flexion, spread, tilt, real perspective, landmark noise) with EXACT
 * ground truth (tools/ar/syntheticHand.mjs) run through the production code path. Thresholds were fixed before
 * evaluation in src/tracking/arAcceptance.js.
 *
 * This is NOT real-world accuracy: it assumes the reference skeleton matches the drawings and that MediaPipe behaves
 * like "true landmarks + noise". Real accuracy must be measured on real recordings (docs/HAND_AR_ACCURACY.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAccuracy, runTemporal } from '../tools/ar/benchmark.mjs';
import { ACCEPTANCE } from '../src/tracking/arAcceptance.js';

describe('[SYNTHETIC] alignment accuracy (palm widths)', () => {
  const acc = runAccuracy({ conditions: ['flat', 'natural'], posesPerView: 12, seed: 19 });

  for (const condition of ['flat', 'natural']) {
    it(`skeleton mapping meets the ${condition} thresholds in every view`, () => {
      const r = acc[condition].skeleton;
      assert.equal(r.acceptance.pass, true, r.acceptance.fails.join('; '));
      for (const [view, s] of Object.entries(r.byView)) {
        assert.ok(s.p95 <= ACCEPTANCE.synthetic[condition].p95, `${view} p95 ${s.p95}`);
      }
    });
  }

  it('documents the bug that was fixed: the previous design (OLD 6-point table, one similarity) fails badly', () => {
    const legacy = acc.natural['legacy-similarity'].all;
    assert.ok(legacy.median > 0.1, `legacy median ${legacy.median}`);
    assert.ok(acc.natural.skeleton.all.median < legacy.median / 10);
  });

  it('per region: fingers and thumb are as accurate as the palm (fingers are tracked on their own)', () => {
    const r = acc.natural.skeleton;
    for (const part of ['palm', 'fingers', 'thumb']) assert.ok(r[part].p95 <= ACCEPTANCE.synthetic.natural.p95, `${part} p95 ${r[part].p95}`);
    assert.ok(r.fingers.median < acc.natural.similarity.fingers.median / 3, 'per-bone mapping beats one whole-hand fit on fingers');
  });
});

describe('[SYNTHETIC] temporal stability', () => {
  for (const view of ['left_front', 'right_back']) {
    it(`${view}: stationary jitter, shake, rapid motion, dropout re-entry all meet the thresholds`, () => {
      const t = runTemporal({ view, seed: 29 });
      for (const [k, ok] of Object.entries(t.acceptance)) assert.equal(ok, true, `${k}: ${JSON.stringify({ jitter: t.stationaryJitter_tracked, shake: t.shake.p95, rapid: t.rapid.mean, reacq: t.reacquireMs, err: t.reacquireError })}`);
      assert.ok(t.stationaryJitter_tracked < t.stationaryJitter_raw, 'the filter reduces jitter');
      assert.ok(t.outliers_withRejection.p95 <= t.outliers_withoutRejection.p95, 'outlier rejection never makes things worse');
      assert.ok(t.hideAfterLossMs <= 200, 'a lost hand stops showing markings within 0.2 s');
    });
  }
});
