/**
 * Serializes the shared drawing PRIMITIVES (viewer/renderMarkings.js — the same list the public page's SVG is made
 * from) into PDF content-stream operators. Nothing here decides what an object looks like: all geometry — outlines,
 * attached-ring radii, finger-band curves — was already decided when the primitives were built, so the PDF can never
 * draw a protocol differently from the website.
 *
 * Pure and library-free: it returns a string of operators. Anything that needs the PDF document (font encoding and
 * widths, registering transparency states) comes in through `ctx`, which keeps this module testable on its own:
 *
 *   ctx.gs(fillAlpha, strokeAlpha) -> '/GS3'    registers an ExtGState and returns its resource name
 *   ctx.boldFont                  -> '/F2'     resource name of the bold font used for text objects
 *   ctx.encode(text)              -> '<48656c6c6f>'   a hex string the font can show
 *   ctx.measure(text, size)       -> width in points (for centring)
 *
 * Coordinates are the canvas's reference pixels with y pointing DOWN, exactly like SVG; the caller sets the page
 * matrix (see buildPdf.js) so this module never has to think about PDF's y-up page.
 */

/** Numbers in a content stream must not use exponent notation. */
export function fmt(value) {
  const x = Number(value);
  if (!Number.isFinite(x)) return '0';
  // toFixed() switches to exponent notation from 1e21 up, which is not valid in a content stream — and thickness has
  // no maximum — so very large values are written as plain integers.
  if (Math.abs(x) >= 1e21) return BigInt(Math.round(x)).toString();
  const s = x.toFixed(4).replace(/\.?0+$/, '');
  return s === '' || s === '-0' ? '0' : s;
}

/** '#rgb' / '#rrggbb' / '#rrggbbaa' / 'rgba(r,g,b,a)' / 'rgb(r,g,b)' -> { r, g, b, a } in 0..1, or null for none/unknown. */
export function parseColor(css) {
  if (typeof css !== 'string') return null;
  const c = css.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) { const [r, g, b] = m[1].split('').map((h) => parseInt(h + h, 16) / 255); return { r, g, b, a: 1 }; }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (m) {
    const v = m[1];
    return { r: parseInt(v.slice(0, 2), 16) / 255, g: parseInt(v.slice(2, 4), 16) / 255, b: parseInt(v.slice(4, 6), 16) / 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c);
  if (m) return { r: Number(m[1]) / 255, g: Number(m[2]) / 255, b: Number(m[3]) / 255, a: m[4] === undefined ? 1 : Number(m[4]) };
  return null;
}

const KAPPA = 0.5522847498307936; // bezier control-point distance for a quarter circle
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const rgb = (c) => `${fmt(c.r)} ${fmt(c.g)} ${fmt(c.b)}`;
const CAP = { butt: 0, round: 1, square: 2 };
const JOIN = { miter: 0, round: 1, bevel: 2 };

function transformOps(t) {
  if (!t) return '';
  let ops = `1 0 0 1 ${fmt(t.tx)} ${fmt(t.ty)} cm\n`;
  if (t.rot !== undefined && t.rot !== 0) {
    const a = (t.rot * Math.PI) / 180;
    const c = Math.cos(a); const s = Math.sin(a);
    ops += `${fmt(c)} ${fmt(s)} ${fmt(-s)} ${fmt(c)} 0 0 cm\n`;
  }
  return ops;
}

/** Fill / stroke state + the paint operator for a shape, honouring the object opacity and any colour alpha. */
function paint(p, alpha, ctx, geometry) {
  const fill = p.fill && p.fill !== 'none' ? parseColor(p.fill) : null;
  const stroke = p.stroke && p.stroke !== 'none' && p.strokeWidth > 0 ? parseColor(p.stroke) : null;
  if (!fill && !stroke) return '';
  const fa = clamp01((p.opacity !== undefined ? p.opacity : 1) * alpha * (fill ? fill.a : 1));
  const sa = clamp01((p.opacity !== undefined ? p.opacity : 1) * alpha * (stroke ? stroke.a : 1));
  let ops = `${ctx.gs(fa, sa)} gs\n`;
  if (fill) ops += `${rgb(fill)} rg\n`;
  if (stroke) {
    ops += `${rgb(stroke)} RG\n${fmt(p.strokeWidth)} w\n${CAP[p.cap] !== undefined ? CAP[p.cap] : 0} J\n${JOIN[p.join] !== undefined ? JOIN[p.join] : 0} j\n`;
  }
  return `${ops}${geometry}${fill && stroke ? 'B' : fill ? 'f' : 'S'}\n`;
}

function circlePath(cx, cy, r) {
  const k = KAPPA * r;
  return [
    `${fmt(cx + r)} ${fmt(cy)} m`,
    `${fmt(cx + r)} ${fmt(cy + k)} ${fmt(cx + k)} ${fmt(cy + r)} ${fmt(cx)} ${fmt(cy + r)} c`,
    `${fmt(cx - k)} ${fmt(cy + r)} ${fmt(cx - r)} ${fmt(cy + k)} ${fmt(cx - r)} ${fmt(cy)} c`,
    `${fmt(cx - r)} ${fmt(cy - k)} ${fmt(cx - k)} ${fmt(cy - r)} ${fmt(cx)} ${fmt(cy - r)} c`,
    `${fmt(cx + k)} ${fmt(cy - r)} ${fmt(cx + r)} ${fmt(cy - k)} ${fmt(cx + r)} ${fmt(cy)} c`,
    'h',
  ].join('\n') + '\n';
}
const pointsPath = (pts, close) => `${pts.map(([x, y], i) => `${fmt(x)} ${fmt(y)} ${i === 0 ? 'm' : 'l'}`).join('\n')}\n${close ? 'h\n' : ''}`;

/** A quadratic segment from the current point as the equivalent cubic (PDF paths only have cubic curves). */
function quadToCubic(px, py, qx, qy, x, y) {
  return `${fmt(px + (2 / 3) * (qx - px))} ${fmt(py + (2 / 3) * (qy - py))} ${fmt(x + (2 / 3) * (qx - x))} ${fmt(y + (2 / 3) * (qy - y))} ${fmt(x)} ${fmt(y)} c`;
}

/**
 * One primitive as PDF operators. `alpha` is the opacity inherited from enclosing groups (group opacity multiplies
 * into its children — PDF has no cheap equivalent of SVG's composited group opacity, so overlapping translucent
 * strokes inside one group can differ very slightly from the web; the geometry and colours are identical).
 */
export function primitiveToPdf(p, ctx, alpha = 1) {
  switch (p.kind) {
    case 'group': {
      const a = alpha * (p.opacity !== undefined ? p.opacity : 1);
      return `q\n${transformOps(p.transform)}${p.children.map((c) => primitiveToPdf(c, ctx, a)).join('')}Q\n`;
    }
    case 'circle': {
      const body = paint(p, alpha, ctx, circlePath(p.cx, p.cy, p.r));
      return body ? `q\n${transformOps(p.transform)}${body}Q\n` : '';
    }
    case 'line': {
      const body = paint({ ...p, fill: 'none' }, alpha, ctx, `${fmt(p.x1)} ${fmt(p.y1)} m\n${fmt(p.x2)} ${fmt(p.y2)} l\n`);
      return body ? `q\n${body}Q\n` : '';
    }
    case 'polyline': {
      const body = paint({ ...p, fill: 'none' }, alpha, ctx, pointsPath(p.points, false));
      return body ? `q\n${body}Q\n` : '';
    }
    case 'polygon': {
      const body = paint(p, alpha, ctx, pointsPath(p.points, true));
      return body ? `q\n${body}Q\n` : '';
    }
    case 'rect': {
      const body = paint(p, alpha, ctx, `${fmt(p.x)} ${fmt(p.y)} ${fmt(p.width)} ${fmt(p.height)} re\n`);
      return body ? `q\n${body}Q\n` : '';
    }
    case 'path': {
      let geometry = ''; let px = 0; let py = 0;
      p.segments.forEach((s) => {
        if (s.op === 'M') { geometry += `${fmt(s.x)} ${fmt(s.y)} m\n`; px = s.x; py = s.y; } else { geometry += `${quadToCubic(px, py, s.cx, s.cy, s.x, s.y)}\n`; px = s.x; py = s.y; }
      });
      const body = paint({ ...p, fill: 'none' }, alpha, ctx, geometry);
      return body ? `q\n${body}Q\n` : '';
    }
    case 'text': {
      const color = parseColor(p.fill);
      if (!color || !p.text) return '';
      const a = clamp01((p.opacity !== undefined ? p.opacity : 1) * alpha * color.a);
      const width = ctx.measure(p.text, p.size);
      // The canvas is y-down, text is drawn y-up: flip back locally, then centre the string on the point.
      return `q\n${transformOps(p.transform)}1 0 0 -1 0 0 cm\n${ctx.gs(a, a)} gs\n${rgb(color)} rg\nBT\n${ctx.boldFont} ${fmt(p.size)} Tf\n${fmt(-width / 2)} ${fmt(-p.size * 0.35)} Td\n${ctx.encode(p.text)} Tj\nET\nQ\n`;
    }
    default:
      return '';
  }
}

export const primitivesToPdf = (prims, ctx) => prims.map((p) => primitiveToPdf(p, ctx)).join('');
