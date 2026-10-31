import { useEffect, useState } from 'react';

/**
 * A slider that shows its value live while it is dragged but commits ONE
 * change (one undo step) when the adjustment ends: mouse/touch release, a
 * keyboard adjustment (arrow keys, Home/End, Page keys), or losing focus.
 * (The old slider only committed on mouse release, so keyboard changes were
 * silently dropped.)
 */
export default function CommittedRange({ min, max, step, value, onCommit, ariaLabel, format = (v) => String(v) }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  const commit = (raw) => {
    const n = Number(raw);
    if (Number.isFinite(n) && n !== value) onCommit(n);
  };

  return (
    <span className="range-row">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(local) ? local : min}
        aria-label={ariaLabel}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={(e) => commit(e.target.value)}
        onTouchEnd={(e) => commit(e.target.value)}
        onKeyUp={(e) => commit(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
      />
      <output className="range-value">{format(local)}</output>
    </span>
  );
}
