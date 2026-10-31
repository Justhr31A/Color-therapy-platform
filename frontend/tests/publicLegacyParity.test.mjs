/**
 * [DETERMINISTIC SOFTWARE TESTS] LEGACY RENDER PARITY — objects saved before outlines, multi-ring and XL existed must
 * render EXACTLY as they did before this change.
 *
 * tests/fixtures/legacyRenderGolden.json holds SVG captured from the PREVIOUS renderer (the git checkpoint taken at the
 * start of the Sharing/PDF task) for a corpus of old-style objects: every type, a dot with a legacy single spaced ring
 * (explicit gap, gap derived from width, colourless ring, disabled ring), bands, text, an unknown type, and one whole canvas.
 * The refactored renderer must reproduce it. Attribute ORDER inside a tag is not significant in SVG, so tags are compared
 * with their attributes sorted — everything else (values, element order, nesting, transforms, numbers) must match exactly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { svgForObject, svgForCanvas } from '../src/viewer/renderMarkings.js';

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/legacyRenderGolden.json', import.meta.url)), 'utf8'));

/** Same SVG, attributes of every tag sorted by name. */
function normalizeSvg(svg) {
  return svg.replace(/<([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g, (_, tag, attrs, close) => {
    const list = [...attrs.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => `${m[1]}="${m[2]}"`).sort();
    return `<${tag}${list.length ? ` ${list.join(' ')}` : ''}${close ? ' /' : ''}>`;
  });
}

describe('[DETERMINISTIC] legacy objects render exactly as before', () => {
  it('the golden corpus is non-trivial (guards against an accidentally empty fixture)', () => {
    assert.ok(golden.objects.length >= 20);
    assert.ok(golden.objects.some((e) => e.object.metadata && e.object.metadata.ring), 'includes legacy single-ring dots');
    assert.ok(golden.objects.every((e) => !(e.object.metadata && (e.object.metadata.outline || e.object.metadata.rings))), 'and nothing in it uses the new structures');
  });

  for (const entry of golden.objects) {
    it(`${entry.name}`, () => {
      assert.equal(normalizeSvg(svgForObject(entry.object, golden.canvas)), normalizeSvg(entry.svg));
    });
  }

  it('a whole canvas (z-order, background image, every type together) is identical', () => {
    assert.equal(normalizeSvg(svgForCanvas(golden.whole.canvas, golden.whole.imageHref)), normalizeSvg(golden.whole.svg));
  });

  it('the normaliser really does distinguish different SVG (it is not comparing everything as equal)', () => {
    assert.notEqual(normalizeSvg('<circle r="1" fill="red" />'), normalizeSvg('<circle r="2" fill="red" />'));
    assert.equal(normalizeSvg('<circle r="1" fill="red" />'), normalizeSvg('<circle fill="red" r="1" />'));
  });
});
