/**
 * Builds one self-contained, offline-viewable HTML file for a published protocol: its name, condition,
 * description and every hand view with its markings — drawn with the SAME `svgForCanvas` function the
 * on-screen public page uses (see HandViewsViewer.jsx). There is no second renderer here, only a different
 * container for the exact same markup, with the background images embedded as data URIs so the file needs no
 * server to open later. HTML rather than a binary format because it needs zero new dependencies, opens in any
 * browser, and can be printed to PDF by the browser's own "Print" dialog — a real, working first format that
 * a PDF/PNG exporter could sit behind later without this function, or its caller, changing.
 *
 * `render` is exactly the object `GET /api/public/protocols/:slug/render` returns — the published snapshot,
 * never a draft (see PublicProtocolDetailsPage.jsx, which only ever calls this with that endpoint's response).
 */
import { svgForCanvas } from './renderMarkings';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Fetches an image URL and returns it as a `data:` URI, or null if it can't be fetched (the file still builds without it). */
async function toDataUri(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return null;
  }
}

/** Builds the downloadable HTML document as a string. Never throws on a missing image — that view just has no background. */
export async function buildProtocolDownloadHtml(render, imageBaseUrl) {
  const p = render.protocol;
  const canvases = await Promise.all(
    (render.canvases || []).map(async (c) => {
      const url = c.background && c.background.url ? `${imageBaseUrl}${c.background.url}` : null;
      const dataUri = url ? await toDataUri(url) : null;
      return { canvas: c, svg: svgForCanvas(c, dataUri) };
    })
  );

  const conditions = (p.conditions || []).map((c) => esc(c.name)).join(', ') || '—';
  const category = p.category ? esc(p.category.name) : '—';
  const version = p.version ? `v${p.version.number}` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(p.displayName || p.name)} — Colour Therapy Protocol</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2328; max-width: 960px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  .meta { color: #6b7280; font-size: 14px; margin-bottom: 24px; }
  .meta span { margin-right: 16px; }
  .description { font-size: 15px; line-height: 1.6; margin-bottom: 32px; }
  .views { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
  .view-card { border: 1px solid #e1e4e8; border-radius: 12px; padding: 12px; text-align: center; }
  .view-card svg { width: 100%; height: auto; display: block; }
  .view-card figcaption { margin-top: 8px; font-weight: 600; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: #374151; }
  .disclaimer { margin-top: 40px; padding: 16px; background: #f5f6f8; border-radius: 10px; font-size: 12px; color: #6b7280; line-height: 1.6; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <h1>${esc(p.displayName || p.name)}</h1>
  <div class="meta"><span>Category: ${category}</span><span>Condition: ${conditions}</span>${version ? `<span>${esc(version)}</span>` : ''}</div>
  ${p.description ? `<div class="description">${esc(p.description)}</div>` : ''}
  <div class="views">
    ${canvases.map(({ canvas, svg }) => `<figure class="view-card">${svg}<figcaption>${esc(canvas.label || canvas.viewKey)}</figcaption></figure>`).join('\n    ')}
  </div>
  <p class="disclaimer">This document is informational only. It does not diagnose, treat, cure or prevent any condition, and is not a substitute for professional medical advice. Consult a qualified healthcare provider for any medical concern.</p>
</body>
</html>`;
}

/** Triggers the browser's download for a built HTML string, named after the protocol's slug. */
export function downloadHtmlFile(html, filenameBase) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameBase || 'protocol'}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
