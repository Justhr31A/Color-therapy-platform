import ColorPalette from './ColorPalette';
import ThicknessInput from './ThicknessInput';

/**
 * The shared outline editor — used for any shape and for each ring of a Dot + Rings. `outline` is the normalised
 * { enabled, color, thickness } (objectModel.normalizeOutline); `onChange` receives just the part that changed, so
 * enabled, colour and thickness are independent of one another and of the fill.
 */
export default function OutlineControl({ label = 'Outline', outline, onChange }) {
  return (
    <fieldset className="prop-group outline-group">
      <legend>{label}</legend>
      <label className="check">
        <input type="checkbox" aria-label={`${label} enabled`} checked={outline.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
        <span>Show an outline</span>
      </label>
      {outline.enabled && (
        <>
          <ColorPalette label={`${label} colour`} value={outline.color} onChange={(color) => onChange({ color })} />
          <ThicknessInput label={`${label} thickness`} value={outline.thickness} onCommit={(thickness) => onChange({ thickness })} />
        </>
      )}
    </fieldset>
  );
}
