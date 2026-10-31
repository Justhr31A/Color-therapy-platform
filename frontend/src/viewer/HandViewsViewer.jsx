import { baseURL } from '../api/client';
import { svgForCanvas } from './renderMarkings';

/**
 * Read-only display of a published protocol's views and their markings — no selection, no dragging, no editing
 * affordance of any kind. Draws with the exact same `svgForCanvas` function the downloadable file uses (see
 * buildDownload.js), so what a visitor sees on the page and what they download are guaranteed to match.
 *
 * `canvases` is exactly what `GET /api/public/protocols/:slug/render` returns for `canvases` — this component
 * invents nothing about a protocol's markings; it only draws what the published snapshot says.
 */
export default function HandViewsViewer({ canvases }) {
  if (!canvases || canvases.length === 0) return null;
  return (
    <div className="pv-views-grid" data-view-count={canvases.length}>
      {canvases.map((canvas) => {
        const imageHref = canvas.background && canvas.background.url ? `${baseURL}${canvas.background.url}` : null;
        return (
          <figure className="pv-view-card" key={canvas.viewKey}>
            {/* svgForCanvas escapes every piece of text it embeds (see renderMarkings.js's `esc`), so injecting
                its output here can never execute anything a doctor typed into a Text object's content. */}
            <div className="pv-view-image" dangerouslySetInnerHTML={{ __html: svgForCanvas(canvas, imageHref) }} />
            <figcaption>{canvas.label || canvas.viewKey}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}
