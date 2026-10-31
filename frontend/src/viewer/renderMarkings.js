/**
 * Renders one published protocol canvas (a hand view and its markings) from its structured objects.
 *
 * This is the ONE place that knows how to draw a protocol's objects outside the Studio's interactive canvas.
 * It works in two steps so that nothing is ever drawn twice in two different ways:
 *
 *   1. `primitivesForObject / primitivesForCanvas` turn structured objects into a neutral list of drawing
 *      PRIMITIVES (circle, line, polyline, polygon, rect, path, text, group) in the canvas's reference pixels.
 *      All geometry — outlines, multi-ring radii, finger-band curves — is decided HERE, once.
 *   2. A serializer writes those primitives out: `primitiveToSvg` (the public page and the HTML download, below),
 *      the PDF writer (pdf/primitivesToPdf.js) and the Studio's outline underlay (builder/shapes/OutlineUnderlay.jsx).
 *
 * Geometry is ported from the Protocol Studio's own Konva shape components (src/builder/shapes/*.jsx) — same
 * formulas, same object fields. Rings and outlines read the Studio's own model functions (objectModel.js), so the
 * public site, the PDF and the Studio can never disagree about what an object means.
 *
 * Everything is read-only: there is no selection, dragging or editing affordance of any kind.
 *
 * OUTLINE (every shape): an object may carry `metadata.outline = { enabled, color, thickness }`. It is drawn as an
 * UNDERLAY — the same geometry stroked wider, in the outline colour, underneath the object — so the visible band
 * is exactly `outline.thickness` on every side, independent of the fill. Objects saved without one draw exactly
 * as they always did.
 *
 * MULTIPLE RINGS: a dot's `metadata.rings` are drawn outermost first, then each inner ring, then the dot on top;
 * each ring's radius comes from objectModel.compositeRingLayers (previous outer edge + own thickness: ZERO gap).
 * The older single `metadata.ring` (with a gap) is still drawn exactly as before.
 */
import { getBand, getText, getOutline, outlineActive, compositeRingLayers } from '../builder/model/objectModel';

const num = (n, fallback = 0) => (typeof n === 'number' && Number.isFinite(n) ? n : fallback);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The active outline of an object, or null when it has none (or has it switched off). */
function activeOutlineOf(object) {
  const o = getOutline(object);
  return outlineActive(o) ? o : null;
}

/** An outline underlay for one stroked/filled primitive: same geometry, outline colour, `2 × thickness` wider stroke. */
function underlay(p, outline) {
  const filled = p.fill && p.fill !== 'none';
  return { ...p, fill: filled ? outline.color : 'none', stroke: outline.color, strokeWidth: num(p.strokeWidth, 0) + 2 * outline.thickness };
}

// ----------------------------------------------------------------------------------- per-type builders
// Each returns { under, main }: `under` = outline underlays (so the Studio can draw just those beneath its own
// interactive shape); `main` = the object itself. For a composite (dot + rings) everything is interleaved in
// `main` in the right z-order and `under` is empty, because the Studio draws a composite as one Konva group.

function dotPieces(object, canvas) {
  const cx = object.x * canvas.width;
  const cy = object.y * canvas.height;
  const opacity = num(object.opacity, 1);
  const dotRadius = (num(object.width, 0.03) / 2) * canvas.width;
  const layers = compositeRingLayers(object, canvas.width);
  const outline = activeOutlineOf(object);
  const main = [];

  if (layers.length && !layers[0].legacy) {
    // Attached rings: outermost first … innermost … then the dot on top. Each ring is a stroked circle whose
    // inner edge IS the previous layer's outer edge (compositeRingLayers) — no gap exists to be drawn.
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const L = layers[i];
      const ringOutline = outlineActive(L.outline) ? L.outline : null;
      const ring = { kind: 'circle', cx, cy, r: L.radius, fill: 'none', stroke: L.color, strokeWidth: L.thickness, opacity };
      if (ringOutline) main.push(underlay(ring, ringOutline));
      main.push(ring);
    }
  } else if (layers.length) {
    // LEGACY single ring with a gap — drawn exactly as it always was (centred via a translate group, no opacity on
    // the ring), so data saved before multi-ring support looks identical on the public page.
    const L = layers[0];
    main.push({ kind: 'circle', cx: 0, cy: 0, r: L.radius, fill: 'none', stroke: L.color, strokeWidth: L.thickness, transform: { tx: cx, ty: cy } });
  }

  const dot = { kind: 'circle', cx, cy, r: dotRadius, fill: object.color, opacity };
  if (!outline) { dot.stroke = 'rgba(255,255,255,0.9)'; dot.strokeWidth = Math.max(1, dotRadius * 0.15); } // contrast halo only when no outline
  const under = [];
  if (outline) {
    const u = underlay({ ...dot, stroke: undefined, strokeWidth: 0 }, outline);
    if (layers.length && !layers[0].legacy) main.push(u); else under.push(u);
  }
  main.push(dot);
  return { under, main };
}

function plainRingPieces(object, canvas) {
  const ring = {
    kind: 'circle', cx: object.x * canvas.width, cy: object.y * canvas.height, r: (num(object.width, 0.08) / 2) * canvas.width,
    fill: 'none', stroke: object.color, strokeWidth: num(object.thickness, 4), opacity: num(object.opacity, 1),
  };
  const outline = activeOutlineOf(object);
  return { under: outline ? [underlay(ring, outline)] : [], main: [ring] };
}

function linearPieces(object, canvas) {
  const lengthPx = num(object.width, 0.18) * canvas.width;
  const half = lengthPx / 2;
  const opacity = num(object.opacity, 1);
  const thickness = num(object.thickness, 3);
  const transform = { tx: object.x * canvas.width, ty: object.y * canvas.height, rot: num(object.rotation, 0) };
  const outline = activeOutlineOf(object);
  const children = [];
  const underChildren = [];

  if (object.type === 'arrow') {
    const headLen = Math.max(10, lengthPx * 0.12);
    const headWidth = Math.max(8, lengthPx * 0.1);
    const line = { kind: 'line', x1: -half, y1: 0, x2: half - headLen, y2: 0, stroke: object.color, strokeWidth: thickness, cap: 'round', opacity };
    const head = { kind: 'polygon', points: [[half, 0], [half - headLen, -headWidth / 2], [half - headLen, headWidth / 2]], fill: object.color, opacity };
    if (outline) {
      underChildren.push(underlay(line, outline));
      underChildren.push(underlay({ ...head, stroke: object.color, strokeWidth: 0 }, outline));
    }
    children.push(line, head);
  } else {
    const line = { kind: 'line', x1: -half, y1: 0, x2: half, y2: 0, stroke: object.color, strokeWidth: thickness, cap: 'round', opacity };
    if (outline) underChildren.push(underlay(line, outline));
    children.push(line);
  }
  return {
    under: underChildren.length ? [{ kind: 'group', transform, children: underChildren }] : [],
    main: [{ kind: 'group', transform, children }],
  };
}

function freelinePieces(object, canvas) {
  const points = (object.points || []).map((p) => [p.x * canvas.width, p.y * canvas.height]);
  if (!points.length) return { under: [], main: [] };
  const line = { kind: 'polyline', points, stroke: object.color, strokeWidth: num(object.thickness, 3), cap: 'round', join: 'round', opacity: num(object.opacity, 1) };
  const outline = activeOutlineOf(object);
  return { under: outline ? [underlay(line, outline)] : [], main: [line] };
}

function polygonPieces(object, canvas) {
  const radiusPx = (num(object.width, 0.12) / 2) * canvas.width;
  // A Konva RegularPolygon(sides=3) points up at rotation 0; these three vertices reproduce that exactly.
  const points = [0, 120, 240].map((deg) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [radiusPx * Math.cos(a), radiusPx * Math.sin(a)];
  });
  const transform = { tx: object.x * canvas.width, ty: object.y * canvas.height, rot: num(object.rotation, 0) };
  const shape = { kind: 'polygon', points, fill: object.color, stroke: object.color, strokeWidth: num(object.thickness, 3), opacity: num(object.opacity, 1) };
  const outline = activeOutlineOf(object);
  return {
    under: outline ? [{ kind: 'group', transform, children: [underlay(shape, outline)] }] : [],
    main: [{ kind: 'group', transform, children: [shape] }],
  };
}

function rectPieces(object, canvas) {
  const w = num(object.width, 0.16) * canvas.width;
  const h = num(object.height, 0.1) * canvas.height;
  const transform = { tx: object.x * canvas.width, ty: object.y * canvas.height, rot: num(object.rotation, 0) };
  const shape = { kind: 'rect', x: -w / 2, y: -h / 2, width: w, height: h, fill: object.color, stroke: object.color, strokeWidth: num(object.thickness, 3), opacity: num(object.opacity, 1) };
  const outline = activeOutlineOf(object);
  return {
    under: outline ? [{ kind: 'group', transform, children: [underlay(shape, outline)] }] : [],
    main: [{ kind: 'group', transform, children: [shape] }],
  };
}

function fingerBandPieces(object, canvas) {
  const widthPx = num(object.width, 0.13) * canvas.width;
  const thickness = Math.max(1, num(object.thickness, 4));
  const half = widthPx / 2;
  const bow = widthPx * 0.1;
  const band = getBand(object);
  const transform = { tx: object.x * canvas.width, ty: object.y * canvas.height, rot: num(object.rotation, 0) };
  const curve = (offsetY) => ({ kind: 'path', segments: [{ op: 'M', x: -half, y: offsetY }, { op: 'Q', cx: 0, cy: bow + offsetY, x: half, y: offsetY }] });
  const strip = (offsetY, color, width) => ({ ...curve(offsetY), stroke: color, strokeWidth: width, cap: 'round' });
  const outline = activeOutlineOf(object);
  const opacity = num(object.opacity, 1);

  const underChildren = [];
  const children = [];
  if (outline) {
    // The outline plays the contrast role the white halo plays otherwise, so the halo is dropped when it is on.
    underChildren.push(strip(0, outline.color, thickness + 2 * outline.thickness));
    if (band.type === 'double') underChildren.push(strip(thickness * 2.4, outline.color, thickness + 2 * outline.thickness));
  } else {
    children.push({ ...strip(0, '#ffffff', thickness + 4), opacity: 0.85 });
  }
  if (band.type === 'double') children.push(strip(thickness * 2.4, object.color, thickness));
  children.push(strip(0, object.color, thickness));
  return {
    under: underChildren.length ? [{ kind: 'group', transform, opacity, children: underChildren }] : [],
    main: [{ kind: 'group', transform, opacity, children }],
  };
}

function textPieces(object, canvas) {
  return {
    under: [],
    main: [{
      kind: 'text', text: getText(object) || ' ', size: Math.max(6, num(object.width, 0.03) * canvas.width), fill: object.color,
      opacity: num(object.opacity, 1), transform: { tx: object.x * canvas.width, ty: object.y * canvas.height, rot: num(object.rotation, 0) },
    }],
  };
}

const BUILDERS = {
  dot: dotPieces, ring: plainRingPieces, hline: linearPieces, vline: linearPieces, arrow: linearPieces, freeline: freelinePieces,
  triangle: polygonPieces, invertedTriangle: polygonPieces, rectangle: rectPieces, square: rectPieces,
  fingerBand: fingerBandPieces, text: textPieces,
};

// ------------------------------------------------------------------------------------------ public API
/** { under, main } for one object — `under` is just the outline underlay, for callers that draw their own main shape. */
export function piecesForObject(object, canvas) {
  const build = BUILDERS[object && object.type];
  if (!build) return { under: [], main: [] };
  try { return build(object, canvas); } catch (e) { return { under: [], main: [] }; } // one malformed object must never blank the whole view
}
/** Just the outline underlay primitives of one object (empty when it has no active outline). */
export const outlinePrimitivesForObject = (object, canvas) => piecesForObject(object, canvas).under;
/** Every primitive of one object in z-order: outline underlay first, then the object itself. */
export function primitivesForObject(object, canvas) {
  const { under, main } = piecesForObject(object, canvas);
  return [...under, ...main];
}
/** Every primitive of a canvas, objects drawn in the protocol's own zIndex order (lowest first, later on top). */
export function primitivesForCanvas(canvas) {
  return [...(canvas.objects || [])]
    .sort((a, b) => num(a.zIndex, 0) - num(b.zIndex, 0))
    .flatMap((o) => primitivesForObject(o, canvas));
}

// ------------------------------------------------------------------------------------- SVG serializer
const tf = (t) => (t ? ` transform="translate(${t.tx},${t.ty})${t.rot !== undefined ? ` rotate(${t.rot})` : ''}"` : '');
const op = (p) => (p.opacity !== undefined ? ` opacity="${p.opacity}"` : '');
const strokeAttrs = (p) => (p.stroke && p.stroke !== 'none'
  ? ` stroke="${esc(p.stroke)}" stroke-width="${p.strokeWidth}"${p.cap ? ` stroke-linecap="${p.cap}"` : ''}${p.join ? ` stroke-linejoin="${p.join}"` : ''}`
  : '');
const fillAttr = (p) => ` fill="${p.fill && p.fill !== 'none' ? esc(p.fill) : 'none'}"`;

/** One primitive as an SVG fragment. */
export function primitiveToSvg(p) {
  switch (p.kind) {
    case 'group': return `<g${tf(p.transform)}${op(p)}>${p.children.map(primitiveToSvg).join('')}</g>`;
    case 'circle': {
      const el = `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}"${fillAttr(p)}${op(p)}${strokeAttrs(p)} />`;
      return p.transform ? `<g${tf(p.transform)}>${el}</g>` : el;
    }
    case 'line': return `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}"${strokeAttrs(p)}${op(p)} fill="none" />`;
    case 'polyline': return `<polyline points="${p.points.map((q) => q.join(',')).join(' ')}" fill="none"${strokeAttrs(p)}${op(p)} />`;
    case 'polygon': return `<polygon points="${p.points.map((q) => q.join(',')).join(' ')}"${fillAttr(p)}${strokeAttrs(p)}${op(p)} />`;
    case 'rect': return `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}"${fillAttr(p)}${strokeAttrs(p)}${op(p)} />`;
    case 'path': {
      const d = p.segments.map((s) => (s.op === 'M' ? `M ${s.x} ${s.y}` : `Q ${s.cx} ${s.cy} ${s.x} ${s.y}`)).join(' ');
      return `<path d="${d}" fill="none"${strokeAttrs(p)}${op(p)} />`;
    }
    case 'text':
      return `<text x="0" y="0"${tf(p.transform)} text-anchor="middle" dominant-baseline="central" font-size="${p.size}" font-weight="bold" `
        + `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" fill="${esc(p.fill)}"${op(p)}>${esc(p.text)}</text>`;
    default: return '';
  }
}

/** One object's SVG markup, or '' for an unsupported/unknown type (never throws on unexpected data). */
export function svgForObject(object, canvas) {
  return primitivesForObject(object, canvas).map(primitiveToSvg).join('');
}

/**
 * A complete, self-contained `<svg>` for one canvas: its reference background image (via `imageHref` — a plain URL
 * for on-screen use, or a `data:` URI so a downloaded file needs no server to display) and every object.
 */
export function svgForCanvas(canvas, imageHref) {
  const body = primitivesForCanvas(canvas).map(primitiveToSvg).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas.width} ${canvas.height}" width="100%" height="100%">`
    + (imageHref ? `<image href="${esc(imageHref)}" x="0" y="0" width="${canvas.width}" height="${canvas.height}" preserveAspectRatio="xMidYMid meet" />` : '')
    + body
    + `</svg>`
  );
}

