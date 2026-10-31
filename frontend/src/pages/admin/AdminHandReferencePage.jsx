import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { baseURL } from '../../api/client';
import {
  BUILT_IN_REFERENCE_LANDMARKS, LANDMARK_NAMES, LOCAL_OVERRIDE_KEY, REFERENCE_VIEW_KEYS, readLocalOverride, isValidLandmarkTable,
} from '../../tracking/referenceLandmarks';
import { BONES, PALM_POLYGON } from '../../tracking/handSkeleton';

const VIEW_LABELS = { left_front: 'Left Front', right_front: 'Right Front', left_back: 'Left Back', right_back: 'Right Back' };
const r4 = (n) => Math.round(n * 10000) / 10000;

/** Deep copy of the built-in tables merged with an override. */
export function startingTables(override = null) {
  return Object.fromEntries(REFERENCE_VIEW_KEYS.map((k) => [k, (override && isValidLandmarkTable(override[k]) ? override[k] : BUILT_IN_REFERENCE_LANDMARKS[k]).map(([x, y]) => [x, y])]));
}

/** Largest change of any point from the built-in table, per view (normalized units). */
export function changesFromBuiltIn(tables) {
  return Object.fromEntries(REFERENCE_VIEW_KEYS.map((k) => [k, Math.max(...tables[k].map(([x, y], i) => Math.hypot(x - BUILT_IN_REFERENCE_LANDMARKS[k][i][0], y - BUILT_IN_REFERENCE_LANDMARKS[k][i][1])))]));
}

/** The JSON an engineer pastes into BUILT_IN_REFERENCE_LANDMARKS (src/tracking/referenceLandmarks.js). */
export function exportTables(tables) {
  return JSON.stringify(Object.fromEntries(REFERENCE_VIEW_KEYS.map((k) => [k, tables[k].map(([x, y]) => [r4(x), r4(y)])])), null, 1);
}

/**
 * The editor as a pure function of state. `dims` = { width, height } of the selected view's PNG (null while loading).
 */
export function AdminHandReferenceView({ tables, viewKey, dims, selected, onSelectView, onPointerDown, svgRef, previewActive, onPreview, onClearPreview, onReset, onDownload, changes, status }) {
  const pts = tables[viewKey];
  const W = dims ? dims.width : 1000; const H = dims ? dims.height : 1250;
  const P = pts.map(([x, y]) => ({ x: x * W, y: y * H }));
  const rad = W * 0.012;
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Hand reference skeleton</h1>
          <p className="muted small">
            The 21 points the camera uses to attach markings to each hand diagram (MediaPipe order). Drag a point onto the drawn
            joint it names. Changes stay on this device until an engineer commits the exported file.
          </p>
        </div>
        <Link to="/dashboard" className="btn">← Dashboard</Link>
      </header>
      <nav className="row-actions" aria-label="Hand view">
        {REFERENCE_VIEW_KEYS.map((k) => (
          <button key={k} type="button" className={`btn ${k === viewKey ? 'primary' : ''}`} onClick={() => onSelectView(k)}>
            {VIEW_LABELS[k]}{changes[k] > 0.0005 ? ' •' : ''}
          </button>
        ))}
      </nav>
      <div className="handref-layout">
        <svg ref={svgRef} className="handref-svg" viewBox={`0 0 ${W} ${H}`} data-testid="handref-svg" role="img" aria-label={`${VIEW_LABELS[viewKey]} reference skeleton`}>
          {dims && <image href={`${baseURL}/static/hands/${viewKey}.png`} x="0" y="0" width={W} height={H} />}
          <polygon points={PALM_POLYGON.map((i) => `${P[i].x},${P[i].y}`).join(' ')} fill="rgba(26,115,232,0.08)" stroke="rgba(26,115,232,0.5)" strokeWidth={rad * 0.3} />
          {BONES.map((b) => <line key={b.id} x1={P[b.a].x} y1={P[b.a].y} x2={P[b.b].x} y2={P[b.b].y} stroke="#1a73e8" strokeWidth={rad * 0.45} />)}
          {P.map((p, i) => (
            <g key={i} onPointerDown={(e) => onPointerDown(e, i)} style={{ cursor: 'grab' }} data-testid="handref-point">
              <circle cx={p.x} cy={p.y} r={rad} fill={i === selected ? '#ff2d55' : '#e5484d'} stroke="#fff" strokeWidth={rad * 0.25} />
              <text x={p.x + rad * 1.3} y={p.y + rad * 0.4} fontSize={rad * 1.6} fill="#b00020">{i}</text>
            </g>
          ))}
        </svg>
        <aside className="handref-side">
          <p><strong>{selected != null ? `${selected} · ${LANDMARK_NAMES[selected].replace('_', ' ')}` : 'Select a point'}</strong></p>
          {selected != null && <p className="muted small">x {r4(pts[selected][0])} · y {r4(pts[selected][1])}</p>}
          <div className="row-actions">
            <button type="button" className="btn primary" onClick={onPreview}>Preview on this device</button>
            <button type="button" className="btn" onClick={onClearPreview} disabled={!previewActive}>Stop preview</button>
            <button type="button" className="btn" onClick={onReset}>Reset this view</button>
            <button type="button" className="btn" onClick={onDownload}>Download JSON</button>
          </div>
          <p className="muted small">{previewActive ? 'This device is using your edited skeleton on the camera.' : 'The camera on this device uses the built-in skeleton.'}</p>
          {status && <p className="small" role="status">{status}</p>}
          <ol className="muted small handref-legend">
            <li>Wrist: the centre of the wrist crease.</li>
            <li>Finger joints: on the drawn creases (front) or knuckle lines (back), on the finger's centre line.</li>
            <li>MCP: the knuckle, just below where the finger meets the palm.</li>
            <li>Tips: just inside the end of the finger.</li>
          </ol>
          <p className="muted small">To make a change permanent for everyone: Download JSON and replace the tables in <code>frontend/src/tracking/referenceLandmarks.js</code>, then run the tests and the benchmark (docs/HAND_AR_ACCURACY.md).</p>
        </aside>
      </div>
    </div>
  );
}

/** /admin/hand-reference — admin-only editor for the reference skeletons (device-local preview + JSON export). */
export default function AdminHandReferencePage() {
  const [tables, setTables] = useState(() => startingTables(readLocalOverride()));
  const [viewKey, setViewKey] = useState('left_front');
  const [dims, setDims] = useState(null);
  const [selected, setSelected] = useState(null);
  const [previewActive, setPreviewActive] = useState(() => Boolean(readLocalOverride()));
  const [status, setStatus] = useState('');
  const svgRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setDims(null);
    const img = new Image();
    img.onload = () => { if (!cancelled) setDims({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { if (!cancelled) setStatus('The hand image could not be loaded.'); };
    img.src = `${baseURL}/static/hands/${viewKey}.png`;
    return () => { cancelled = true; };
  }, [viewKey]);

  useEffect(() => {
    const move = (e) => {
      const d = dragRef.current; const svg = svgRef.current;
      if (d == null || !svg || !dims) return;
      const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      const x = Math.min(1, Math.max(0, p.x / dims.width)); const y = Math.min(1, Math.max(0, p.y / dims.height));
      setTables((t) => ({ ...t, [viewKey]: t[viewKey].map((q, i) => (i === d ? [x, y] : q)) }));
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [viewKey, dims]);

  const save = (t) => {
    try { window.localStorage.setItem(LOCAL_OVERRIDE_KEY, JSON.stringify(t)); return true; } catch (e) { return false; }
  };

  return (
    <AdminHandReferenceView
      tables={tables} viewKey={viewKey} dims={dims} selected={selected} svgRef={svgRef} previewActive={previewActive}
      changes={changesFromBuiltIn(tables)} status={status}
      onSelectView={(k) => { setViewKey(k); setSelected(null); }}
      onPointerDown={(e, i) => { e.preventDefault(); dragRef.current = i; setSelected(i); }}
      onPreview={() => { const ok = save(tables); setPreviewActive(ok); setStatus(ok ? 'Saved on this device. Open a protocol camera here to try it.' : 'This browser blocked storage; preview is unavailable.'); }}
      onClearPreview={() => { try { window.localStorage.removeItem(LOCAL_OVERRIDE_KEY); } catch (e) { /* ignore */ } setPreviewActive(false); setStatus('Preview stopped.'); }}
      onReset={() => { setTables((t) => ({ ...t, [viewKey]: BUILT_IN_REFERENCE_LANDMARKS[viewKey].map(([x, y]) => [x, y]) })); setStatus(`${viewKey} reset to built-in (not yet saved for preview).`); }}
      onDownload={() => {
        const blob = new Blob([exportTables(tables)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'reference-landmarks.json';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }}
    />
  );
}
