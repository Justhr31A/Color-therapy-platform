import PresetScaleControl from './PresetScaleControl';
import { getSizeState, patchSizePreset, patchScale } from '../model/objectModel';

/** Size for the selected object: preset + custom scale (both edit the real object's width/height and metadata). */
export default function SizeControl({ object, onCommit, label = 'Size' }) {
  const { preset, scale } = getSizeState(object);
  return (
    <PresetScaleControl
      label={label}
      preset={preset}
      scale={scale}
      onPreset={(p) => onCommit(patchSizePreset(object, p))}
      onScale={(s) => onCommit(patchScale(object, s))}
    />
  );
}
