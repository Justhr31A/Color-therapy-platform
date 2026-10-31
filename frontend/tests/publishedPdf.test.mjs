/**
 * [DETERMINISTIC SOFTWARE TESTS] "Download PDF" from the Studio (src/viewer/pdf/publishedPdf.js).
 * The PDF is the PUBLISHED version: built from the public render endpoint, never from the draft or unsaved edits.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import api, { baseURL } from './support/stubs/apiClient.mjs';
import { pdfFileBase, fetchPublishedRender, downloadPublishedPdf } from '../src/viewer/pdf/publishedPdf.js';

const RENDER = { protocol: { name: 'back-pain', displayName: 'Back pain relief', version: { number: 7, publishedAt: '2026-10-01T09:30:00Z' } }, canvases: [] };

describe('[DETERMINISTIC] the PDF file name comes from the protocol name', () => {
  it('uses the display name, else the name, else the slug, else a safe default', () => {
    assert.equal(pdfFileBase({ displayName: 'Back Pain — Website Test Protocol', name: 'x', slug: 's' }), 'back-pain-website-test-protocol');
    assert.equal(pdfFileBase({ displayName: null, name: 'Knee Pain', slug: 'knee-pain' }), 'knee-pain');
    assert.equal(pdfFileBase({ displayName: '', name: '   ', slug: 'only-slug' }), 'only-slug');
    assert.equal(pdfFileBase({ name: '日本語', slug: 'fallback-slug' }), 'fallback-slug', 'a name with no usable characters falls back to the slug');
    assert.equal(pdfFileBase({}), 'protocol');
    assert.equal(pdfFileBase(null), 'protocol');
  });
  it('is always safe as a file name: no path separators, spaces, dots or leading/trailing dashes', () => {
    ['../../etc/passwd', 'a/b\\c:d*e?f"g<h>i|j', '  spaced  out  ', '...', 'CON.txt'].forEach((name) => {
      const f = pdfFileBase({ name });
      assert.match(f, /^[a-z0-9]+(-[a-z0-9]+)*$|^protocol$/, `${name} -> ${f}`);
    });
  });
});

describe('[DETERMINISTIC] the PDF is built from the PUBLISHED snapshot', () => {
  beforeEach(() => api.reset());

  it('fetches ONLY the public render endpoint for the protocol\'s slug — never the draft, the Studio endpoints or an admin endpoint', async () => {
    api.handler = () => ({ data: RENDER });
    const got = await fetchPublishedRender('back-pain');
    assert.deepEqual(got, RENDER);
    assert.deepEqual(api.calls.map((c) => [c.method, c.url]), [['get', '/public/protocols/back-pain/render']]);
  });
  it('encodes the slug so it cannot change which endpoint is called', async () => {
    api.handler = () => ({ data: RENDER });
    await fetchPublishedRender('a/b?c');
    assert.equal(api.calls[0].url, '/public/protocols/a%2Fb%3Fc/render');
  });

  it('downloads: fetches the published render, builds the PDF from exactly that render, and saves it under the protocol name', async () => {
    const seen = {};
    const result = await downloadPublishedPdf({ slug: 'back-pain', name: 'back-pain', displayName: 'Back pain relief' }, {
      origin: 'https://clinic.example',
      fetchRender: async (slug) => { seen.slug = slug; return RENDER; },
      build: async (render, options) => { seen.render = render; seen.options = options; return new Uint8Array([37, 80, 68, 70]); },
      save: (bytes, base) => { seen.saved = { bytes, base }; },
    });
    assert.equal(seen.slug, 'back-pain');
    assert.equal(seen.render, RENDER, 'the PDF is built from the published render object, untouched');
    assert.deepEqual(seen.options, { imageBaseUrl: baseURL, shareUrl: 'https://clinic.example/protocols/back-pain' });
    assert.deepEqual(Array.from(seen.saved.bytes), [37, 80, 68, 70]);
    assert.equal(seen.saved.base, 'back-pain-relief');
    assert.deepEqual([result.fileName, result.version], ['back-pain-relief.pdf', 7]);
  });

  it('the printed link is the existing public route, never a Studio URL', async () => {
    let options;
    await downloadPublishedPdf({ slug: 'knee-pain', name: 'Knee Pain' }, { origin: 'https://clinic.example/', fetchRender: async () => RENDER, build: async (r, o) => { options = o; return new Uint8Array(); }, save: () => {} });
    assert.equal(options.shareUrl, 'https://clinic.example/protocols/knee-pain');
    assert.doesNotMatch(options.shareUrl, /builder|admin|studio/i);
  });

  it('a protocol with no slug (never published) is refused with a clear message and nothing is fetched', async () => {
    let fetched = false;
    for (const p of [null, undefined, {}, { slug: '' }]) {
      await assert.rejects(() => downloadPublishedPdf(p, { fetchRender: async () => { fetched = true; return RENDER; } }), /Publish it first/);
    }
    assert.equal(fetched, false);
  });

  it('if the published version cannot be fetched (404: unpublished or archived) nothing is built or saved, and the error reaches the caller', async () => {
    let built = false; let saved = false;
    const notFound = Object.assign(new Error('Protocol not found.'), { status: 404 });
    await assert.rejects(
      () => downloadPublishedPdf({ slug: 'gone', name: 'Gone' }, { fetchRender: async () => { throw notFound; }, build: async () => { built = true; return new Uint8Array(); }, save: () => { saved = true; } }),
      (e) => e.status === 404,
    );
    assert.deepEqual([built, saved], [false, false]);
  });

  it('if building the PDF fails, nothing is saved (no half-written file is offered)', async () => {
    let saved = false;
    await assert.rejects(() => downloadPublishedPdf({ slug: 's', name: 'S' }, { fetchRender: async () => RENDER, build: async () => { throw new Error('boom'); }, save: () => { saved = true; } }), /boom/);
    assert.equal(saved, false);
  });

  it('goes through the real API client path by default: one GET of the public render, then the real PDF builder', async () => {
    api.handler = () => ({ data: { protocol: { name: 'real', displayName: 'Real build', version: { number: 2, publishedAt: '2026-10-01T09:30:00Z' }, conditions: [], category: null }, canvases: [] } });
    let bytes;
    const result = await downloadPublishedPdf({ slug: 'real', name: 'real', displayName: 'Real build' }, { save: (b) => { bytes = b; } });
    assert.deepEqual(api.calls.map((c) => c.url), ['/public/protocols/real/render']);
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-', 'a genuine PDF');
    assert.deepEqual([result.fileName, result.version], ['real-build.pdf', 2]);
  });
});
