/**
 * [DETERMINISTIC SOFTWARE TESTS] the public download builder (src/viewer/buildDownload.js) — the REAL module.
 * Runs in plain Node, which has no `fetch`/`FileReader`: that is itself a useful, real test of the documented
 * fallback (a missing/failing image must never stop the rest of the file from building).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProtocolDownloadHtml, downloadHtmlFile } from '../src/viewer/buildDownload.js';

const render = {
  protocol: {
    name: 'headache-relief', displayName: 'Headache Relief', shortDescription: 'Short',
    description: 'A gentle protocol for tension headaches. Repeat daily.',
    category: { slug: 'head', name: 'Head & Neck' },
    conditions: [{ slug: 'migraine', name: 'Migraine' }, { slug: 'tension', name: 'Tension Headache' }],
    version: { number: 3, publishedAt: '2026-09-01T00:00:00Z' },
  },
  canvases: [
    { viewKey: 'left_front', label: 'Left Front', width: 1586, height: 1982, background: { url: '/static/hands/left_front.png' }, objects: [{ type: 'dot', x: 0.4, y: 0.5, width: 0.03, color: '#e5484d', opacity: 1, zIndex: 1, metadata: {} }] },
    { viewKey: 'right_front', label: 'Right Front', width: 1585, height: 1983, background: { url: '/static/hands/right_front.png' }, objects: [] },
  ],
};

describe('[DETERMINISTIC] building the downloadable protocol file', () => {
  it('includes the protocol name, category, conditions, description and version', async () => {
    const html = await buildProtocolDownloadHtml(render, 'https://example.test');
    assert.match(html, /<title>Headache Relief/);
    assert.match(html, /<h1>Headache Relief<\/h1>/);
    assert.match(html, /Head &amp; Neck/);
    assert.match(html, /Migraine, Tension Headache/);
    assert.match(html, /A gentle protocol for tension headaches\. Repeat daily\./);
    assert.match(html, />v3</);
  });

  it('embeds one view card per canvas, each carrying that view\'s actual markings (via the same renderer as the page)', async () => {
    const html = await buildProtocolDownloadHtml(render, 'https://example.test');
    assert.equal((html.match(/class="view-card"/g) || []).length, 2);
    assert.match(html, /Left Front/);
    assert.match(html, /Right Front/);
    assert.match(html, /fill="#e5484d"/, 'the dot from the left_front view is actually drawn');
  });

  it('an unreachable background image does not stop the file from building', async () => {
    // example.test is a reserved, non-resolving domain (RFC 2606): this genuinely fails to fetch, exercising
    // the real fallback path rather than a mocked one.
    const html = await buildProtocolDownloadHtml(render, 'https://example.test');
    assert.match(html, /<svg /, 'the SVG (with its markings) still renders without a background image');
    assert.doesNotMatch(html, /<image/, 'no image element when no data URI could be produced');
  });

  it('protocol text is escaped — a hostile description cannot break out of the HTML', async () => {
    const hostile = { ...render, protocol: { ...render.protocol, description: '</div><script>alert(1)</script>' } };
    const html = await buildProtocolDownloadHtml(hostile, 'https://example.test');
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('a protocol with no conditions or category shows a plain placeholder instead of breaking', async () => {
    const bare = { ...render, protocol: { ...render.protocol, category: null, conditions: [] } };
    const html = await buildProtocolDownloadHtml(bare, 'https://example.test');
    assert.match(html, /Category: —/);
    assert.match(html, /Condition: —/);
  });

  it('always includes the medical disclaimer', async () => {
    const html = await buildProtocolDownloadHtml(render, 'https://example.test');
    assert.match(html, /does not diagnose, treat, cure or prevent/);
  });
});

describe('[DETERMINISTIC] triggering the browser download', () => {
  it('creates a downloadable link named after the protocol and cleans up after itself', () => {
    const created = [];
    const clicks = [];
    const revoked = [];
    const fakeAnchor = { set href(v) { this._href = v; }, get href() { return this._href; }, set download(v) { this._download = v; }, get download() { return this._download; }, click: () => clicks.push(fakeAnchor) };
    const originalDoc = globalThis.document;
    const originalURL = globalThis.URL;
    const originalBlob = globalThis.Blob;
    globalThis.document = {
      createElement: (tag) => { created.push(tag); return fakeAnchor; },
      body: { appendChild: () => {}, },
    };
    fakeAnchor.remove = () => {};
    globalThis.URL = { ...originalURL, createObjectURL: () => 'blob:fake', revokeObjectURL: (u) => revoked.push(u) };
    globalThis.Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };
    try {
      downloadHtmlFile('<html></html>', 'headache-relief');
      assert.deepEqual(created, ['a']);
      assert.equal(fakeAnchor.download, 'headache-relief.html');
      assert.equal(fakeAnchor.href, 'blob:fake');
      assert.equal(clicks.length, 1);
      assert.deepEqual(revoked, ['blob:fake']);
    } finally {
      globalThis.document = originalDoc;
      globalThis.URL = originalURL;
      globalThis.Blob = originalBlob;
    }
  });
});
