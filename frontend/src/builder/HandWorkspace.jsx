import { useEffect, useRef, useState } from 'react';
import useProtocolStore from './store';
import HandCanvas from './HandCanvas';

const GAP = 12;
const PAD = 12;
const HEADER = 34;

/**
 * The 2x2 authoring workspace: every view of the protocol on screen at once (Left Front / Right Front on top,
 * Left Back / Right Back below, in the order the API returns them). One protocol, several canvases — nothing
 * here creates a separate protocol per hand. `focusedCanvasId` shows a single view large for fine work.
 * A protocol with a different number of views (e.g. an organ protocol) simply lays out what it has.
 */
export default function HandWorkspace({ readOnly = false, showGrid = false, focusedCanvasId = null, onFocusCanvas }) {
  const canvases = useProtocolStore((s) => s.canvases);
  const activeCanvasId = useProtocolStore((s) => s.activeCanvasId);
  const selectedObjectId = useProtocolStore((s) => s.selectedObjectId);
  const containerRef = useRef(null);
  const [box, setBox] = useState({ w: 900, h: 700 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setBox({ w: Math.max(320, r.width), h: Math.max(320, r.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visible = focusedCanvasId ? canvases.filter((c) => c.id === focusedCanvasId) : canvases;
  const cols = visible.length <= 1 ? 1 : 2;
  const rows = Math.max(1, Math.ceil(visible.length / cols));
  const cellW = (box.w - PAD * 2 - GAP * (cols - 1)) / cols;
  const cellH = (box.h - PAD * 2 - GAP * (rows - 1)) / rows - HEADER;
  const selectedCanvasId = (canvases.find((c) => c.objects.some((o) => o.id === selectedObjectId)) || {}).id;

  return (
    <div className="studio-workspace" ref={containerRef}>
      <div className="studio-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: GAP, padding: PAD }}>
        {visible.map((canvas) => (
          <section
            key={canvas.id}
            className={`studio-cell ${canvas.id === activeCanvasId && !readOnly ? 'active' : ''} ${canvas.id === selectedCanvasId ? 'has-selection' : ''}`}
            aria-label={canvas.backgroundLabel}
          >
            <header className="studio-cell-header" style={{ height: HEADER }}>
              <strong className="studio-cell-label">{canvas.backgroundLabel.toUpperCase()}</strong>
              <span className="badge" title="Objects on this view">{canvas.objects.length}</span>
              {canvas.isPlaceholderAsset && <span className="pill warn">Placeholder image</span>}
              <span className="topbar-spacer" />
              {!readOnly && canvases.length > 1 && onFocusCanvas && (
                <button type="button" className="btn small" onClick={() => onFocusCanvas(focusedCanvasId ? null : canvas.id)}>
                  {focusedCanvasId ? 'Show all four' : 'Enlarge'}
                </button>
              )}
            </header>
            <div className="studio-cell-body">
              <HandCanvas canvas={canvas} maxWidth={cellW} maxHeight={cellH} readOnly={readOnly} showGrid={showGrid} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
