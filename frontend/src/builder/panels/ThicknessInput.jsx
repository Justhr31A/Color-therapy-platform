import { useEffect, useState } from 'react';

const MIN_THICKNESS = 0.5; // the smallest thickness the − button steps down to; typing any positive number is allowed

/**
 * Thickness as a plain number of reference pixels — deliberately NOT a slider and NOT clamped to a maximum:
 * a stroke may need to be thick enough to cover most or all of a hand, so there is no upper limit anywhere (here,
 * in the model, in import validation, or on the server). Only "a finite number above zero" is accepted.
 *
 * Typing is held locally and committed once (on blur or Enter) — one undo step per edit, not one per keystroke.
 */
export default function ThicknessInput({ label = 'Thickness', value, onCommit }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const parsed = Number(text);
  const valid = text.trim() !== '' && Number.isFinite(parsed) && parsed > 0;
  const step = (v) => Math.max(1, Math.round(v / 10)); // proportional, so a very thick stroke can still be nudged sensibly

  const commitText = () => { if (valid && parsed !== value) onCommit(parsed); else if (!valid) setText(String(value)); };
  const nudge = (dir) => {
    const base = Number.isFinite(value) && value > 0 ? value : 1;
    onCommit(Math.max(MIN_THICKNESS, Math.round((base + dir * step(base)) * 100) / 100));
  };

  return (
    <div className="field thickness-input">
      <span>{label}</span>
      <div className="scale-row">
        <button type="button" className="step-btn" aria-label={`Decrease ${label}`} onClick={() => nudge(-1)}>−</button>
        <input
          type="number"
          inputMode="decimal"
          min={MIN_THICKNESS}
          step="any"
          aria-label={label}
          aria-invalid={!valid}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitText(); } }}
        />
        <span className="muted small">px</span>
        <button type="button" className="step-btn" aria-label={`Increase ${label}`} onClick={() => nudge(1)}>+</button>
      </div>
      {!valid && <span className="save-error small" role="alert">Enter a number above 0.</span>}
    </div>
  );
}
