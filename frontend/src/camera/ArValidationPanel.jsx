import { useRef, useState } from 'react';
import { createValidationSession, nearestMarking } from '../tracking/arValidation';

/**
 * DEVELOPER-ONLY real-camera validation (shown inside the ?debug=1 readout). Produces the evidence the synthetic
 * benchmark cannot: how far the drawn markings are from where they truly belong on a real hand.
 *
 * Protocol (docs/HAND_AR_ACCURACY.md): before the session, draw a small pen dot on the skin where each test marking
 * belongs. Then:
 *   Freeze & label   — the current frame freezes; click a drawn marking, then click its pen dot. Repeat.
 *   Record still     — 5 s with the hand held still (jitter).
 *   Record movement  — 10 s of natural movement, including leaving and re-entering the view (losses, reacquisition).
 *   Export JSON      — downloads the numbers. Score with: npm run ar:report -- <file>.
 *
 * Privacy: the frozen frame lives only in this page's memory and is discarded on Unfreeze / leaving the page. The
 * export contains coordinates and timings only — no image — and is saved by the tester; nothing is uploaded.
 */
export default function ArValidationPanel({ frameDataRef, validationRef, protocol, viewKey, mapping, videoRef }) {
  const canvasRef = useRef(null);
  const [frozen, setFrozen] = useState(null); // { frame, width, height }
  const [selected, setSelected] = useState(null);
  const [count, setCount] = useState(0);
  const [recording, setRecording] = useState(null);
  const [lighting, setLighting] = useState('indoor');
  const [message, setMessage] = useState('');

  const session = () => {
    if (!validationRef.current) {
      validationRef.current = createValidationSession({
        protocol, viewKey, mapping, userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '', tags: { lighting },
      });
    }
    return validationRef.current;
  };

  const freeze = () => {
    const fd = frameDataRef.current;
    const video = videoRef.current;
    if (!fd || !video || !video.videoWidth) { setMessage('No camera frame yet.'); return; }
    const c = canvasRef.current;
    c.width = video.videoWidth; c.height = video.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0);
    // predicted marking centres, numbered
    ctx.lineWidth = 3;
    fd.markings.filter((m) => Number.isFinite(m.x)).forEach((m, i) => {
      ctx.strokeStyle = '#00e5ff'; ctx.beginPath(); ctx.arc(m.x, m.y, 10, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#00e5ff'; ctx.font = '20px sans-serif'; ctx.fillText(String(i + 1), m.x + 12, m.y - 12);
    });
    setFrozen({ frame: { ...fd, markings: fd.markings.map((m) => ({ ...m })) }, width: c.width, height: c.height });
    setSelected(null);
    setMessage(fd.markings.length ? 'Click a drawn marking (cyan), then click where it truly belongs.' : 'No markings were drawn in this frame.');
  };

  const unfreeze = () => {
    const c = canvasRef.current;
    if (c) { c.getContext('2d').clearRect(0, 0, c.width, c.height); c.width = 0; c.height = 0; }
    setFrozen(null); setSelected(null); setMessage('');
  };

  const onClick = (e) => {
    if (!frozen) return;
    const rect = e.currentTarget.getBoundingClientRect();
    let x = ((e.clientX - rect.left) / rect.width) * frozen.width;
    const y = ((e.clientY - rect.top) / rect.height) * frozen.height;
    if (frozen.frame.mirrored) x = frozen.width - x; // the frozen image is shown mirrored like the live view
    const p = { x, y };
    if (!selected) {
      const m = nearestMarking(frozen.frame.markings, p, 0.06 * frozen.width);
      if (!m) { setMessage('Click closer to a drawn marking first.'); return; }
      setSelected(m); setMessage('Now click where that marking truly belongs (e.g. the pen dot).');
      return;
    }
    const ok = session().addLabel({
      markingId: selected.id, predicted: { x: selected.x, y: selected.y }, truth: p,
      palmWidthPx: frozen.frame.palmWidthPx, videoWidth: frozen.width, videoHeight: frozen.height,
    });
    if (ok) {
      const ctx = canvasRef.current.getContext('2d');
      ctx.strokeStyle = '#ff2d55'; ctx.beginPath(); ctx.moveTo(selected.x, selected.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      setCount(session().labelCount);
      setMessage(`Labelled (${(Math.hypot(selected.x - p.x, selected.y - p.y) / frozen.frame.palmWidthPx).toFixed(3)} palm widths). Click another marking, or Unfreeze.`);
    } else {
      setMessage('This frame has no measured palm width — unfreeze and try again with the hand tracked.');
    }
    setSelected(null);
  };

  const record = (label, seconds) => {
    const s = session();
    s.startRecording(label);
    setRecording(label);
    setTimeout(() => { s.stopRecording(); setRecording(null); setMessage(`Recorded "${label}" (${seconds} s).`); }, seconds * 1000);
  };

  const exportJson = () => {
    const data = session().toJSON();
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ar-validation-${viewKey || 'view'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="ar-validation" data-testid="ar-validation">
      <span>— Validation (real camera) —</span>
      <div className="ar-validation-row">
        <label>Lighting{' '}
          <select value={lighting} onChange={(e) => { setLighting(e.target.value); if (validationRef.current) validationRef.current.setTag('lighting', e.target.value); }}>
            <option value="bright">bright</option><option value="indoor">indoor</option><option value="dim">dim</option>
          </select>
        </label>
        {!frozen ? <button type="button" className="btn" onClick={freeze}>Freeze &amp; label</button> : <button type="button" className="btn" onClick={unfreeze}>Unfreeze</button>}
        <button type="button" className="btn" disabled={Boolean(recording)} onClick={() => record('still', 5)}>{recording === 'still' ? 'Recording…' : 'Record still (5 s)'}</button>
        <button type="button" className="btn" disabled={Boolean(recording)} onClick={() => record('movement', 10)}>{recording === 'movement' ? 'Recording…' : 'Record movement (10 s)'}</button>
        <button type="button" className="btn" onClick={exportJson}>Export JSON ({count} labels)</button>
      </div>
      {message && <span className="muted small">{message}</span>}
      <canvas
        ref={canvasRef}
        className="ar-validation-frame"
        onClick={onClick}
        style={{ display: frozen ? 'block' : 'none', transform: frozen && frozen.frame.mirrored ? 'scaleX(-1)' : 'none' }}
      />
    </div>
  );
}
