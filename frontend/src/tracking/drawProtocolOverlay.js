import { videoPointToCanvas, videoLengthToCanvas } from './videoCover';
import { drawPrimitives } from './drawPrimitives';

/**
 * Renders the AR-mapped protocol objects (from protocolMapper.js) onto the
 * camera overlay canvas. `mappedObjects`' x/y/radius are normalized to
 * VIDEO-FRAME space (the same space MediaPipe's landmarks live in); this
 * function converts them into the canvas's pixel buffer via `coverMapping`
 * so they land in the exact same visible spot as the video content beneath
 * them (see videoCover.js for why that conversion is necessary).
 *
 * Deliberately separate from drawHandLandmarks.js's debug skeleton — this
 * is meant to become the actual patient-facing output eventually, drawn in
 * the doctor's real chosen colors, whereas the skeleton is fixed-color
 * dev/debug scaffolding (Step 6G).
 */
/** An unfilled circle — a standalone 'ring' object and a Dot + Ring's ring are drawn with this exact same code,
 * so there is only one place that says what "a ring" looks like in the camera view. */
function drawRingCircle(ctx, videoWidth, videoHeight, coverMapping, center, radiusNorm, strokeWidthNorm, color, opacity, outline = null) {
  const radiusPx = videoLengthToCanvas(radiusNorm, videoWidth, coverMapping);
  const strokePx = videoLengthToCanvas(strokeWidthNorm, videoWidth, coverMapping);
  if (outline) {
    // Outline underlay: the same circle stroked `2 × outline.thickness` wider in the outline colour, underneath —
    // the exact rule the website and PDF use (renderMarkings `underlay`).
    const outlinePx = videoLengthToCanvas(outline.thickness, videoWidth, coverMapping);
    ctx.globalAlpha = opacity ?? 1;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, strokePx + 2 * outlinePx);
    ctx.strokeStyle = outline.color;
    ctx.stroke();
  }
  ctx.globalAlpha = opacity ?? 1;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, strokePx);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * `options.mirrored`: true when the frame is shown mirrored (selfie camera) — only text needs to know (see drawPrimitives).
 */
export function drawProtocolOverlay(ctx, videoWidth, videoHeight, coverMapping, mappedObjects, options = {}) {
  (mappedObjects || []).forEach((mappedObj) => {
    // `visibility` (0..1) = tracking fade × the region's reliability (arFrame.js). It scales the doctor's own opacity, so
    // a marking on an unreliably tracked finger fades rather than sitting in a falsely precise place.
    const vis = typeof mappedObj.visibility === 'number' ? Math.max(0, Math.min(1, mappedObj.visibility)) : 1;
    if (vis <= 0) return;
    const obj = vis === 1 ? mappedObj : { ...mappedObj, opacity: (mappedObj.opacity ?? 1) * vis };
    if (obj.type === 'dot') {
      const center = videoPointToCanvas(obj.x, obj.y, videoWidth, videoHeight, coverMapping);
      const radiusPx = videoLengthToCanvas(obj.radius, videoWidth, coverMapping);

      // A Dot + Ring's ring is drawn FIRST, so the dot itself is always drawn on top of it, exactly as
      // Protocol Studio layers them (DotRingShape.jsx draws the ring, then the dot, inside one Group). The
      // ring's opacity matches the dot's — Dot + Ring has one opacity for the whole composite, not two.
      if (obj.ring) {
        drawRingCircle(ctx, videoWidth, videoHeight, coverMapping, center, obj.ring.radius, obj.ring.strokeWidth, obj.ring.color, obj.opacity);
      }
      // Multi-ring (`rings`, innermost first): outermost drawn first, then each inner ring, then the dot on top —
      // the website/PDF order. The rings already touch (zero gap) because their radii come from the shared geometry.
      if (Array.isArray(obj.rings)) {
        for (let i = obj.rings.length - 1; i >= 0; i -= 1) {
          const r = obj.rings[i];
          drawRingCircle(ctx, videoWidth, videoHeight, coverMapping, center, r.radius, r.strokeWidth, r.color, obj.opacity, r.outline || null);
        }
      }

      ctx.globalAlpha = obj.opacity ?? 1;
      if (obj.outline) {
        // The dot's own outline: an underlay beneath the dot, in the outline colour (replaces the white halo, as on the website).
        ctx.fillStyle = obj.outline.color;
        ctx.beginPath();
        ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = Math.max(1, 2 * videoLengthToCanvas(obj.outline.thickness, videoWidth, coverMapping));
        ctx.strokeStyle = obj.outline.color;
        ctx.stroke();
      }
      ctx.fillStyle = obj.color;
      ctx.beginPath();
      ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
      ctx.fill();

      // A thin white outline keeps the dot visible against any hand tone or
      // background color, without changing the doctor's chosen fill color.
      if (!obj.outline) {
        ctx.lineWidth = Math.max(1, radiusPx * 0.15);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      return;
    }

    if (obj.type === 'ring') {
      // Step 7: an unfilled circle, matching how the Doctor Builder itself
      // renders a ring (RadialShape.jsx: fill=none, stroke=color) — no
      // separate visual treatment invented here, just the same shape drawn
      // with mapped/scaled position, radius and stroke width.
      const center = videoPointToCanvas(obj.x, obj.y, videoWidth, videoHeight, coverMapping);
      drawRingCircle(ctx, videoWidth, videoHeight, coverMapping, center, obj.radius, obj.strokeWidth, obj.color, obj.opacity, obj.outline || null);
      return;
    }

    if ((obj.type === 'fingerBand' || obj.type === 'shape') && obj.matrix && Array.isArray(obj.primitives)) {
      // Shared primitives (reference px) drawn under: reference px -> video px (the fitted transform) -> canvas px
      // (the cover mapping). Position, rotation and distance of the hand carry the band along.
      const m = obj.matrix;
      const k = coverMapping.scale;
      ctx.save();
      ctx.setTransform(k * m.a, k * m.b, k * m.c, k * m.d, k * m.e + coverMapping.offsetX, k * m.f + coverMapping.offsetY);
      drawPrimitives(ctx, obj.primitives, { mirrored: Boolean(options.mirrored), alpha: vis });
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  });
}
