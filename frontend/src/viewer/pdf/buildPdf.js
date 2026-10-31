/**
 * Builds a REAL PDF file (valid PDF 1.7, produced by pdf-lib — not an HTML page renamed .pdf) for a published protocol.
 *
 * Input is exactly what `GET /api/public/protocols/:slug/render` returns — the published, immutable snapshot, never the
 * draft. Every marking is drawn from the SAME primitives the public page's SVG is made from (viewer/renderMarkings.js ->
 * primitivesToPdf.js), as vector graphics on top of the hand image, so what is printed is what the website shows:
 * colours, outlines, multiple attached rings, finger bands and text included.
 *
 * Layout: page 1 = title, category / condition / version, the description and the medical disclaimer (it flows onto more
 * pages if the description is long); then the views (Left Front, Right Front, Left Back, Right Back) in a 2-column grid.
 *
 * `pdf-lib` is loaded on demand (dynamic import) so it is only downloaded when someone actually asks for a PDF.
 */
import { primitivesForCanvas } from '../renderMarkings';
import { primitivesToPdf, fmt } from './primitivesToPdf';

const PAGE = { width: 595.28, height: 841.89 }; // A4, in points
const MARGIN = 42;
const CONTENT_W = PAGE.width - MARGIN * 2;
const GAP = 16;
const GREY = '0.42 0.45 0.5';
const INK = '0.12 0.14 0.16';
const BLUE = '0.102 0.451 0.91';

export const PDF_DISCLAIMER = 'This document is informational only. It does not diagnose, treat, cure or prevent any condition, and is not a substitute for professional medical advice. Consult a qualified healthcare provider for any medical concern.';

async function loadPdfLib() {
  const mod = await import('pdf-lib');
  return mod.PDFDocument ? mod : mod.default;
}

/** Replaces anything the standard PDF font cannot show with "?" (never throws on an emoji or unusual character). */
function sanitize(font, text) {
  const supported = new Set(font.getCharacterSet());
  return Array.from(String(text == null ? '' : text).replace(/[\t\r]/g, ' '))
    .map((ch) => (ch === '\n' || supported.has(ch.codePointAt(0)) ? ch : '?'))
    .join('');
}

/** Greedy word wrap to `maxWidth` points. Words longer than a line are broken so nothing runs off the page. */
function wrap(font, text, size, maxWidth) {
  const lines = [];
  String(text).split('\n').forEach((para) => {
    let line = '';
    para.split(/\s+/).filter(Boolean).forEach((word) => {
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxWidth) { // a single over-long word
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut -= 1;
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const candidate = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
      else { lines.push(line); line = w; }
    });
    lines.push(line);
  });
  return lines;
}

const isJpeg = (b) => b && b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
const isPng = (b) => b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** Default image loader for the browser: bytes of the image at `url`, or null if it cannot be fetched. */
export async function fetchImageBytes(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return null;
  }
}

/**
 * @param {object} render  the public /render payload ({ protocol, canvases })
 * @param {object} [options]
 *   imageBaseUrl  prefix for the relative `background.url` of each view (e.g. the API origin)
 *   loadImage     async (url) => Uint8Array|null — override how hand images are loaded (tests, other environments)
 *   shareUrl      the public link to print on the first page, if known
 *   now           Date used for the document's creation date (defaults to the protocol's published date, else today)
 * @returns {Promise<Uint8Array>} the PDF file's bytes
 */
export async function buildProtocolPdf(render, options = {}) {
  const { PDFDocument, PDFName, StandardFonts } = await loadPdfLib();
  const { imageBaseUrl = '', loadImage = fetchImageBytes, shareUrl = null } = options;
  const p = render.protocol || {};
  const title = p.displayName || p.name || 'Protocol';

  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const published = p.version && p.version.publishedAt ? new Date(p.version.publishedAt) : null;
  const created = options.now || (published && !Number.isNaN(published.getTime()) ? published : new Date());

  doc.setTitle(sanitize(regular, title));
  doc.setSubject('Colour therapy protocol');
  doc.setAuthor('Colour Therapy Protocol Platform');
  doc.setCreator('Colour Therapy Protocol Platform');
  doc.setProducer('Colour Therapy Protocol Platform (pdf-lib)');
  doc.setKeywords(['colour therapy', 'protocol', ...(p.conditions || []).map((c) => sanitize(regular, c.name)), p.category ? sanitize(regular, p.category.name) : null].filter(Boolean));
  doc.setCreationDate(created);
  doc.setModificationDate(created);

  // ---- one page = one content stream plus the resources (fonts, images, transparency states) it names
  const pages = [];
  function newPage() {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const state = { page, ops: [], gs: new Map(), images: [] };
    page.node.setFontDictionary(PDFName.of('F1'), regular.ref);
    page.node.setFontDictionary(PDFName.of('F2'), bold.ref);
    pages.push(state);
    return state;
  }
  const gsFor = (st, fillAlpha, strokeAlpha) => {
    const key = `${fmt(fillAlpha)}|${fmt(strokeAlpha)}`;
    if (!st.gs.has(key)) st.gs.set(key, { name: `GS${st.gs.size + 1}`, ca: fillAlpha, CA: strokeAlpha });
    return `/${st.gs.get(key).name}`;
  };
  const pdfCtx = (st) => ({
    gs: (a, b) => gsFor(st, a, b),
    boldFont: '/F2',
    encode: (text) => bold.encodeText(sanitize(bold, text)).toString(),
    measure: (text, size) => bold.widthOfTextAtSize(sanitize(bold, text), size),
  });
  const text = (st, str, x, y, { size = 11, font = 'F1', color = INK } = {}) => {
    const f = font === 'F2' ? bold : regular;
    st.ops.push(`BT\n/${font} ${fmt(size)} Tf\n${color} rg\n${fmt(x)} ${fmt(y)} Td\n${f.encodeText(sanitize(f, str)).toString()} Tj\nET\n`);
  };
  const centred = (st, str, cx, y, opts) => {
    const f = opts && opts.font === 'F2' ? bold : regular;
    const s = sanitize(f, str);
    text(st, s, cx - f.widthOfTextAtSize(s, (opts && opts.size) || 11) / 2, y, opts);
  };
  const rule = (st, y, color = '0.88 0.89 0.91') => st.ops.push(`${color} RG\n0.8 w\n${fmt(MARGIN)} ${fmt(y)} m\n${fmt(PAGE.width - MARGIN)} ${fmt(y)} l\nS\n`);

  // ---------------------------------------------------------------- page 1: heading, details, description
  let st = newPage();
  let y = PAGE.height - MARGIN;
  text(st, 'COLOUR THERAPY PROTOCOL', MARGIN, y - 8, { size: 8.5, font: 'F2', color: BLUE });
  y -= 30;
  wrap(bold, sanitize(bold, title), 22, CONTENT_W).forEach((line) => { text(st, line, MARGIN, y, { size: 22, font: 'F2' }); y -= 27; });
  if (p.shortDescription) {
    wrap(regular, sanitize(regular, p.shortDescription), 12, CONTENT_W).forEach((line) => { text(st, line, MARGIN, y, { size: 12, color: GREY }); y -= 16; });
  }
  y -= 8;
  rule(st, y);
  y -= 20;

  const details = [
    ['Category', p.category ? p.category.name : null],
    ['Condition', (p.conditions || []).length ? p.conditions.map((c) => c.name).join(', ') : null],
    ['Version', p.version ? `v${p.version.number}${published ? ` — published ${published.toISOString().slice(0, 10)}` : ''}` : null],
    ['Online', shareUrl],
  ];
  details.filter(([, v]) => v).forEach(([label, value]) => {
    text(st, label.toUpperCase(), MARGIN, y, { size: 8, font: 'F2', color: GREY });
    wrap(regular, sanitize(regular, value), 11, CONTENT_W - 80).forEach((line, i) => { text(st, line, MARGIN + 80, y - (i ? 0 : 0), { size: 11 }); y -= 15; });
    y -= 3;
  });
  y -= 6;

  if (p.description) {
    text(st, 'DESCRIPTION', MARGIN, y, { size: 8, font: 'F2', color: GREY });
    y -= 16;
    wrap(regular, sanitize(regular, p.description), 11, CONTENT_W).forEach((line) => {
      if (y < MARGIN + 90) { st = newPage(); y = PAGE.height - MARGIN; }
      text(st, line, MARGIN, y, { size: 11 });
      y -= 15.5;
    });
  }

  // disclaimer, always kept with the details page
  y -= 14;
  const disclaimer = wrap(regular, PDF_DISCLAIMER, 9, CONTENT_W - 24);
  const boxH = disclaimer.length * 12 + 20;
  if (y - boxH < MARGIN + 20) { st = newPage(); y = PAGE.height - MARGIN; }
  st.ops.push(`0.96 0.965 0.97 rg\n${fmt(MARGIN)} ${fmt(y - boxH)} ${fmt(CONTENT_W)} ${fmt(boxH)} re\nf\n`);
  disclaimer.forEach((line, i) => text(st, line, MARGIN + 12, y - 16 - i * 12, { size: 9, color: GREY }));

  // ---------------------------------------------------------------- the views, in a grid
  const canvases = render.canvases || [];
  if (canvases.length) {
    st = newPage();
    let top = PAGE.height - MARGIN;
    text(st, 'PROTOCOL MARKINGS', MARGIN, top - 8, { size: 8.5, font: 'F2', color: BLUE });
    text(st, sanitize(bold, title), MARGIN, top - 26, { size: 13, font: 'F2' });
    top -= 44;

    const cols = canvases.length === 1 ? 1 : 2;
    const rows = Math.ceil(canvases.length / cols);
    const labelH = 22;
    const cellW = cols === 1 ? Math.min(CONTENT_W, 330) : (CONTENT_W - GAP) / 2;
    const maxCellH = (top - MARGIN - 24 - GAP * (rows - 1)) / rows - labelH;

    // load every view's hand image (in parallel), embedding whichever format it really is
    const embedded = await Promise.all(canvases.map(async (c) => {
      const url = c.background && c.background.url ? `${imageBaseUrl}${c.background.url}` : null;
      if (!url) return null;
      const bytes = await loadImage(url);
      if (isPng(bytes)) return doc.embedPng(bytes);
      if (isJpeg(bytes)) return doc.embedJpg(bytes);
      return null; // unreadable image: that view is drawn without a background rather than failing the whole PDF
    }));

    canvases.forEach((c, i) => {
      const col = i % cols; const row = Math.floor(i / cols);
      const scale = Math.min(cellW / c.width, maxCellH / c.height);
      const w = c.width * scale; const h = c.height * scale;
      const cellX = MARGIN + col * (cellW + GAP) + (cols === 1 ? (CONTENT_W - cellW) / 2 : 0);
      const x = cellX + (cellW - w) / 2;
      const yTop = top - row * (maxCellH + labelH + GAP);

      // frame
      st.ops.push(`0.86 0.87 0.89 RG\n0.8 w\n${fmt(x)} ${fmt(yTop - h)} ${fmt(w)} ${fmt(h)} re\nS\n`);
      // the view: canvas pixels (y down) mapped into the page, clipped to the image rectangle
      st.ops.push(`q\n${fmt(scale)} 0 0 ${fmt(-scale)} ${fmt(x)} ${fmt(yTop)} cm\n0 0 ${fmt(c.width)} ${fmt(c.height)} re\nW n\n`);
      if (embedded[i]) {
        const name = `Im${st.images.length + 1}`;
        st.images.push({ name, image: embedded[i] });
        st.ops.push(`q\n${fmt(c.width)} 0 0 ${fmt(-c.height)} 0 ${fmt(c.height)} cm\n/${name} Do\nQ\n`);
      } else {
        st.ops.push(`0.96 0.965 0.97 rg\n0 0 ${fmt(c.width)} ${fmt(c.height)} re\nf\n`);
      }
      st.ops.push(primitivesToPdf(primitivesForCanvas(c), pdfCtx(st)));
      st.ops.push('Q\n');
      centred(st, (c.label || c.viewKey || '').toUpperCase(), x + w / 2, yTop - h - 15, { size: 9.5, font: 'F2', color: '0.22 0.25 0.3' });
    });
  }

  // ---------------------------------------------------------------- footers, then write each page's content + resources
  pages.forEach((pg, i) => {
    const f = `${title} — page ${i + 1} of ${pages.length}`;
    pg.ops.push(`BT\n/F1 8 Tf\n${GREY} rg\n${fmt(MARGIN)} ${fmt(MARGIN - 20)} Td\n${regular.encodeText(sanitize(regular, f)).toString()} Tj\nET\n`);
    pg.gs.forEach((g) => pg.page.node.setExtGState(PDFName.of(g.name), doc.context.obj({ Type: 'ExtGState', ca: g.ca, CA: g.CA })));
    pg.images.forEach((im) => pg.page.node.setXObject(PDFName.of(im.name), im.image.ref));
    pg.page.node.addContentStream(doc.context.register(doc.context.flateStream(pg.ops.join(''))));
  });

  return doc.save();
}

/** Browser download of the built PDF bytes. */
export function downloadPdfFile(bytes, filenameBase) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameBase || 'protocol'}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
