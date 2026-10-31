/** [DETERMINISTIC SOFTWARE TESTS] similarity transform (src/tracking/similarityTransform.js) — pure math, real module. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSimilarityTransform, applyTransform, transformScale, transformRotation, transformTranslation,
} from '../src/tracking/similarityTransform.js';
import { assertClose, rst, refPixelsFor, VIEW_KEYS } from './support/helpers.mjs';

const REF = refPixelsFor('left_front');
const fit = (s, theta, tx, ty) => computeSimilarityTransform(REF, REF.map((p) => rst(p, s, theta, tx, ty)));

describe('[DETERMINISTIC] similarity transform', () => {
  it('identity: same points in and out -> every point maps to itself, scale 1, rotation 0', () => {
    const t = computeSimilarityTransform(REF, REF);
    assertClose(transformScale(t), 1, 1e-9, 'scale');
    assertClose(transformRotation(t), 0, 1e-9, 'rotation');
    for (const p of [{ x: 0, y: 0 }, { x: 700, y: 900 }, { x: 1586, y: 1982 }]) {
      const q = applyTransform(t, p);
      assertClose(q.x, p.x, 1e-6, 'x'); assertClose(q.y, p.y, 1e-6, 'y');
    }
  });

  it('recovers a pure translation', () => {
    const t = fit(1, 0, 300, -120);
    const q = applyTransform(t, { x: 100, y: 100 });
    assertClose(q.x, 400, 1e-6); assertClose(q.y, -20, 1e-6);
    const tr = transformTranslation(t);
    const origin = rst({ x: 0, y: 0 }, 1, 0, 300, -120);
    assertClose(tr.x, origin.x, 1e-6); assertClose(tr.y, origin.y, 1e-6);
  });

  it('recovers a uniform scale (both zoom in and out)', () => {
    for (const s of [0.1, 0.245, 1, 2.4]) assertClose(transformScale(fit(s, 0, 50, 60)), s, 1e-9, `scale ${s}`);
  });

  it('recovers rotation, including negative angles and 90 degrees', () => {
    for (const deg of [-45, -10, 0, 15, 90, 170]) {
      const theta = (deg * Math.PI) / 180;
      assertClose(transformRotation(fit(1.3, theta, 10, 20)), theta, 1e-9, `${deg} deg`);
    }
  });

  it('recovers scale + rotation + translation together and maps a HELD-OUT point (not used in the fit) exactly', () => {
    const s = 1.9; const theta = -0.45; const tx = 520; const ty = 140;
    const t = fit(s, theta, tx, ty);
    const heldOut = { x: 811.5, y: 1203.25 };
    const want = rst(heldOut, s, theta, tx, ty);
    const got = applyTransform(t, heldOut);
    assertClose(got.x, want.x, 1e-6, 'x'); assertClose(got.y, want.y, 1e-6, 'y');
    assertClose(transformScale(t), s, 1e-9); assertClose(transformRotation(t), theta, 1e-9);
  });

  it('is a true similarity: distances between mapped points all scale by exactly the same factor (no shear/stretch)', () => {
    const t = fit(0.7, 0.3, 40, 50);
    const pts = [{ x: 0, y: 0 }, { x: 500, y: 100 }, { x: 900, y: 1400 }, { x: 200, y: 1900 }];
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        assertClose(dist(applyTransform(t, pts[i]), applyTransform(t, pts[j])) / dist(pts[i], pts[j]), 0.7, 1e-9);
      }
    }
  });

  it('works for every one of the four hand views', () => {
    for (const view of VIEW_KEYS) {
      const ref = refPixelsFor(view);
      const t = computeSimilarityTransform(ref, ref.map((p) => rst(p, 1.6, 0.5, 200, 100)));
      assertClose(transformScale(t), 1.6, 1e-9, view); assertClose(transformRotation(t), 0.5, 1e-9, view);
    }
  });

  it('degrades gracefully with small measurement noise (least squares, not exact interpolation)', () => {
    const noise = [[0.6, -0.4], [-0.5, 0.5], [0.3, 0.7], [-0.7, -0.2], [0.4, -0.6], [-0.2, 0.3]]; // fixed, ±<1px
    const live = REF.map((p, i) => { const q = rst(p, 0.3, 0.2, 100, 100); return { x: q.x + noise[i][0], y: q.y + noise[i][1] }; });
    const t = computeSimilarityTransform(REF, live);
    assertClose(transformScale(t), 0.3, 0.003, 'scale stays within 1%');
    assertClose(transformRotation(t), 0.2, 0.01, 'rotation stays within ~0.5 degree');
  });

  it('returns null (not garbage) for unusable input', () => {
    assert.equal(computeSimilarityTransform(null, REF), null);
    assert.equal(computeSimilarityTransform(REF, null), null);
    assert.equal(computeSimilarityTransform([{ x: 1, y: 1 }], [{ x: 2, y: 2 }]), null, 'needs at least 2 points');
    assert.equal(computeSimilarityTransform(REF, REF.slice(0, 5)), null, 'length mismatch');
    assert.equal(computeSimilarityTransform([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }], REF.slice(0, 3)), null, 'coincident reference points');
  });
});
