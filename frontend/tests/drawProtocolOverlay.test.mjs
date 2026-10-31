/** [DETERMINISTIC SOFTWARE TESTS] overlay drawing calls (src/tracking/drawProtocolOverlay.js) against a recording fake canvas. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drawProtocolOverlay } from '../src/tracking/drawProtocolOverlay.js';
import { computeCoverMapping, videoPointToCanvas, videoLengthToCanvas } from '../src/tracking/videoCover.js';
import { assertClose } from './support/helpers.mjs';

/** A stand-in for CanvasRenderingContext2D that records every drawing operation and the style in effect at that moment. */
function fakeCtx() {
  const ops = [];
  const ctx = { globalAlpha: 1, fillStyle: null, strokeStyle: null, lineWidth: 1 };
  const snap = () => ({ globalAlpha: ctx.globalAlpha, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth });
  ['beginPath', 'fill', 'stroke'].forEach((op) => { ctx[op] = () => ops.push({ op, ...snap() }); });
  ctx.arc = (x, y, r) => ops.push({ op: 'arc', x, y, r });
  return { ctx, ops };
}

const VW = 1280; const VH = 720;
const cover = computeCoverMapping(VW, VH, 1466, 825);

describe('[DETERMINISTIC] protocol overlay drawing', () => {
  it('dot: a filled circle at the cover-mapped position in the doctor\'s colour and opacity, with a thin white outline', () => {
    const { ctx, ops } = fakeCtx();
    const dot = { type: 'dot', x: 0.4, y: 0.6, radius: 0.02, color: '#e5484d', opacity: 0.7 };
    drawProtocolOverlay(ctx, VW, VH, cover, [dot]);

    const center = videoPointToCanvas(0.4, 0.6, VW, VH, cover);
    const radius = videoLengthToCanvas(0.02, VW, cover);
    const arc = ops.find((o) => o.op === 'arc');
    assertClose(arc.x, center.x, 1e-9); assertClose(arc.y, center.y, 1e-9); assertClose(arc.r, radius, 1e-9);

    const fill = ops.find((o) => o.op === 'fill');
    assert.equal(fill.fillStyle, '#e5484d'); assert.equal(fill.globalAlpha, 0.7);
    const stroke = ops.find((o) => o.op === 'stroke');
    assert.equal(stroke.strokeStyle, 'rgba(255,255,255,0.9)');
    assert.equal(ctx.globalAlpha, 1, 'alpha must be reset so later drawing is unaffected');
  });

  it('ring: an UNFILLED circle stroked in the doctor\'s colour with the mapped stroke width', () => {
    const { ctx, ops } = fakeCtx();
    const ring = { type: 'ring', x: 0.5, y: 0.5, radius: 0.05, strokeWidth: 0.004, color: '#1a73e8', opacity: 0.9 };
    drawProtocolOverlay(ctx, VW, VH, cover, [ring]);

    assert.equal(ops.some((o) => o.op === 'fill'), false, 'a ring must not be filled');
    const arc = ops.find((o) => o.op === 'arc');
    assertClose(arc.r, videoLengthToCanvas(0.05, VW, cover), 1e-9);
    const stroke = ops.find((o) => o.op === 'stroke');
    assert.equal(stroke.strokeStyle, '#1a73e8'); assert.equal(stroke.globalAlpha, 0.9);
    assertClose(stroke.lineWidth, Math.max(1, videoLengthToCanvas(0.004, VW, cover)), 1e-9);
    assert.equal(ctx.globalAlpha, 1);
  });

  it('ring stroke never gets thinner than 1px, however small the hand is in frame', () => {
    const { ctx, ops } = fakeCtx();
    drawProtocolOverlay(ctx, VW, VH, cover, [{ type: 'ring', x: 0.5, y: 0.5, radius: 0.01, strokeWidth: 0.00001, color: '#000', opacity: 1 }]);
    assert.equal(ops.find((o) => o.op === 'stroke').lineWidth, 1);
  });

  it('missing opacity defaults to fully opaque', () => {
    const { ctx, ops } = fakeCtx();
    drawProtocolOverlay(ctx, VW, VH, cover, [{ type: 'dot', x: 0.5, y: 0.5, radius: 0.01, color: '#000' }]);
    assert.equal(ops.find((o) => o.op === 'fill').globalAlpha, 1);
  });

  it("Dot + Ring: the ring is drawn UNFILLED in its own colour, behind the filled dot, both sharing the composite's opacity", () => {
    const { ctx, ops } = fakeCtx();
    const dotRing = {
      type: 'dot', x: 0.4, y: 0.6, radius: 0.02, color: '#e5484d', opacity: 0.6,
      ring: { radius: 0.05, strokeWidth: 0.004, color: '#1a73e8' },
    };
    drawProtocolOverlay(ctx, VW, VH, cover, [dotRing]);

    const arcs = ops.filter((o) => o.op === 'arc');
    assert.equal(arcs.length, 2, 'one arc for the ring, one for the dot');
    assertClose(arcs[0].r, videoLengthToCanvas(0.05, VW, cover), 1e-9, 'the ring is drawn FIRST, so the dot ends up on top');
    assertClose(arcs[1].r, videoLengthToCanvas(0.02, VW, cover), 1e-9);

    const strokes = ops.filter((o) => o.op === 'stroke');
    const ringStroke = strokes[0]; // the ring's own stroke, before the dot's white outline stroke
    assert.equal(ringStroke.strokeStyle, '#1a73e8');
    assert.equal(ringStroke.globalAlpha, 0.6, "the ring uses the composite's one shared opacity");
    assertClose(ringStroke.lineWidth, videoLengthToCanvas(0.004, VW, cover), 1e-9);

    const fill = ops.find((o) => o.op === 'fill');
    assert.equal(fill.fillStyle, '#e5484d');
    assert.equal(fill.globalAlpha, 0.6);
    assert.equal(ops.filter((o) => o.op === 'fill').length, 1, 'only the dot is filled — the ring never is');
    assert.equal(ctx.globalAlpha, 1, 'alpha is reset after drawing');
  });

  it('a plain dot (no ring field) draws exactly as before: one arc, one fill, one stroke', () => {
    const { ctx, ops } = fakeCtx();
    drawProtocolOverlay(ctx, VW, VH, cover, [{ type: 'dot', x: 0.4, y: 0.6, radius: 0.02, color: '#e5484d', opacity: 0.7 }]);
    assert.equal(ops.filter((o) => o.op === 'arc').length, 1);
    assert.equal(ops.filter((o) => o.op === 'fill').length, 1);
    assert.equal(ops.filter((o) => o.op === 'stroke').length, 1, 'no ring stroke when there is no ring');
  });

  it('unsupported types draw nothing; a mixed list draws each supported one', () => {
    const a = fakeCtx();
    drawProtocolOverlay(a.ctx, VW, VH, cover, [{ type: 'triangle', x: 0.5, y: 0.5 }, { type: 'arrow', x: 0.5, y: 0.5 }]);
    assert.deepEqual(a.ops, []);
    const b = fakeCtx();
    drawProtocolOverlay(b.ctx, VW, VH, cover, [
      { type: 'dot', x: 0.2, y: 0.2, radius: 0.01, color: '#000', opacity: 1 },
      { type: 'ring', x: 0.6, y: 0.6, radius: 0.03, strokeWidth: 0.003, color: '#111', opacity: 1 },
    ]);
    assert.equal(b.ops.filter((o) => o.op === 'arc').length, 2);
  });
});
