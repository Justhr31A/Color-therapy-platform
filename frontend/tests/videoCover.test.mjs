/** [DETERMINISTIC SOFTWARE TESTS] object-fit:cover mapping (src/tracking/videoCover.js) — real module. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCoverMapping, videoPointToCanvas, videoLengthToCanvas } from '../src/tracking/videoCover.js';
import { assertClose } from './support/helpers.mjs';

describe('[DETERMINISTIC] video cover mapping', () => {
  it('reproduces the numbers read off the REAL device debug panel (1280x720 video in a 1466x825 canvas)', () => {
    // Real-device readout: "Cover scale: 1.1458 · Cover offset: x=-0.3, y=0.0"
    const m = computeCoverMapping(1280, 720, 1466, 825);
    assertClose(m.scale, 1.1458, 0.00005, 'scale');
    assertClose(m.offsetX, -0.3, 0.05, 'offsetX');
    assert.equal(m.offsetY, 0);
  });

  it('a container with the video\'s exact aspect ratio needs no cropping', () => {
    const m = computeCoverMapping(1280, 720, 640, 360);
    assertClose(m.scale, 0.5, 1e-12); assertClose(m.offsetX, 0, 1e-9); assertClose(m.offsetY, 0, 1e-9);
  });

  it('a tall (phone-portrait) container crops the sides equally and scales to the container height', () => {
    const m = computeCoverMapping(1280, 720, 400, 700);
    assertClose(m.scale, 700 / 720, 1e-12);
    assert.ok(m.offsetX < 0, 'sides are cropped');
    assertClose(m.offsetY, 0, 1e-9);
    assertClose(m.offsetX, (400 - 1280 * m.scale) / 2, 1e-9);
  });

  it('cover invariant: the scaled video always fully covers the container', () => {
    for (const [cw, ch] of [[1466, 825], [400, 700], [1920, 1080], [300, 300], [1000, 200]]) {
      const m = computeCoverMapping(1280, 720, cw, ch);
      assert.ok(1280 * m.scale >= cw - 1e-9 && 720 * m.scale >= ch - 1e-9, `${cw}x${ch} not covered`);
      assert.ok(m.offsetX <= 1e-9 && m.offsetY <= 1e-9, 'offsets are never positive (that would leave a gap)');
    }
  });

  it('maps normalized video points: corners, centre, and the centre stays at the container centre', () => {
    const m = computeCoverMapping(1280, 720, 400, 700);
    const tl = videoPointToCanvas(0, 0, 1280, 720, m);
    assertClose(tl.x, m.offsetX, 1e-9); assertClose(tl.y, m.offsetY, 1e-9);
    const br = videoPointToCanvas(1, 1, 1280, 720, m);
    assertClose(br.x, m.offsetX + 1280 * m.scale, 1e-9); assertClose(br.y, m.offsetY + 720 * m.scale, 1e-9);
    const c = videoPointToCanvas(0.5, 0.5, 1280, 720, m);
    assertClose(c.x, 200, 1e-9); assertClose(c.y, 350, 1e-9);
  });

  it('maps lengths by the same scale (a radius of 10% of the video width)', () => {
    const m = computeCoverMapping(1280, 720, 1466, 825);
    assertClose(videoLengthToCanvas(0.1, 1280, m), 0.1 * 1280 * m.scale, 1e-9);
  });

  it('falls back to an identity mapping when any dimension is zero/missing (before the video has loaded)', () => {
    for (const args of [[0, 720, 400, 700], [1280, 0, 400, 700], [1280, 720, 0, 700], [1280, 720, 400, 0], [undefined, undefined, undefined, undefined]]) {
      assert.deepEqual(computeCoverMapping(...args), { scale: 1, offsetX: 0, offsetY: 0 });
    }
  });
});
