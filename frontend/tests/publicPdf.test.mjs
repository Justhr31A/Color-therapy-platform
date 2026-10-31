/**
 * [DETERMINISTIC SOFTWARE TESTS] PDF download — the REAL modules (src/viewer/pdf/*) and the REAL pdf-lib.
 *
 * Two layers:
 *   1. primitivesToPdf: the pure serializer that turns the SHARED drawing primitives (the same ones the public page's SVG
 *      is made from) into PDF operators — checked operator by operator, including that attached rings are zero-gap
 *      in the PDF's own content stream.
 *   2. buildProtocolPdf: the whole file — it is a genuine PDF (re-parsed by pdf-lib; also run through qpdf and pdftotext
 *      when those tools are installed), has every view, every marking, the metadata and the disclaimer.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmt, parseColor, primitiveToPdf, primitivesToPdf } from '../src/viewer/pdf/primitivesToPdf.js';
import { buildProtocolPdf, PDF_DISCLAIMER } from '../src/viewer/pdf/buildPdf.js';
import { primitivesForCanvas, primitivesForObject } from '../src/viewer/renderMarkings.js';
import * as M from '../src/builder/model/objectModel.js';
import { axisPoint } from '../src/builder/model/fingerGeometry.js';

const images = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/tinyImages.json', import.meta.url)), 'utf8'));
const PNG = new Uint8Array(Buffer.from(images.png, 'base64'));
const JPEG = new Uint8Array(Buffer.from(images.jpeg, 'base64'));

// ------------------------------------------------------------------------------------------------ helpers
/** A fake `ctx` for the pure serializer: records every transparency state it is asked for. */
function fakeCtx() {
  const gs = [];
  return { gs, ctx: { gs: (a, b) => { gs.push([a, b]); return `/GS${gs.length}`; }, boldFont: '/F2', encode: (t) => `<${Buffer.from(t, 'latin1').toString('hex')}>`, measure: (t, s) => t.length * s * 0.5 } };
}
const DIMS = { left_front: [1586, 1982], right_front: [1585, 1983], left_back: [1585, 1981], right_back: [1971, 2010] };
const LABEL = { left_front: 'Left Front', right_front: 'Right Front', left_back: 'Left Back', right_back: 'Right Back' };
const ctxOf = (v) => ({ viewKey: v, canvasWidth: DIMS[v][0], canvasHeight: DIMS[v][1] });
const mk = (tool, v, x = 0.4, y = 0.5) => M.createStudioObject(tool, x, y, ctxOf(v));
let zc = 0;
const z = (o) => ({ ...o, zIndex: (zc += 1), id: `o${zc}` });

/** A rich view: Dot + 4 attached rings (two with outlines), outlined line, XL arrow, outlined shapes, band, text, legacy ring. */
function richObjects(v) {
  zc = 0;
  let dr = mk('dotRing', v, 0.5, 0.6);
  for (let i = 0; i < 3; i += 1) dr = { ...dr, ...M.addRing(dr) };
  dr = { ...dr, color: '#e5484d', ...M.patchOutline(dr, { enabled: true, color: '#00ff00', thickness: 3 }) };
  [[0, { color: '#e5484d', thickness: 14 }], [1, { color: '#f5d90a', thickness: 26, outline: { enabled: true, color: '#00ff00', thickness: 9 } }], [2, { color: '#46a758', thickness: 8 }], [3, { color: '#1a73e8', thickness: 40 }]]
    .forEach(([i, patch]) => { dr = { ...dr, ...M.patchRingAt(dr, i, patch) }; });
  const out = [z(dr)];
  let line = mk('hline', v, 0.5, 0.2); line = { ...line, ...M.patchThickness(line, 1_000_000_000), color: '#12a594', ...M.patchOutline(line, { enabled: true, color: '#00ff00', thickness: 8 }) }; out.push(z(line));
  let arrow = mk('arrow', v, 0.5, 0.33); arrow = { ...arrow, ...M.patchSizePreset(arrow, 'xl'), color: '#d6409f' }; out.push(z(arrow));
  let tri = mk('triangle', v, 0.25, 0.45); tri = { ...tri, color: '#f76b15', ...M.patchOutline(tri, { enabled: true, color: '#00ff00', thickness: 6 }) }; out.push(z(tri));
  let rect = mk('rectangle', v, 0.75, 0.45); rect = { ...rect, color: '#05a2c2', rotation: 15 }; out.push(z(rect));
  let t = mk('text', v, 0.5, 0.95); t = { ...t, ...M.patchText(t, 'Hold 3 minutes'), color: '#111111' }; out.push(z(t));
  const p = axisPoint(v, 'middle', 0.5); let band = mk('fingerBand', v, p.x, p.y);
  band = { ...band, color: '#e5484d', ...M.patchBandType(band, 'double'), ...M.patchOutline(band, { enabled: true, color: '#00ff00', thickness: 3 }) }; out.push(z(band));
  const legacyDot = mk('dot', v, 0.2, 0.8); out.push(z({ ...legacyDot, ...M.patchRingEnabled(legacyDot, true) }));
  return out;
}
function protocolFixture(over = {}) {
  return {
    protocol: {
      name: 'back-pain', displayName: 'Back Pain — Test Protocol', shortDescription: 'A short summary.', description: 'Apply the markings in the order shown. Hold each for three minutes.',
      category: { slug: 'musculoskeletal', name: 'Musculoskeletal' }, conditions: [{ slug: 'back-pain', name: 'Back Pain' }, { slug: 'sciatica', name: 'Sciatica' }],
      version: { number: 4, publishedAt: '2026-10-01T09:30:00Z' }, ...over.protocol,
    },
    canvases: over.canvases || Object.keys(DIMS).map((v) => ({ viewKey: v, label: LABEL[v], width: DIMS[v][0], height: DIMS[v][1], background: { url: `/static/hands/${v}.png` }, objects: richObjects(v) })),
  };
}
let L; // pdf-lib
before(async () => { const mod = await import('pdf-lib'); L = mod.PDFDocument ? mod : mod.default; });

const build = (render, over = {}) => buildProtocolPdf(render, { imageBaseUrl: '', loadImage: async () => PNG, ...over });
const WINANSI = { 0x96: '–', 0x97: '—', 0x92: '’', 0x93: '“', 0x94: '”' };
/** The decoded content stream of one page of a built PDF. */
async function pageContent(bytes, index) {
  const doc = await L.PDFDocument.load(bytes);
  const contents = doc.getPage(index).node.Contents();
  const refs = contents.asArray();
  return refs.map((r) => Buffer.from(L.decodePDFRawStream(doc.context.lookup(r)).decode()).toString('latin1')).join('\n');
}
/** Every string shown with Tj on a page, decoded from the font's hex encoding. */
const shownText = (content) => [...content.matchAll(/<([0-9a-fA-F]*)>\s*Tj/g)].map((m) => [...Buffer.from(m[1], 'hex')].map((b) => WINANSI[b] || String.fromCharCode(b)).join(''));
const countOps = (content, op) => (content.match(new RegExp(`(^|\\n)[^\\n]* ${op}(?=\\n)`, 'g')) || []).length;

// ================================================================================================ 1. the serializer
describe('[DETERMINISTIC] primitives → PDF operators (pure)', () => {
  it('numbers never use exponent notation, however large or small (thickness has no maximum)', () => {
    assert.equal(fmt(1e-7), '0');
    assert.equal(fmt(123.456789), '123.4568');
    assert.equal(fmt(-5), '-5');
    assert.equal(fmt(1e9), '1000000000');
    assert.doesNotMatch(fmt(1e25), /e/i);
    assert.equal(fmt(NaN), '0');
    assert.equal(fmt(Infinity), '0');
  });

  it('colours: #rgb, #rrggbb, #rrggbbaa, rgb() and rgba(); anything else is null', () => {
    assert.deepEqual(parseColor('#fff'), { r: 1, g: 1, b: 1, a: 1 });
    assert.deepEqual(parseColor('#ff0000'), { r: 1, g: 0, b: 0, a: 1 });
    assert.equal(parseColor('#00000080').a.toFixed(2), '0.50');
    assert.deepEqual(parseColor('rgba(255,255,255,0.9)'), { r: 1, g: 1, b: 1, a: 0.9 });
    assert.deepEqual(parseColor('rgb(0, 255, 0)'), { r: 0, g: 1, b: 0, a: 1 });
    [null, undefined, 'none', 'red', '#12', 5].forEach((bad) => assert.equal(parseColor(bad), null, String(bad)));
  });

  it('a circle is four bezier curves, closed; filled -> "f", stroked -> "S", both -> "B"', () => {
    const { ctx } = fakeCtx();
    const circle = { kind: 'circle', cx: 10, cy: 20, r: 5 };
    const filled = primitiveToPdf({ ...circle, fill: '#ff0000' }, ctx);
    assert.equal(countOps(filled, 'c'), 4);
    assert.match(filled, /\nh\nf\n/);
    assert.match(filled, /1 0 0 rg/);
    const stroked = primitiveToPdf({ ...circle, fill: 'none', stroke: '#0000ff', strokeWidth: 3 }, ctx);
    assert.match(stroked, /0 0 1 RG/);
    assert.match(stroked, /\n3 w\n/);
    assert.match(stroked, /\nh\nS\n/);
    assert.match(primitiveToPdf({ ...circle, fill: '#fff', stroke: '#000', strokeWidth: 2 }, ctx), /\nh\nB\n/);
  });

  it('starts the circle at its rightmost point, so the radius can be read straight back from the stream', () => {
    const { ctx } = fakeCtx();
    const ops = primitiveToPdf({ kind: 'circle', cx: 100, cy: 50, r: 30, fill: '#000' }, ctx);
    assert.match(ops, /\n130 50 m\n/);
  });

  it('a shape with neither a fill nor a visible stroke draws nothing; a zero-width stroke is NOT drawn as a hairline', () => {
    const { ctx } = fakeCtx();
    assert.equal(primitiveToPdf({ kind: 'circle', cx: 1, cy: 1, r: 1, fill: 'none' }, ctx), '');
    assert.equal(primitiveToPdf({ kind: 'circle', cx: 1, cy: 1, r: 1, fill: 'none', stroke: '#000', strokeWidth: 0 }, ctx), '');
    assert.doesNotMatch(primitiveToPdf({ kind: 'circle', cx: 1, cy: 1, r: 1, fill: '#000', stroke: '#fff', strokeWidth: 0 }, ctx), /\n0 w\n/);
  });

  it('a huge stroke is written in full — 1,000,000,000 px thickness appears as a plain number', () => {
    const { ctx } = fakeCtx();
    assert.match(primitiveToPdf({ kind: 'line', x1: 0, y1: 0, x2: 9, y2: 9, stroke: '#000', strokeWidth: 1e9, cap: 'round' }, ctx), /\n1000000000 w\n1 J\n/);
  });

  it('line / polyline / polygon / rect use the right path operators; only the polygon is closed', () => {
    const { ctx } = fakeCtx();
    const line = primitiveToPdf({ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 5, stroke: '#000', strokeWidth: 2 }, ctx);
    assert.match(line, /0 0 m\n10 5 l\nS\n/);
    const poly = primitiveToPdf({ kind: 'polyline', points: [[0, 0], [5, 5], [9, 1]], stroke: '#000', strokeWidth: 2, cap: 'round', join: 'round' }, ctx);
    assert.match(poly, /0 0 m\n5 5 l\n9 1 l\nS\n/);
    assert.doesNotMatch(poly, /\nh\n/);
    assert.match(poly, /1 J\n1 j\n/);
    const tri = primitiveToPdf({ kind: 'polygon', points: [[0, 0], [4, 0], [2, 3]], fill: '#f00', stroke: '#f00', strokeWidth: 1 }, ctx);
    assert.match(tri, /0 0 m\n4 0 l\n2 3 l\nh\nB\n/);
    assert.match(primitiveToPdf({ kind: 'rect', x: 1, y: 2, width: 30, height: 40, fill: '#00f' }, ctx), /1 2 30 40 re\nf\n/);
  });

  it('a quadratic curve becomes the exact equivalent cubic (finger bands)', () => {
    const { ctx } = fakeCtx();
    const ops = primitiveToPdf({ kind: 'path', segments: [{ op: 'M', x: 0, y: 0 }, { op: 'Q', cx: 3, cy: 3, x: 6, y: 0 }], stroke: '#000', strokeWidth: 2, cap: 'round' }, ctx);
    assert.match(ops, /0 0 m\n2 2 4 2 6 0 c\nS\n/);
  });

  it('a group applies translate then rotate; a 90° rotation is the exact matrix, and nested content is wrapped in q … Q', () => {
    const { ctx } = fakeCtx();
    const ops = primitiveToPdf({ kind: 'group', transform: { tx: 5, ty: 7, rot: 90 }, children: [{ kind: 'rect', x: 0, y: 0, width: 1, height: 1, fill: '#000' }] }, ctx);
    assert.match(ops, /^q\n1 0 0 1 5 7 cm\n0 1 -1 0 0 0 cm\n/);
    assert.match(ops, /Q\n$/);
    assert.equal(countOps(ops, 'cm'), 2);
    assert.doesNotMatch(primitiveToPdf({ kind: 'group', transform: { tx: 1, ty: 2, rot: 0 }, children: [] }, ctx), /0 0 cm/, 'no rotation matrix for 0°');
  });

  it('opacity: object opacity, group opacity and colour alpha all multiply into the transparency state', () => {
    const { ctx, gs } = fakeCtx();
    primitiveToPdf({ kind: 'group', opacity: 0.5, children: [{ kind: 'circle', cx: 0, cy: 0, r: 1, fill: '#000', opacity: 0.5 }, { kind: 'circle', cx: 0, cy: 0, r: 1, fill: '#000', stroke: 'rgba(255,255,255,0.9)', strokeWidth: 2, opacity: 1 }] }, ctx);
    assert.deepEqual(gs[0], [0.25, 0.25], 'group 0.5 × object 0.5');
    assert.equal(gs[1][0], 0.5, 'fill: group 0.5');
    assert.ok(Math.abs(gs[1][1] - 0.45) < 1e-9, 'stroke: group 0.5 × colour alpha 0.9');
  });

  it('text: shown with the bold font, un-flipped (the canvas is y-down), centred using the measured width', () => {
    const { ctx } = fakeCtx();
    const ops = primitiveToPdf({ kind: 'text', text: 'Hi', size: 20, fill: '#111111', opacity: 1, transform: { tx: 100, ty: 200, rot: 0 } }, ctx);
    assert.match(ops, /1 0 0 -1 0 0 cm/);
    assert.match(ops, /BT\n\/F2 20 Tf\n-10 -7 Td\n<4869> Tj\nET/); // width = 2 chars × 20 × 0.5 = 20 -> -10; -0.35 × 20 = -7
  });

  it('an unknown primitive kind writes nothing and never throws', () => {
    const { ctx } = fakeCtx();
    assert.equal(primitiveToPdf({ kind: 'hologram' }, ctx), '');
  });

  it('ATTACHED RINGS are zero-gap in the PDF content stream itself: each ring\'s inner edge is the previous outer edge', () => {
    let o = mk('dotRing', 'left_front', 0.5, 0.5);
    [10, 3, 40, 7, 120].forEach((t) => { o = { ...o, ...M.addRing(o) }; o = { ...o, ...M.patchRingAt(o, M.getRings(o).length - 1, { thickness: t }) }; });
    const { ctx } = fakeCtx();
    const cx = o.x * DIMS.left_front[0];
    const ops = primitivesToPdf(primitivesForObject(o, { width: DIMS.left_front[0], height: DIMS.left_front[1] }), ctx);
    // the stroke-ONLY circles (`h` then `S`: not the dot, which is filled) in draw order: outermost ring first -> innermost last
    const rings = [...ops.matchAll(/ RG\n([\d.-]+) w\n\d J\n\d j\n([\d.-]+) [\d.-]+ m\n(?:[^\n]*\n){4}h\nS\n/g)].map((m) => ({ width: Number(m[1]), radius: Number(m[2]) - cx }));
    assert.equal(rings.length, 6, 'the default ring + 5 added');
    const inner = [...rings].reverse(); // innermost first
    const dotRadius = (o.width / 2) * DIMS.left_front[0];
    assert.ok(Math.abs(inner[0].radius - inner[0].width / 2 - dotRadius) < 1e-2, 'ring 1 touches the dot');
    inner.slice(1).forEach((r, i) => {
      const prevOuter = inner[i].radius + inner[i].width / 2;
      assert.ok(Math.abs(r.radius - r.width / 2 - prevOuter) < 1e-2, `ring ${i + 2} touches ring ${i + 1}`);
    });
  });

  it('every primitive the renderer can produce for every object type serializes to something (no type silently disappears from the PDF)', () => {
    const { ctx } = fakeCtx();
    const canvas = { width: DIMS.left_front[0], height: DIMS.left_front[1] };
    richObjects('left_front').forEach((o) => {
      const prims = primitivesForObject(o, canvas);
      assert.ok(prims.length > 0, o.type);
      assert.ok(primitivesToPdf(prims, ctx).length > 0, `${o.type} produces PDF operators`);
    });
  });
});

// ================================================================================================ 2. the real file
describe('[DETERMINISTIC] a real PDF file', () => {
  it('is a genuine PDF: %PDF- header, %%EOF trailer, and pdf-lib can re-open it', async () => {
    const bytes = await build(protocolFixture());
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
    assert.match(Buffer.from(bytes.slice(-16)).toString(), /%%EOF\s*$/);
    const doc = await L.PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 2, 'a details page and a markings page');
  });

  it('is not an HTML page renamed: it contains no HTML at all', async () => {
    const text = Buffer.from(await build(protocolFixture())).toString('latin1');
    assert.doesNotMatch(text, /<html|<!doctype|<svg/i);
  });

  it('carries the protocol metadata in the document properties (title, subject, author, keywords, date = published date)', async () => {
    const doc = await L.PDFDocument.load(await build(protocolFixture()));
    assert.equal(doc.getTitle(), 'Back Pain — Test Protocol');
    assert.equal(doc.getSubject(), 'Colour therapy protocol');
    assert.equal(doc.getAuthor(), 'Colour Therapy Protocol Platform');
    assert.match(doc.getKeywords(), /Back Pain/);
    assert.match(doc.getKeywords(), /Musculoskeletal/);
    assert.equal(doc.getCreationDate().toISOString(), '2026-10-01T09:30:00.000Z');
  });

  it('page 1 shows the protocol name, category, conditions, version, description, link and the medical disclaimer', async () => {
    const bytes = await build(protocolFixture(), { shareUrl: 'https://clinic.example/protocols/back-pain' });
    const text = shownText(await pageContent(bytes, 0)).join('\n');
    assert.match(text, /Back Pain — Test Protocol/);
    assert.match(text, /Musculoskeletal/);
    assert.match(text, /Back Pain, Sciatica/);
    assert.match(text, /v4 — published 2026-10-01/);
    assert.match(text, /Apply the markings in the order shown/);
    assert.match(text, /https:\/\/clinic\.example\/protocols\/back-pain/);
    assert.match(text.replace(/\n/g, ' '), /does not diagnose, treat, cure or prevent/);
    assert.ok(PDF_DISCLAIMER.includes('not a substitute for professional medical advice'));
  });

  it('page 2 has all FOUR hand views, labelled, each with its own embedded hand image', async () => {
    const bytes = await build(protocolFixture());
    const content = await pageContent(bytes, 1);
    const labels = shownText(content);
    ['LEFT FRONT', 'RIGHT FRONT', 'LEFT BACK', 'RIGHT BACK'].forEach((l) => assert.ok(labels.includes(l), l));
    assert.equal((content.match(/\/Im\d+ Do/g) || []).length, 4, 'four image draws');
    const doc = await L.PDFDocument.load(bytes);
    const xobjects = doc.getPage(1).node.Resources().lookup(L.PDFName.of('XObject'));
    assert.equal(xobjects.keys().length, 4, 'four image XObjects embedded');
  });

  it('every marking of every view is in the PDF: the number of curves drawn equals what the shared renderer says (4 per circle + 1 per curved segment)', async () => {
    const render = protocolFixture();
    const content = await pageContent(await build(render), 1);
    const expected = render.canvases.reduce((sum, c) => {
      const walk = (p) => (p.kind === 'group' ? p.children.reduce((a, ch) => a + walk(ch), 0) : p.kind === 'circle' ? 4 : p.kind === 'path' ? p.segments.filter((s) => s.op === 'Q').length : 0);
      return sum + primitivesForCanvas(c).reduce((a, p) => a + walk(p), 0);
    }, 0);
    assert.ok(expected > 100, 'the fixture has plenty of curves');
    assert.equal(countOps(content, 'c'), expected);
  });

  it('colours are in the PDF: dot, every ring, the shapes, the line and the band each appear as drawing colours', async () => {
    const content = await pageContent(await build(protocolFixture()), 1);
    const has = (hex, op) => content.includes(`${(({ r, g, b }) => `${fmt(r)} ${fmt(g)} ${fmt(b)}`)(parseColor(hex))} ${op}`);
    ['#e5484d', '#f5d90a', '#46a758', '#1a73e8', '#f76b15', '#05a2c2', '#d6409f', '#12a594'].forEach((hex) => {
      assert.ok(has(hex, 'RG') || has(hex, 'rg'), `${hex} is drawn`);
    });
  });

  it('MULTIPLE ATTACHED RINGS are all there: each ring colour is drawn as a stroked circle, once per view', async () => {
    const content = await pageContent(await build(protocolFixture()), 1);
    const stroke = (hex) => `${(({ r, g, b }) => `${fmt(r)} ${fmt(g)} ${fmt(b)}`)(parseColor(hex))} RG`;
    ['#f5d90a', '#46a758', '#1a73e8'].forEach((hex) => {
      assert.ok((content.split(stroke(hex)).length - 1) >= 4, `${hex} ring appears in all four views`);
    });
  });

  it('OUTLINES are there: the outline colour is drawn, and an outlined ring is stroked at ring thickness + 2 × outline thickness (26 + 18 = 44)', async () => {
    const content = await pageContent(await build(protocolFixture()), 1);
    assert.ok(content.includes('0 1 0 RG'), 'outline colour #00ff00 is drawn as a stroke');
    assert.ok(content.includes('0 1 0 rg'), 'and as the fill of a dot/shape underlay');
    assert.ok(/\n44 w\n/.test(content), 'ring 2 underlay: 26 + 2×9');
    assert.ok(/\n12 w\n/.test(content) || /\n6 w\n/.test(content), 'other outline widths are present too');
  });

  it('a very large thickness reaches the PDF in full (1,000,000,000 px line, outlined: 1,000,000,016)', async () => {
    const content = await pageContent(await build(protocolFixture()), 1);
    assert.ok(/\n1000000000 w\n/.test(content));
    assert.ok(/\n1000000016 w\n/.test(content), 'and its outline underlay is wider by 2 × 8');
  });

  it('Extra Large and text objects are drawn: the annotation text is shown on every view', async () => {
    const texts = shownText(await pageContent(await build(protocolFixture()), 1));
    assert.equal(texts.filter((t) => t === 'Hold 3 minutes').length, 4);
  });

  it('a LEGACY single spaced ring is drawn too (one more stroked circle per view than the new model alone would give)', async () => {
    const render = protocolFixture();
    const content = await pageContent(await build(render), 1);
    assert.ok(content.length > 0);
    const legacyOnly = protocolFixture({ canvases: [{ viewKey: 'left_front', label: 'Left Front', width: 1586, height: 1982, background: { url: '/x.png' }, objects: [(() => { const d = mk('dot', 'left_front'); return { ...d, ...M.patchRingEnabled(d, true), id: 'l', zIndex: 1 }; })()] }] });
    const c = await pageContent(await build(legacyOnly), 1);
    assert.equal(countOps(c, 'c'), 8, 'ring + dot = two circles');
  });

  it('JPEG backgrounds are accepted as well as PNG', async () => {
    const doc = await L.PDFDocument.load(await build(protocolFixture(), { loadImage: async () => JPEG }));
    assert.equal(doc.getPage(1).node.Resources().lookup(L.PDFName.of('XObject')).keys().length, 4);
  });

  it('a view whose image cannot be loaded (null, an error-free garbage buffer) is still drawn — markings and all — without a background', async () => {
    for (const loadImage of [async () => null, async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])]) {
      const bytes = await build(protocolFixture(), { loadImage });
      const doc = await L.PDFDocument.load(bytes);
      assert.equal(doc.getPageCount(), 2);
      const content = await pageContent(bytes, 1);
      assert.equal((content.match(/\/Im\d+ Do/g) || []).length, 0);
      assert.ok(countOps(content, 'c') > 100, 'markings are still there');
    }
  });

  it('a long description flows onto extra pages and none of it is lost', async () => {
    const words = Array.from({ length: 900 }, (_, i) => `word${i}`);
    const bytes = await build(protocolFixture({ protocol: { description: words.join(' ') } }));
    const doc = await L.PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() > 2, `pages: ${doc.getPageCount()}`);
    let all = '';
    for (let i = 0; i < doc.getPageCount(); i += 1) all += `${shownText(await pageContent(bytes, i)).join(' ')} `;
    assert.ok(all.includes('word0') && all.includes('word899'), 'first and last words both present');
    assert.match(all, /does not diagnose/, 'the disclaimer still comes with the details');
  });

  it('characters the standard font cannot show (emoji, other scripts) become "?" instead of failing the download', async () => {
    const bytes = await build(protocolFixture({ protocol: { displayName: 'Titel 日本語 😀', description: 'Ünïcödé café — “quotes” 😀 日本語' } }));
    const text = shownText(await pageContent(bytes, 0)).join('\n');
    assert.match(text, /Titel \?+ \?/);
    assert.match(text, /Ünïcödé café — “quotes”/);
  });

  it('a protocol with no category, conditions, description or version still builds, and does not print empty labels', async () => {
    const bytes = await build(protocolFixture({ protocol: { category: null, conditions: [], description: '', shortDescription: '', version: null } }));
    const text = shownText(await pageContent(bytes, 0)).join('\n');
    assert.doesNotMatch(text, /CATEGORY|CONDITION|VERSION|DESCRIPTION/);
    assert.match(text, /Back Pain — Test Protocol/);
  });

  it('a one-view (organ) protocol gets one view; no views at all gives just the details page', async () => {
    const one = protocolFixture({ canvases: [{ viewKey: 'heart', label: 'Heart', width: 1000, height: 1000, background: { url: '/heart.png' }, objects: [] }] });
    const d1 = await L.PDFDocument.load(await build(one));
    assert.equal(d1.getPageCount(), 2);
    assert.ok(shownText(await pageContent(await build(one), 1)).includes('HEART'));
    const none = await L.PDFDocument.load(await build(protocolFixture({ canvases: [] })));
    assert.equal(none.getPageCount(), 1);
  });

  it('builds the same content every time from the same published data (nothing random or time-dependent in the pages)', async () => {
    const a = await build(protocolFixture());
    const b = await build(protocolFixture());
    assert.equal(await pageContent(a, 0), await pageContent(b, 0));
    assert.equal(await pageContent(a, 1), await pageContent(b, 1));
  });

  it('does not modify the published data it is given', async () => {
    const render = protocolFixture();
    const before = JSON.stringify(render);
    await build(render);
    assert.equal(JSON.stringify(render), before);
  });

  it('every page has a footer with its number', async () => {
    const bytes = await build(protocolFixture());
    for (let i = 0; i < 2; i += 1) assert.match(shownText(await pageContent(bytes, i)).join('\n'), new RegExp(`page ${i + 1} of 2`));
  });
});

// ================================================================================================ 3. independent validators
const tool = (name) => { const r = spawnSync(name, ['--version'], { encoding: 'utf8' }); return !r.error && (r.status === 0 || r.stdout || r.stderr); };
describe('[DETERMINISTIC] independent validation with real PDF tools (runs wherever they are installed)', () => {
  let file;
  before(async () => { file = join(mkdtempSync(join(tmpdir(), 'pdftest-')), 'protocol.pdf'); writeFileSync(file, await build(protocolFixture(), { shareUrl: 'https://clinic.example/protocols/back-pain' })); });

  it('qpdf --check finds no structural errors', { skip: !tool('qpdf') && 'qpdf is not installed' }, () => {
    const r = spawnSync('qpdf', ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /No syntax or stream encoding errors found/);
  });

  it('pdftotext can read it: title, conditions, all four view labels and the disclaimer come back out', { skip: !tool('pdftotext') && 'pdftotext is not installed' }, () => {
    const r = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const t = r.stdout.replace(/\s+/g, ' ');
    ['Back Pain — Test Protocol', 'Back Pain, Sciatica', 'LEFT FRONT', 'RIGHT FRONT', 'LEFT BACK', 'RIGHT BACK', 'Hold 3 minutes', 'does not diagnose'].forEach((s) => assert.ok(t.includes(s), s));
  });

  it('pdftoppm can render both pages to images (the content streams are valid drawing code)', { skip: !tool('pdftoppm') && 'pdftoppm is not installed' }, () => {
    const out = join(tmpdir(), `pdfrender-${process.pid}`);
    const r = spawnSync('pdftoppm', ['-r', '30', '-png', file, out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(`${out}-1.png`).length > 500 && readFileSync(`${out}-2.png`).length > 500);
  });
});
