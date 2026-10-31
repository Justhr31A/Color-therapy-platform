import { useState } from 'react';
import { getPalette, colorName } from '../config/palette';

const RECENT_COLORS_KEY = 'ctpp_recent_colors';

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY));
    return Array.isArray(list) ? list.filter((c) => typeof c === 'string') : [];
  } catch (e) {
    return [];
  }
}
function saveRecent(color) {
  const list = [color, ...loadRecent().filter((c) => c.toLowerCase() !== color.toLowerCase())].slice(0, 8);
  try { localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(list)); } catch (e) { /* storage unavailable: recent colours are a convenience only */ }
  return list;
}

/**
 * Predefined palette (from config/palette.js — the only place swatches are defined) plus a custom colour
 * picker and the doctor's recently used custom colours. "Recent colours" is a per-browser convenience; it is
 * not protocol data (the colour itself is saved on the object).
 */
export default function ColorPalette({ label = 'Colour', value, onChange }) {
  const [recent, setRecent] = useState(loadRecent);
  const palette = getPalette();
  const current = String(value || '').toLowerCase();

  const pick = (color, remember) => {
    onChange(color);
    if (remember) setRecent(saveRecent(color));
  };

  return (
    <div className="field color-field">
      <span>{label}</span>
      <div className="palette-grid" role="group" aria-label={`${label} palette`}>
        {palette.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`palette-swatch ${current === c.value.toLowerCase() ? 'selected' : ''}`}
            style={{ background: c.value }}
            title={c.name}
            aria-label={c.name}
            aria-pressed={current === c.value.toLowerCase()}
            onClick={() => pick(c.value, false)}
          />
        ))}
      </div>
      <div className="palette-custom">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value || '') ? value : '#e5484d'} aria-label={`Custom ${label.toLowerCase()}`} onChange={(e) => pick(e.target.value, true)} />
        <span className="muted small">Custom · {colorName(value)}</span>
      </div>
      {recent.length > 0 && (
        <div className="palette-recent" aria-label="Recent custom colours">
          {recent.map((c) => (
            <button key={c} type="button" className="palette-swatch small" style={{ background: c }} title={c} aria-label={`Recent ${c}`} onClick={() => pick(c, true)} />
          ))}
        </div>
      )}
    </div>
  );
}
