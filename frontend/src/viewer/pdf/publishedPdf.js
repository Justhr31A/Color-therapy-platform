import api, { baseURL } from '../../api/client';
import { buildProtocolPdf, downloadPdfFile } from './buildPdf';
import { publicProtocolUrl } from '../shareLink';

/**
 * "Download PDF" from the Studio: the PDF of the PUBLISHED version of a protocol.
 *
 * It is built from the PUBLIC render endpoint (/api/public/protocols/:slug/render) — the immutable published snapshot —
 * and never from the draft, the Studio's unsaved state or the working copy. So editing after publishing cannot leak
 * into the PDF, and the PDF is exactly what the public page and the shared link show. The same buildProtocolPdf
 * the public page uses does the drawing.
 */

/** A filesystem-safe name from the protocol's own name (falls back to its slug). */
export function pdfFileBase(protocol) {
  const safe = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return safe(protocol && (protocol.displayName || protocol.name)) || safe(protocol && protocol.slug) || 'protocol';
}

export async function fetchPublishedRender(slug) {
  const res = await api.get(`/public/protocols/${encodeURIComponent(slug)}/render`);
  return res.data;
}

/**
 * @param {{slug: string, name?: string, displayName?: string|null}} protocol
 * @param {object} [options] origin: the site origin for the printed link; fetchRender/build/save: replaceable for tests
 * @returns {Promise<{fileName: string, version: number|null, bytes: Uint8Array}>}
 */
export async function downloadPublishedPdf(protocol, { origin, fetchRender = fetchPublishedRender, build = buildProtocolPdf, save = downloadPdfFile } = {}) {
  if (!protocol || !protocol.slug) throw new Error('This protocol has no public link yet. Publish it first.');
  const render = await fetchRender(protocol.slug);
  const bytes = await build(render, { imageBaseUrl: baseURL, shareUrl: publicProtocolUrl(protocol.slug, origin) });
  const base = pdfFileBase(protocol);
  save(bytes, base);
  const version = render && render.protocol && render.protocol.version ? render.protocol.version.number : null;
  return { fileName: `${base}.pdf`, version, bytes };
}
