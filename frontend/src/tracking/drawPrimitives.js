/**
 * Draws the neutral drawing PRIMITIVES (viewer/renderMarkings.js — the same list the public page, the PDF and the
 * Studio's outline underlay are made from) onto a 2D canvas context.
 *
 * This is the camera's serializer for that shared list, next to the SVG and PDF ones: the geometry of a shape is
 * decided once, in renderMarkings, in the protocol canvas's REFERENCE pixels; this file only says how to put those
 * primitives on a <canvas>. The caller sets the context's transform first (reference px → camera canvas px), so
 * positions, sizes and stroke widths follow the hand with no per-primitive maths here.
 *
 * Supported kinds: group, circle, line, polyline, polygon, rect, path (M / Q segments), text. An unknown kind is
 * skipped, never thrown on — a malformed shape must not stop the camera.
 */
const alphaOf = (p, inherited) => inherited * (typeof p.opacity === 'number' ? p.opacity : 1);

function strokeStyleOf(ctx, p, alpha) {
  if (!p.stroke || p.stroke === 'none') return false;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = p.stroke;
  ctx.lineWidth = typeof p.strokeWidth === 'number' ? p.strokeWidth : 1;
  ctx.lineCap = p.cap || 'butt';
  ctx.lineJoin = p.join || 'miter';
  return true;
}
function fillStyleOf(ctx, p, alpha) {
  if (!p.fill || p.fill === 'none') return false;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = p.fill;
  return true;
}
function finish(ctx, p, alpha) {
  if (fillStyleOf(ctx, p, alpha)) ctx.fill();
  if (strokeStyleOf(ctx, p, alpha)) ctx.stroke();
}

export function drawPrimitive(ctx, p, inheritedAlpha = 1, options = {}) {
  if (!p || typeof p !== 'object') return;
  switch (p.kind) {
    case 'group': {
      ctx.save();
      const t = p.transform;
      if (t) {
        ctx.translate(t.tx || 0, t.ty || 0);
        if (typeof t.rot === 'number' && t.rot !== 0) ctx.rotate((t.rot * Math.PI) / 180);
      }
      const alpha = alphaOf(p, inheritedAlpha);
      (p.children || []).forEach((c) => drawPrimitive(ctx, c, alpha, options));
      ctx.restore();
      break;
    }
    case 'circle': {
      ctx.save();
      if (p.transform) ctx.translate(p.transform.tx || 0, p.transform.ty || 0);
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, Math.max(0, p.r), 0, Math.PI * 2);
      finish(ctx, p, alphaOf(p, inheritedAlpha));
      ctx.restore();
      break;
    }
    case 'line':
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y1);
      ctx.lineTo(p.x2, p.y2);
      strokeStyleOf(ctx, p, alphaOf(p, inheritedAlpha)) && ctx.stroke();
      break;
    case 'polyline':
    case 'polygon': {
      if (!Array.isArray(p.points) || !p.points.length) break;
      ctx.beginPath();
      p.points.forEach((q, i) => (i === 0 ? ctx.moveTo(q[0], q[1]) : ctx.lineTo(q[0], q[1])));
      if (p.kind === 'polygon') ctx.closePath();
      finish(ctx, p.kind === 'polyline' ? { ...p, fill: 'none' } : p, alphaOf(p, inheritedAlpha));
      break;
    }
    case 'rect':
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.width, p.height);
      finish(ctx, p, alphaOf(p, inheritedAlpha));
      break;
    case 'path': {
      if (!Array.isArray(p.segments) || !p.segments.length) break;
      ctx.beginPath();
      p.segments.forEach((s) => (s.op === 'M' ? ctx.moveTo(s.x, s.y) : ctx.quadraticCurveTo(s.cx, s.cy, s.x, s.y)));
      strokeStyleOf(ctx, p, alphaOf(p, inheritedAlpha)) && ctx.stroke();
      break;
    }
    case 'text': {
      if (!p.text || !(p.size > 0)) break;
      ctx.save();
      const t = p.transform;
      if (t) {
        ctx.translate(t.tx || 0, t.ty || 0);
        if (typeof t.rot === 'number' && t.rot !== 0) ctx.rotate((t.rot * Math.PI) / 180);
      }
      // The selfie camera's frame is mirrored with CSS (video and overlay together), which would also mirror the
      // letters. Flipping the glyphs back around their own anchor keeps text readable; its position is unchanged.
      if (options.mirrored) ctx.scale(-1, 1);
      ctx.globalAlpha = alphaOf(p, inheritedAlpha);
      ctx.fillStyle = p.fill;
      ctx.font = `bold ${p.size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
      break;
    }
    default:
      break;
  }
  ctx.globalAlpha = 1;
}

export function drawPrimitives(ctx, primitives, options = {}) {
  const alpha = typeof options.alpha === 'number' ? options.alpha : 1;
  (primitives || []).forEach((p) => drawPrimitive(ctx, p, alpha, options));
}
