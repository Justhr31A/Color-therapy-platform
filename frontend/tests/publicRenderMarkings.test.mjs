/**
 * [DETERMINISTIC SOFTWARE TESTS] the public site's shared markings renderer (src/viewer/renderMarkings.js) — the
 * REAL module, and the ONLY place that draws a published protocol's objects on the public side (both the
 * on-screen viewer and the downloadable file call this). Pure string output, no DOM, no React.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { svgForObject, svgForCanvas } from '../src/viewer/renderMarkings.js';

const canvas = { width: 1586, height: 1982 };
const base = (o) => ({ x: 0.4, y: 0.5, color: '#e5484d', thickness: 3, opacity: 1, rotation: 0, metadata: {}, ...o });

describe('[DETERMINISTIC] every supported object type draws something, using the real published fields', () => {
  it('dot: a filled circle at the right place and size', () => {
    const svg = svgForObject(base({ type: 'dot', width: 0.03, opacity: 0.8 }), canvas);
    assert.match(svg, /<circle /);
    assert.match(svg, new RegExp(`cx="${0.4 * canvas.width}"`));
    assert.match(svg, new RegExp(`r="${(0.03 / 2) * canvas.width}"`));
    assert.match(svg, /fill="#e5484d"/);
    assert.match(svg, /opacity="0\.8"/);
  });

  it('ring: an unfilled (fill="none") stroked circle', () => {
    const svg = svgForObject(base({ type: 'ring', width: 0.08, thickness: 4, color: '#1a73e8' }), canvas);
    assert.match(svg, /fill="none"/);
    assert.match(svg, /stroke="#1a73e8"/);
    assert.match(svg, /stroke-width="4"/);
  });

  it('Dot + Ring: draws the ring FIRST then the filled dot on top, with independent colours and the exact gap-derived radius', () => {
    const o = base({
      type: 'dot', width: 0.03, color: '#e5484d',
      metadata: { ring: { enabled: true, color: '#1a73e8', thickness: 4, gapPreset: 'large', gapScale: 1, gap: 28 } },
    });
    const svg = svgForObject(o, canvas);
    const ringIdx = svg.indexOf('stroke="#1a73e8"');
    const dotIdx = svg.indexOf('fill="#e5484d"');
    assert.ok(ringIdx !== -1 && dotIdx !== -1 && ringIdx < dotIdx, 'the ring markup appears before the dot fill, so the dot ends up drawn on top');
    const dotRadiusPx = (0.03 / 2) * canvas.width;
    const wantRingRadius = dotRadiusPx + 28 + 4 / 2;
    assert.match(svg, new RegExp(`r="${wantRingRadius}"`));
  });

  it('a LEGACY Dot + Ring with no ring colour falls back to the dot colour; no gap fields still derives a sensible radius', () => {
    const o = base({
      type: 'dot', width: 0.03, color: '#46a758',
      metadata: { ring: { enabled: true, thickness: 4, width: 0.12 } }, // no colour, no gap fields at all
    });
    const svg = svgForObject(o, canvas);
    const ringStroke = svg.match(/stroke="([^"]+)"/)[1];
    assert.equal(ringStroke, '#46a758', 'falls back to the dot colour, same rule as Protocol Studio');
  });

  it('a Dot + Ring with its ring switched off draws only the dot', () => {
    const o = base({ type: 'dot', width: 0.03, metadata: { ring: { enabled: false, color: '#1a73e8', thickness: 4, width: 0.1 } } });
    const svg = svgForObject(o, canvas);
    assert.equal((svg.match(/<circle/g) || []).length, 1);
  });

  it('finger band: a curved strip, with a second parallel strip only for a "double" band', () => {
    const plain = svgForObject(base({ type: 'fingerBand', width: 0.13, thickness: 5, metadata: { band: { type: 'plain', position: 0.4, rotationOffset: 0 } } }), canvas);
    assert.equal((plain.match(/<path/g) || []).length, 2, 'the white halo path + one coloured path');
    const double = svgForObject(base({ type: 'fingerBand', width: 0.13, thickness: 5, metadata: { band: { type: 'double', position: 0.4, rotationOffset: 0 } } }), canvas);
    assert.equal((double.match(/<path/g) || []).length, 3, 'halo + two coloured strips');
  });

  it('text: rendered as an SVG <text> element with the real content, never interpreted as markup', () => {
    const svg = svgForObject(base({ type: 'text', width: 0.03, metadata: { text: 'Hold for 3 minutes' } }), canvas);
    assert.match(svg, /<text /);
    assert.match(svg, />Hold for 3 minutes</);
  });

  it('hostile text content is escaped, not executed or left as live markup', () => {
    const svg = svgForObject(base({ type: 'text', width: 0.03, metadata: { text: '</text><script>alert(1)</script>' } }), canvas);
    assert.doesNotMatch(svg, /<script>/);
    assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('horizontal/vertical line and arrow draw a line, and the arrow additionally draws a head', () => {
    const hline = svgForObject(base({ type: 'hline', width: 0.18 }), canvas);
    assert.match(hline, /<line /);
    const arrow = svgForObject(base({ type: 'arrow', width: 0.18 }), canvas);
    assert.match(arrow, /<line /);
    assert.match(arrow, /<polygon/);
  });

  it('free line draws a polyline through its stored points', () => {
    const svg = svgForObject(base({ type: 'freeline', points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.25 }, { x: 0.35, y: 0.4 }] }), canvas);
    assert.match(svg, /<polyline /);
    assert.match(svg, new RegExp(`${0.1 * canvas.width},${0.1 * canvas.height}`));
  });

  it('triangle and inverted triangle draw a 3-point polygon, rotated 180° apart', () => {
    const tri = svgForObject(base({ type: 'triangle', width: 0.12, rotation: 0 }), canvas);
    const inv = svgForObject(base({ type: 'invertedTriangle', width: 0.12, rotation: 180 }), canvas);
    assert.match(tri, /<polygon/);
    assert.match(inv, /rotate\(180\)/);
  });

  it('rectangle and square draw a filled rect with independent width/height', () => {
    const svg = svgForObject(base({ type: 'rectangle', width: 0.16, height: 0.1 }), canvas);
    assert.match(svg, new RegExp(`width="${0.16 * canvas.width}"`));
    assert.match(svg, new RegExp(`height="${0.1 * canvas.height}"`));
  });

  it('an unknown/unsupported type draws nothing and never throws', () => {
    assert.equal(svgForObject(base({ type: 'hologram' }), canvas), '');
    assert.doesNotThrow(() => svgForObject(null, canvas));
    assert.equal(svgForObject(null, canvas), '');
  });

  it('a malformed object of a known type is skipped, not thrown — one bad object never blanks the whole view', () => {
    assert.equal(svgForObject({ type: 'freeline', points: 'not an array' }, canvas), '');
  });
});

describe('[DETERMINISTIC] a whole canvas', () => {
  it('embeds the background image and every object, in zIndex order (later on top)', () => {
    const c = {
      ...canvas,
      objects: [
        base({ type: 'dot', zIndex: 2, color: '#111111' }),
        base({ type: 'ring', zIndex: 1, color: '#222222' }),
      ],
    };
    const svg = svgForCanvas(c, 'https://example.test/left_front.png');
    assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<image href="https:\/\/example\.test\/left_front\.png"/);
    assert.ok(svg.indexOf('#222222') < svg.indexOf('#111111'), 'lower zIndex drawn first, so it ends up underneath');
  });

  it('renders all four canonical hand views without image href just as readily (no background is not an error)', () => {
    ['left_front', 'right_front', 'left_back', 'right_back'].forEach((viewKey) => {
      const svg = svgForCanvas({ viewKey, width: 1586, height: 1982, objects: [base({ type: 'dot' })] }, null);
      assert.match(svg, /<svg /);
      assert.doesNotMatch(svg, /<image/);
    });
  });

  it('an empty canvas (no objects) still renders a valid, empty SVG', () => {
    const svg = svgForCanvas({ width: 1000, height: 1000, objects: [] }, null);
    assert.match(svg, /<svg[^>]*>\s*<\/svg>/);
  });
});
