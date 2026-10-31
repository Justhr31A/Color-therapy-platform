/**
 * [DETERMINISTIC SOFTWARE TESTS] temporal tracking, calibration and the real-camera validation scoring — driven by
 * synthetic, timestamped landmark sequences. No camera, no MediaPipe.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHandTracker, boneRatios, regionReliability } from '../src/tracking/handTracker.js';
import { assessCalibrationFrame, createCalibrator, calibrationMessage, CALIBRATION_MESSAGES } from '../src/tracking/calibration.js';
import { prepareArView, computeArFrame } from '../src/tracking/arFrame.js';
import { getReferenceLandmarks } from '../src/tracking/referenceLandmarks.js';
import { createValidationSession, analyzeValidation, nearestMarking, VALIDATION_FORMAT } from '../src/tracking/arValidation.js';
import { summarizeErrors, checkThresholds, jitterRms, quantile } from '../src/tracking/arMetrics.js';
import { assertClose } from './support/helpers.mjs';

const VIDEO = { width: 1280, height: 720 };
const W = 1586; const H = 1982;
/** The left_front reference skeleton placed in the video at `scale`, offset (dx, dy) — video px. */
const hand = (scale = 0.3, dx = 0, dy = 0) => getReferenceLandmarks('left_front').map((p) => ({ x: 400 + p.x * W * scale + dx, y: 60 + p.y * H * scale + dy }));
const norm = (px, z = () => 0) => px.map((p, i) => ({ x: p.x / VIDEO.width, y: p.y / VIDEO.height, z: z(i) }));
const step = (tr, t, lm, extra = {}) => tr.update({ landmarks: lm, score: 0.95, timestampMs: t, usable: Boolean(lm), ...extra });

describe('[DETERMINISTIC] hand tracker state machine', () => {
  it('acquires after N consecutive good frames, then fades in', () => {
    const tr = createHandTracker({ acquireFrames: 3, fadeInMs: 100, predictMs: 0 });
    assert.equal(step(tr, 0, hand()).alpha, 0);
    assert.equal(step(tr, 33, hand()).state, 'acquiring');
    const third = step(tr, 66, hand());
    assert.equal(third.state, 'tracking');
    assert.ok(third.alpha > 0 && third.alpha < 1);
    assert.equal(step(tr, 200, hand()).alpha, 1);
  });

  it('a short dropout is HELD with a fading overlay, then hidden once holdMs has passed (never left showing)', () => {
    const tr = createHandTracker({ holdMs: 150, predictMs: 0 });
    for (let i = 0; i < 6; i += 1) step(tr, i * 33, hand());
    const h1 = step(tr, 200, null);
    assert.equal(h1.state, 'holding'); assert.ok(h1.landmarks); assert.ok(h1.alpha > 0.9);
    const h2 = step(tr, 300, null);
    assert.ok(h2.alpha < h1.alpha && h2.alpha > 0);
    const gone = step(tr, 400, null);
    assert.equal(gone.state, 'lost'); assert.equal(gone.landmarks, null); assert.equal(gone.alpha, 0);
  });

  it('wrong hand / two hands hide IMMEDIATELY (no hold) and reset', () => {
    const tr = createHandTracker({ predictMs: 0 });
    for (let i = 0; i < 6; i += 1) step(tr, i * 33, hand());
    const r = tr.update({ landmarks: null, timestampMs: 220, usable: false, hideNow: true });
    assert.equal(r.alpha, 0); assert.equal(r.landmarks, null); assert.equal(tr.state, 'searching');
  });

  it('re-entry near the last pose continues smoothly; re-entry far away re-acquires from scratch (no dragging across)', () => {
    const near = createHandTracker({ holdMs: 300, predictMs: 0 });
    for (let i = 0; i < 6; i += 1) step(near, i * 33, hand());
    step(near, 200, null);
    const back = step(near, 260, hand(0.3, 5, 0));
    assert.equal(back.state, 'tracking'); assert.ok(back.alpha > 0.5);

    const far = createHandTracker({ holdMs: 300, predictMs: 0 });
    for (let i = 0; i < 6; i += 1) step(far, i * 33, hand());
    step(far, 200, null);
    const moved = step(far, 260, hand(0.3, 400, 0));
    assert.equal(moved.state, 'acquiring'); assert.equal(moved.landmarks, null);
    step(far, 293, hand(0.3, 400, 0));
    const shown = step(far, 326, hand(0.3, 400, 0));
    assert.equal(shown.state, 'tracking');
    assertClose(shown.landmarks[9].x, hand(0.3, 400, 0)[9].x, 1e-6, 'first shown frame sits on the new hand, not between');
  });

  it('a single landmark outlier is replaced by its prediction; a frame with many outliers is treated as a dropout', () => {
    const tr = createHandTracker({ predictMs: 0 });
    for (let i = 0; i < 10; i += 1) step(tr, i * 33, hand());
    const bad = hand(); bad[8] = { x: bad[8].x + 300, y: bad[8].y - 200 };
    const r = step(tr, 330, bad);
    assertClose(r.landmarks[8].x, hand()[8].x, 2); // stayed put
    assert.equal(r.stats.outliersReplaced, 1);
    const chaos = hand().map((p, i) => (i % 3 === 0 ? { x: p.x + 400, y: p.y } : p));
    const r2 = step(tr, 363, chaos);
    assert.equal(r2.state, 'holding');
    assert.equal(r2.stats.framesRejected, 1);
  });

  it('smoothing: a still, noisy hand is steadier after the tracker; low detection confidence smooths harder', () => {
    let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const run = (score) => {
      const tr = createHandTracker({ predictMs: 0 });
      const out = [];
      for (let i = 0; i < 90; i += 1) {
        const lm = hand().map((p) => ({ x: p.x + rnd() * 6, y: p.y + rnd() * 6 }));
        const r = tr.update({ landmarks: lm, score, timestampMs: i * 33, usable: true });
        if (i > 15 && r.landmarks) out.push(r.landmarks[12]);
      }
      return jitterRms(out);
    };
    const hi = run(0.95); const lo = run(0.55);
    assert.ok(hi < 1.6, `tracked jitter ${hi}px for ±3px noise`);
    assert.ok(lo < hi, 'lower confidence → stronger smoothing');
  });

  it('works on real, uneven frame timestamps (15–60 fps mix) without jumping', () => {
    const tr = createHandTracker({ predictMs: 0 });
    let t = 0; let last = null;
    for (let i = 0; i < 60; i += 1) {
      t += [16, 33, 66, 20][i % 4];
      const r = step(tr, t, hand(0.3, i * 2, 0));
      if (r.landmarks && last) assert.ok(Math.abs(r.landmarks[0].x - last.x) < 15);
      if (r.landmarks) last = r.landmarks[0];
    }
  });

  it('reliability: a finger whose length no longer matches the calibrated baseline (curled / foreshortened) fades', () => {
    const base = boneRatios(hand());
    const curled = hand();
    // index finger collapsed to 40 % length (bent towards the camera)
    for (const i of [6, 7, 8]) curled[i] = { x: curled[5].x + (curled[i].x - curled[5].x) * 0.4, y: curled[5].y + (curled[i].y - curled[5].y) * 0.4 };
    const rel = regionReliability(boneRatios(curled), base);
    assert.equal(rel['index.proximal'], 0); assert.equal(rel['index.distal'], 0);
    assert.equal(rel['middle.middle'], 1); assert.equal(rel.palm, 1);
    const none = regionReliability(boneRatios(curled), null);
    assert.ok(Object.values(none).every((v) => v === 1), 'without a baseline nothing is faded');
  });
});

describe('[DETERMINISTIC] guided calibration', () => {
  const flat = () => norm(hand());
  it('a flat, open, well-framed, confident hand passes', () => {
    const a = assessCalibrationFrame({ landmarks: flat(), score: 0.95, video: VIDEO });
    assert.deepEqual(a.reasons, []); assert.equal(a.ok, true);
  });
  it('each problem is reported with an actionable message', () => {
    const cases = [
      ['out-of-frame', norm(hand(0.3, 700, 0))],
      ['too-small', norm(hand(0.05))],
      ['too-close', norm(hand(0.6, -350, -50))],
      ['tilted', norm(hand(), (i) => (i === 5 ? 0.2 : i === 17 ? -0.2 : 0))],
    ];
    for (const [code, lm] of cases) {
      const a = assessCalibrationFrame({ landmarks: lm, score: 0.95, video: VIDEO });
      assert.ok(a.reasons.includes(code), `${code}: got ${a.reasons}`);
      assert.ok(CALIBRATION_MESSAGES[code]);
    }
    assert.ok(assessCalibrationFrame({ landmarks: flat(), score: 0.5, video: VIDEO }).reasons.includes('low-confidence'));
    const bent = hand(); bent[8] = { x: bent[6].x + 40, y: bent[6].y + 30 }; bent[7] = { x: bent[6].x + 30, y: bent[6].y - 10 };
    assert.ok(assessCalibrationFrame({ landmarks: norm(bent), score: 0.95, video: VIDEO }).reasons.includes('fingers-bent'));
    assert.deepEqual(assessCalibrationFrame({ landmarks: null, score: 0, video: VIDEO }).reasons, ['no-hand']);
    assert.equal(calibrationMessage(['low-confidence', 'out-of-frame']), CALIBRATION_MESSAGES['out-of-frame'], 'most actionable first');
  });
  it('completes after the hand is held steady for steadyMs; movement restarts it; the baseline is the hand\'s proportions', () => {
    const c = createCalibrator({ steadyMs: 300 });
    assert.equal(c.update({ landmarks: flat(), score: 0.95, video: VIDEO, timestampMs: 0 }).status, 'collecting');
    const moved = c.update({ landmarks: norm(hand(0.3, 120, 0)), score: 0.95, video: VIDEO, timestampMs: 33 });
    assert.deepEqual(moved.reasons, ['moving']);
    let r;
    for (let t = 66; t <= 500; t += 33) r = c.update({ landmarks: norm(hand(0.3, 120, 0)), score: 0.95, video: VIDEO, timestampMs: t });
    assert.equal(r.status, 'done'); assert.equal(c.done, true);
    assertClose(r.baseline.ratios['index.proximal'], boneRatios(hand())['index.proximal'], 1e-9);
    c.reset(); assert.equal(c.done, false);
  });
  it('in the camera frame: nothing is drawn until calibration is done, then markings appear and the tracker gets the baseline', () => {
    const canvas = { viewKey: 'left_front', canvasType: 'hand', width: W, height: H, objects: [{ id: 'd', type: 'dot', x: 0.55, y: 0.6, width: 0.03, color: '#00f', opacity: 1, zIndex: 1 }] };
    const view = prepareArView(canvas);
    const tracker = createHandTracker({ predictMs: 0 });
    const calibrator = createCalibrator({ steadyMs: 200 });
    const result = { landmarks: [flat()], handedness: [[{ categoryName: 'Left', score: 0.95 }]] };
    const frames = [];
    for (let t = 0; t <= 400; t += 33) frames.push(computeArFrame({ result, view, video: VIDEO, tracker, calibrator, timestampMs: t }));
    assert.equal(frames[0].calibration, 'calibrating'); assert.deepEqual(frames[0].mapped, []);
    const firstDrawn = frames.findIndex((f) => f.mapped.length > 0);
    assert.ok(firstDrawn > 0 && frames[firstDrawn].calibration === 'ok');
    assert.ok(tracker.getBaseline(), 'baseline handed to the tracker');
  });
});

describe('[DETERMINISTIC] metrics and real-camera validation scoring', () => {
  it('summaries and thresholds', () => {
    const s = summarizeErrors([0.01, 0.02, 0.03, 0.2], 0.1);
    assert.equal(s.n, 4); assertClose(s.median, 0.025, 1e-12); assertClose(s.withinRate, 0.75, 1e-12);
    assert.equal(checkThresholds(s, { median: 0.03, p95: 0.5, within: 0.1, withinRate: 0.7 }).pass, true);
    assert.equal(checkThresholds(s, { median: 0.01 }).pass, false);
    assert.equal(quantile([], 0.5) !== quantile([], 0.5), true); // NaN for no data
  });
  it('labels → errors in palm widths; recordings → fps, losses, reacquisition, still jitter; checked against the real thresholds', () => {
    const s = createValidationSession({ protocol: 'Back Pain', viewKey: 'left_front', tags: { lighting: 'indoor' } });
    s.setTag('lighting', 'dim');
    assert.equal(s.addLabel({ markingId: 'a', predicted: { x: 100, y: 100 }, truth: { x: 103, y: 104 }, palmWidthPx: 100 }), true); // 0.05
    assert.equal(s.addLabel({ markingId: 'b', predicted: { x: 0, y: 0 }, truth: { x: 2, y: 0 }, palmWidthPx: 100 }), true); // 0.02
    assert.equal(s.addLabel({ markingId: 'c', predicted: null, truth: { x: 0, y: 0 }, palmWidthPx: 100 }), false);
    s.startRecording('still');
    for (let i = 0; i < 60; i += 1) s.recordFrame({ t: i * 33.3, detectMs: 12, palmWidthPx: 100, markings: [{ id: 'a', x: 100 + (i % 2) * 0.4, y: 100 }] });
    s.stopRecording();
    s.startRecording('movement');
    for (let i = 0; i < 60; i += 1) s.recordFrame({ t: 3000 + i * 33.3, detectMs: 14, palmWidthPx: 100, markings: i >= 20 && i < 26 ? [] : [{ id: 'a', x: 100, y: 100 }] });
    s.stopRecording();
    const data = s.toJSON();
    assert.equal(data.format, VALIDATION_FORMAT); assert.equal(data.tags.lighting, 'dim');
    assert.equal(JSON.stringify(data).includes('data:image'), false, 'no image data in an export');
    const r = analyzeValidation(data);
    assertClose(r.alignment.median, 0.035, 1e-9);
    assert.equal(r.alignment.n, 2);
    assertClose(r.fps, 30.03, 0.01);
    assertClose(r.reacquireMs, 6 * 33.3, 0.01);
    assert.ok(r.stationaryJitter < 0.01);
    assert.equal(r.checks.alignment.pass, true);
    assert.equal(r.checks.fps, true);
    assert.ok(Object.keys(r.byView)[0].includes('left_front'));
  });
  it('the report tool scores an export file and exits non-zero on failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arval-'));
    const good = createValidationSession({ viewKey: 'left_front' });
    for (let i = 0; i < 20; i += 1) good.addLabel({ markingId: `m${i}`, predicted: { x: 0, y: 0 }, truth: { x: 2, y: 0 }, palmWidthPx: 100 });
    const bad = createValidationSession({ viewKey: 'left_front' });
    for (let i = 0; i < 20; i += 1) bad.addLabel({ markingId: `m${i}`, predicted: { x: 0, y: 0 }, truth: { x: 40, y: 0 }, palmWidthPx: 100 });
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(good.toJSON()));
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify(bad.toJSON()));
    const tool = new URL('../tools/ar/validation-report.mjs', import.meta.url).pathname;
    const hook = new URL('./support/register.mjs', import.meta.url).pathname;
    const out = execFileSync(process.execPath, ['--import', hook, tool, path.join(dir, 'good.json')], { encoding: 'utf8' });
    assert.match(out, /alignment \.+ PASS/);
    let failed = false;
    try { execFileSync(process.execPath, ['--import', hook, tool, path.join(dir, 'bad.json')], { encoding: 'utf8' }); } catch (e) { failed = e.status === 1 && /FAIL/.test(e.stdout); }
    assert.equal(failed, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('labelling picks the nearest drawn marking within reach only', () => {
    const ms = [{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 50, y: 50 }, { id: 'shape', x: NaN, y: NaN }];
    assert.equal(nearestMarking(ms, { x: 48, y: 47 }, 10).id, 'b');
    assert.equal(nearestMarking(ms, { x: 200, y: 200 }, 10), null);
  });
});
