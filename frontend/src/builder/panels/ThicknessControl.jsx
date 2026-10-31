import PresetScaleControl from './PresetScaleControl';
import { THICKNESS_PRESET_KEYS, THICKNESS_PRESET_LABELS } from '../config/sizePresets';
import { getThicknessState, patchThicknessPreset, patchThicknessScale } from '../model/objectModel';

/** Line/ring thickness for the selected object: preset + custom scale. */
export default function ThicknessControl({ object, onCommit, label = 'Thickness' }) {
  const { preset, scale } = getThicknessState(object);
  return (
    <PresetScaleControl
      label={label}
      preset={preset}
      scale={scale}
      presetKeys={THICKNESS_PRESET_KEYS}
      presetLabels={THICKNESS_PRESET_LABELS}
      onPreset={(p) => onCommit(patchThicknessPreset(object, p))}
      onScale={(s) => onCommit(patchThicknessScale(object, s))}
    />
  );
}
