import { SIZE_PRESET_KEYS, SIZE_PRESET_LABELS, SCALE_LIMITS } from '../config/sizePresets';
import CommittedRange from './CommittedRange';

/**
 * Small / Medium / Large buttons AND a custom scale on top of them (they work together, they are not
 * alternatives: "Medium at 80%"). Purely presentational — the caller decides what a preset or scale change
 * does to the object.
 */
export default function PresetScaleControl({ label, preset, scale, onPreset, onScale, presetKeys = SIZE_PRESET_KEYS, presetLabels = SIZE_PRESET_LABELS, disabled = false }) {
  const stepBy = (delta) => onScale(Math.round((scale + delta) * 100) / 100);
  const atMin = scale <= SCALE_LIMITS.min + 1e-9;
  const atMax = scale >= SCALE_LIMITS.max - 1e-9;

  return (
    <div className="field preset-scale">
      <span>{label}</span>
      <div className="segmented" role="group" aria-label={`${label} preset`}>
        {presetKeys.map((key) => (
          <button
            key={key}
            type="button"
            className={preset === key ? 'active' : ''}
            aria-pressed={preset === key}
            disabled={disabled}
            onClick={() => onPreset(key)}
          >
            {presetLabels[key]}
          </button>
        ))}
      </div>
      <div className="scale-row">
        <button type="button" className="step-btn" aria-label={`Decrease ${label.toLowerCase()} scale`} disabled={disabled || atMin} onClick={() => stepBy(-SCALE_LIMITS.step)}>−</button>
        <CommittedRange
          min={SCALE_LIMITS.min}
          max={SCALE_LIMITS.max}
          step={SCALE_LIMITS.step}
          value={Math.min(SCALE_LIMITS.max, Math.max(SCALE_LIMITS.min, scale))}
          ariaLabel={`${label} custom scale`}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={onScale}
        />
        <button type="button" className="step-btn" aria-label={`Increase ${label.toLowerCase()} scale`} disabled={disabled || atMax} onClick={() => stepBy(SCALE_LIMITS.step)}>+</button>
      </div>
    </div>
  );
}
