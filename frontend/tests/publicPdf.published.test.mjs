/**
 * [DETERMINISTIC SOFTWARE TESTS — real backend service + real PostgreSQL + the real PDF builder]
 * The PDF (and so the public page and the shared link) is built from the PUBLISHED, immutable snapshot only:
 * editing the draft after publishing changes nothing in it, and only publishing again does. An unpublished protocol
 * has no public data at all, so there is nothing to build a PDF from. Needs TEST_DATABASE_URL (a disposable PostgreSQL server); without it this test FAILS.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildProtocolPdf } from '../src/viewer/pdf/buildPdf.js';
import { fmt, parseColor } from '../src/viewer/pdf/primitivesToPdf.js';
import { downloadPublishedPdf } from '../src/viewer/pdf/publishedPdf.js';
import * as M from '../src/builder/model/objectModel.js';

const require = createRequire(import.meta.url);
const { missingReason } = require('../../backend/tests/helpers/testDb.js');
const SKIP = missingReason('pg', 'uuid');
const PNG = new Uint8Array(Buffer.from(JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/tinyImages.json', import.meta.url)), 'utf8')).png, 'base64'));

let L; let env;
before(async () => {
  const mod = await import('pdf-lib'); L = mod.PDFDocument ? mod : mod.default;
  if (!SKIP) env = await require('../../backend/tests/helpers/publishingEnv.js').makeEnv();
});
after(async () => { if (env) await env.cleanup(); });

const ctx = { viewKey: 'left_front', canvasWidth: 1586, canvasHeight: 1982 };
/** A Dot + two attached rings whose second ring has the given colour; the rest is fixed. */
function dotWithRings(ring2Color, extra = {}) {
  let o = M.createStudioObject('dotRing', 0.5, 0.5, ctx);
  o = { ...o, ...M.addRing(o) };
  o = { ...o, ...M.patchRingAt(o, 0, { color: '#1a73e8', thickness: 12 }) };
  o = { ...o, ...M.patchRingAt(o, 1, { color: ring2Color, thickness: 20, outline: { enabled: true, color: '#111111', thickness: 5 } }) };
  return { ...o, ...extra };
}
async function content(bytes, index) {
  const doc = await L.PDFDocument.load(bytes);
  return doc.getPage(index).node.Contents().asArray().map((r) => Buffer.from(L.decodePDFRawStream(doc.context.lookup(r)).decode()).toString('latin1')).join('\n');
}
const strokeOf = (hex) => `${(({ r, g, b }) => `${fmt(r)} ${fmt(g)} ${fmt(b)}`)(parseColor(hex))} RG`;
const pdfFor = (render) => buildProtocolPdf(render, { imageBaseUrl: '', loadImage: async () => PNG });
const newProtocol = async (name) => (await env.protocols.create({ name }, env.actor));

describe('[DETERMINISTIC] the PDF and the shared link use the published snapshot only', { skip: SKIP }, () => {
  it('a DRAFT has no public data: the public render does not exist, so there is nothing to build a PDF or a link from', async () => {
    const id = (await newProtocol('Draft only'));
    (await env.setObjects(id, 0, [dotWithRings('#46a758')]));
    const slug = (await env.protocols.getFull(id)).slug;
    assert.equal((await env.publicSvc.getRender(slug)), null, 'an unpublished protocol has no public render (the route answers 404)');
    assert.equal((await env.publicSvc.getDetail(slug)), null, 'nor any public detail');
  });

  it('the PDF carries the PUBLISHED markings; editing the draft afterwards changes nothing in it', async () => {
    const id = (await newProtocol('Frozen pdf'));
    (await env.setObjects(id, 0, [dotWithRings('#46a758')]));
    (await env.protocols.publish(id, env.actor, {}));
    const slug = (await env.protocols.getFull(id)).slug;

    const published = await pdfFor((await env.publicSvc.getRender(slug)));
    const publishedContent = await content(published, 1);
    assert.ok(publishedContent.includes(strokeOf('#46a758')), 'the published ring colour is in the PDF');
    assert.ok(publishedContent.includes('\n30 w\n'), 'ring 2 outline underlay: 20 + 2 × 5');

    // the doctor now edits the DRAFT: different ring colour, no outline, one ring fewer
    const edited = dotWithRings('#d6409f');
    edited.metadata.rings = [{ color: '#d6409f', thickness: 99 }];
    (await env.setObjects(id, 0, [edited]));
    assert.equal((await env.protocols.getFull(id)).hasUnpublishedChanges, true);

    const stillPublished = await pdfFor((await env.publicSvc.getRender(slug)));
    assert.equal(await content(stillPublished, 1), publishedContent, 'the PDF is byte-for-byte the same content as before the edit');
    assert.ok(!(await content(stillPublished, 1)).includes(strokeOf('#d6409f')), 'the draft colour never appears');
  });

  it('publishing AGAIN is what changes the PDF — and then the old published markings are gone from it', async () => {
    const id = (await newProtocol('Republish pdf'));
    (await env.setObjects(id, 0, [dotWithRings('#46a758')]));
    (await env.protocols.publish(id, env.actor, {}));
    const slug = (await env.protocols.getFull(id)).slug;
    const v1 = await content(await pdfFor((await env.publicSvc.getRender(slug))), 1);

    (await env.setObjects(id, 0, [dotWithRings('#d6409f')]));
    (await env.protocols.publish(id, env.actor, {}));
    const v2 = await content(await pdfFor((await env.publicSvc.getRender(slug))), 1);

    assert.ok(v1.includes(strokeOf('#46a758')) && !v1.includes(strokeOf('#d6409f')));
    assert.ok(v2.includes(strokeOf('#d6409f')) && !v2.includes(strokeOf('#46a758')));
  });

  it('the PDF names the published VERSION, and the link slug is the same one the public route serves', async () => {
    const id = (await newProtocol('Versioned pdf'));
    (await env.setObjects(id, 0, [dotWithRings('#46a758')]));
    (await env.protocols.publish(id, env.actor, {}));
    const full = (await env.protocols.getFull(id));
    const render = (await env.publicSvc.getRender(full.slug));
    const bytes = await pdfFor(render);
    const doc = await L.PDFDocument.load(bytes);
    assert.match(doc.getTitle(), /Versioned pdf/);
    const first = (await content(bytes, 0));
    const text = [...first.matchAll(/<([0-9a-fA-F]*)>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('\n');
    assert.match(text, new RegExp(`v${render.protocol.version.number}`));
    assert.ok((await env.publicSvc.getDetail(full.slug)), 'the same slug opens the public protocol');
  });

  it('every ring and outline of the published object reaches the PDF unchanged (no ring dropped, none invented)', async () => {
    const id = (await newProtocol('Rings pdf'));
    let o = dotWithRings('#46a758');
    for (let i = 0; i < 6; i += 1) o = { ...o, ...M.addRing(o) };
    (await env.setObjects(id, 0, [o]));
    (await env.protocols.publish(id, env.actor, {}));
    const render = (await env.publicSvc.getRender((await env.protocols.getFull(id)).slug));
    assert.equal(render.canvases[0].objects[0].metadata.rings.length, 8);
    const pageContent = await content(await pdfFor({ ...render, canvases: [render.canvases[0]] }), 1);
    // 8 rings + 1 outline underlay + the dot (plus its outline-less halo) -> stroke-only circles are the rings and the underlay
    const strokeOnly = (pageContent.match(/\nh\nS\n/g) || []).length;
    assert.equal(strokeOnly, 8 + 1, '8 rings and one ring outline underlay');
  });
});

// ------------------------------------------------------------------------------------------------------------------
// The Studio's "Download PDF" (downloadPublishedPdf) against the real backend service and database.
// The server answers the public render with 404 for anything not published; the helper below does the same.
// ------------------------------------------------------------------------------------------------------------------
describe('[DETERMINISTIC] the Studio "Download PDF" is the PUBLISHED version, from the real backend', { skip: SKIP }, () => {
  const fetchRenderLikeTheApi = (slug) => async () => {
    const render = (await env.publicSvc.getRender(slug));
    if (!render) throw Object.assign(new Error('Protocol not found.'), { status: 404 });
    return render;
  };
  const download = async (protocolRow, slug) => {
    let saved = null;
    const result = await downloadPublishedPdf(
      { slug, name: protocolRow.name, displayName: protocolRow.displayName },
      { origin: 'https://clinic.example', fetchRender: fetchRenderLikeTheApi(slug), build: (render, options) => buildProtocolPdf(render, { ...options, loadImage: async () => PNG }), save: (bytes, base) => { saved = { bytes, base }; } },
    );
    return { result, saved };
  };

  it('publish -> download: the PDF carries the published markings, version and public link, under the protocol\'s name', async () => {
    const id = (await newProtocol('Studio Download Test'));
    (await env.setObjects(id, 0, [dotWithRings('#46a758')]));
    (await env.protocols.publish(id, env.actor, {}));
    const full = (await env.protocols.getFull(id));
    const { result, saved } = await download(full, full.slug);
    assert.equal(result.fileName, 'studio-download-test.pdf');
    assert.equal(saved.base, 'studio-download-test');
    assert.equal(Buffer.from(saved.bytes.slice(0, 5)).toString(), '%PDF-');
    assert.equal(result.version, full.published.version);
    const pdfContent = await content(saved.bytes, 1);
    assert.ok(pdfContent.includes(strokeOf('#46a758')), 'the published ring colour is in the PDF');
    const text = [...(await content(saved.bytes, 0)).matchAll(/<([0-9a-fA-F]*)>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('\n');
    assert.match(text, new RegExp(`v${full.published.version}`));
    assert.match(text, /https:\/\/clinic\.example\/protocols\/studio-download-test/);
  });

  it('EDITING AFTER PUBLISHING does not change the PDF; publishing again does (and only then)', async () => {
    const id = (await newProtocol('Studio Download Edits'));
    (await env.setObjects(id, 0, [dotWithRings('#46a758')]));
    (await env.protocols.publish(id, env.actor, {}));
    const slug = (await env.protocols.getFull(id)).slug;
    const first = await content((await download((await env.protocols.getFull(id)), slug)).saved.bytes, 1);

    const edited = dotWithRings('#d6409f');
    edited.metadata.rings = [{ color: '#d6409f', thickness: 77 }];
    (await env.setObjects(id, 0, [edited])); // the doctor edits the draft...
    assert.equal((await env.protocols.getFull(id)).hasUnpublishedChanges, true);
    const stillFirst = await content((await download((await env.protocols.getFull(id)), slug)).saved.bytes, 1);
    assert.equal(stillFirst, first, 'the PDF is unchanged by unsaved/unpublished edits');
    assert.ok(!stillFirst.includes(strokeOf('#d6409f')));

    (await env.protocols.publish(id, env.actor, {})); // ...and publishes again
    const second = await content((await download((await env.protocols.getFull(id)), slug)).saved.bytes, 1);
    assert.ok(second.includes(strokeOf('#d6409f')) && !second.includes(strokeOf('#46a758')));
  });

  it('a draft that was never published cannot be downloaded: a 404 reaches the caller and nothing is saved', async () => {
    const id = (await newProtocol('Studio Never Published'));
    (await env.setObjects(id, 0, [dotWithRings('#46a758')]));
    const full = (await env.protocols.getFull(id));
    let saved = false;
    await assert.rejects(
      () => downloadPublishedPdf({ slug: full.slug, name: full.name }, { fetchRender: fetchRenderLikeTheApi(full.slug), save: () => { saved = true; } }),
      (e) => e.status === 404,
    );
    assert.equal(saved, false);
  });

  it('an archived protocol is no longer public, so its PDF cannot be downloaded either', async () => {
    const id = (await newProtocol('Studio Archived'));
    (await env.setObjects(id, 0, [dotWithRings('#46a758')]));
    (await env.protocols.publish(id, env.actor, {}));
    const slug = (await env.protocols.getFull(id)).slug;
    assert.ok((await download((await env.protocols.getFull(id)), slug)).saved);
    (await env.protocols.archive(id));
    await assert.rejects(async () => download((await env.protocols.getFull(id)), slug), (e) => e.status === 404);
  });
});
