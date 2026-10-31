import { useEffect, useState } from 'react';
import useProtocolStore from './store';
import { OBJECT_TYPES, FINGERS, fingerForDisplay } from './objectDefaults';
import { hasGuides } from './model/fingerGeometry';
import {
  supports, hasActiveRing, getRings, isLegacyRingObject, addRing, removeRingAt, patchRingAt, convertLegacyRing,
  patchThickness, getOutline, patchOutline,
  BAND_TYPES, BAND_TYPE_LABELS, getBand, patchBandFinger, patchBandPosition, patchBandType, patchBandRotationOffset, patchBandFitToFinger,
  getText, patchText, TEXT_MAX_LENGTH,
} from './model/objectModel';
import ColorPalette from './panels/ColorPalette';
import SizeControl from './panels/SizeControl';
import ThicknessInput from './panels/ThicknessInput';
import OutlineControl from './panels/OutlineControl';
import CommittedRange from './panels/CommittedRange';
import { describeAnchor, anchorPatch, ANCHOR_OPTIONS } from './model/anchors';

const TYPE_LABELS = Object.fromEntries(OBJECT_TYPES.map((t) => [t.type, t.label]));

/** "Dot + Ring" / "Dot + Rings" for a dot that has rings; otherwise the type's normal label. */
export function objectTypeLabel(object) {
  const n = getRings(object).length;
  if (n > 1) return 'Dot + Rings';
  if (n === 1 || hasActiveRing(object)) return 'Dot + Ring';
  return TYPE_LABELS[object.type] || object.type;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Text that commits once when the field loses focus (not on every keystroke, which would flood undo history). */
function CommittedText({ value, onCommit, maxLength }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <textarea
      rows={3}
      maxLength={maxLength}
      value={local}
      aria-label="Text content"
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onCommit(local); }}
    />
  );
}

/**
 * "Camera anchor": which part of the hand this marking moves with on the live camera. Automatic by default; a doctor can
 * pin it (stored in `landmarkReference`, undoable like every other change). Ambiguous automatic anchors are flagged.
 */
export function AnchorControl({ object, canvas, onCommit }) {
  const a = describeAnchor(object, canvas);
  if (a.mode === 'none') return null;
  const value = a.mode === 'pinned' ? a.region : '';
  return (
    <label className="field anchor-field" data-testid="anchor-control">
      <span>Camera anchor</span>
      <select value={value} onChange={(e) => onCommit(anchorPatch(e.target.value || null))}>
        <option value="">Automatic{a.mode === 'auto' && a.label ? ` (${a.label})` : ''}</option>
        {ANCHOR_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {a.mode === 'auto' && a.ambiguous && (
        <span className="anchor-warning small" role="note" data-testid="anchor-ambiguous">
          This spot lies between {a.alternatives.slice(0, 2).map((x) => x.label).join(' and ')}. On the camera it will blend between them — choose the part it belongs to for an exact attachment.
        </span>
      )}
      {a.mode === 'auto' && !a.ambiguous && <span className="muted small">Moves with: {a.label}.</span>}
      {a.mode === 'pinned' && !a.mismatch && <span className="muted small">Pinned: moves only with {a.label}.</span>}
      {a.mode === 'pinned' && a.mismatch && (
        <span className="anchor-warning small" role="note" data-testid="anchor-mismatch">
          Pinned to {a.label}, but the marking now sits on {a.nearest}. Choose the anchor again.
        </span>
      )}
    </label>
  );
}

export default function PropertiesPanel() {
  const canvases = useProtocolStore((s) => s.canvases);
  const selectedObjectId = useProtocolStore((s) => s.selectedObjectId);
  const commitObjectChange = useProtocolStore((s) => s.commitObjectChange);
  const duplicateSelected = useProtocolStore((s) => s.duplicateSelected);
  const copySelected = useProtocolStore((s) => s.copySelected);
  const deleteObject = useProtocolStore((s) => s.deleteObject);

  // The selected object can be in any of the four views.
  const canvas = canvases.find((c) => c.objects.some((o) => o.id === selectedObjectId)) || null;
  const object = canvas ? canvas.objects.find((o) => o.id === selectedObjectId) : null;

  if (!object) {
    return (
      <div className="properties-panel">
        <p className="muted">Select an object on any of the four views to edit its properties.</p>
        <p className="muted small">Pick a tool on the left and click a view to add markings. All four views belong to this one protocol.</p>
      </div>
    );
  }

  const commit = (patch) => commitObjectChange(object.id, patch, canvas.id);
  const isDot = object.type === 'dot';
  const isBand = object.type === 'fingerBand';
  const rings = getRings(object);
  const legacyRing = isLegacyRingObject(object);
  const compositeActive = rings.length > 0 || legacyRing; // the dot is part of a Dot + Rings composite
  const band = getBand(object);
  const canvasSize = { width: canvas.width, height: canvas.height };

  return (
    <div className="properties-panel">
      <div className="prop-header">
        <strong>{objectTypeLabel(object)}</strong>
        <span className="pill" title="The view this object belongs to">{canvas.backgroundLabel}</span>
      </div>

      <ColorPalette label={compositeActive ? 'Dot colour' : 'Colour'} value={object.color} onChange={(color) => commit({ color })} />

      {supports(object.type, 'size') && <SizeControl object={object} onCommit={commit} label={compositeActive ? 'Dot size' : isBand ? 'Band width' : object.type === 'text' ? 'Text size' : 'Size'} />}

      {isDot && (
        <fieldset className="prop-group rings-group">
          <legend>Rings</legend>
          <p className="muted small">
            Rings attach directly around the dot and around each other — there is no gap setting. Add as many as you need.
          </p>
          {legacyRing && (
            <div className="ring-card legacy">
              <strong>Ring (older format)</strong>
              <p className="muted small">
                This ring was saved with a space between it and the dot. It still displays exactly as before. Converting it
                makes it the first attached ring (touching the dot); its colour and thickness carry over, the old gap is dropped.
              </p>
              <button type="button" className="btn small" onClick={() => commit(convertLegacyRing(object))}>Convert to attached rings</button>
            </div>
          )}
          {rings.map((r, i) => (
            <div className="ring-card" key={i}>
              <div className="ring-card-head">
                <strong>Ring {i + 1}</strong>
                <button type="button" className="btn small danger" aria-label={`Remove ring ${i + 1}`} onClick={() => commit(removeRingAt(object, i))}>Remove</button>
              </div>
              <ColorPalette label={`Ring ${i + 1} colour`} value={r.color} onChange={(color) => commit(patchRingAt(object, i, { color }))} />
              <ThicknessInput label={`Ring ${i + 1} thickness`} value={r.thickness} onCommit={(thickness) => commit(patchRingAt(object, i, { thickness }))} />
              <OutlineControl label={`Ring ${i + 1} outline`} outline={r.outline} onChange={(o) => commit(patchRingAt(object, i, { outline: o }))} />
            </div>
          ))}
          <button type="button" className="btn small primary" onClick={() => commit(addRing(object))}>+ Add Ring</button>
        </fieldset>
      )}

      {supports(object.type, 'thickness') && <ThicknessInput label="Thickness" value={object.thickness} onCommit={(v) => commit(patchThickness(object, v))} />}

      {supports(object.type, 'outline') && (
        <OutlineControl label={compositeActive ? 'Dot outline' : 'Outline'} outline={getOutline(object)} onChange={(o) => commit(patchOutline(object, o))} />
      )}

      <label className="field">
        <span>Opacity</span>
        <CommittedRange min={0.1} max={1} step={0.05} value={object.opacity} ariaLabel="Opacity" format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => commit({ opacity: v })} />
      </label>

      {supports(object.type, 'rotation') && !isBand && (
        <label className="field">
          <span>Rotation</span>
          <CommittedRange min={-180} max={180} step={1} value={object.rotation || 0} ariaLabel="Rotation" format={(v) => `${Math.round(v)}°`} onCommit={(v) => commit({ rotation: v })} />
        </label>
      )}

      {isBand && (
        <fieldset className="prop-group">
          <legend>Finger band</legend>
          {!hasGuides(canvas.viewKey) && <p className="muted small">This view has no finger guides, so the band cannot be placed on a finger.</p>}
          <label className="field">
            <span>Finger</span>
            <select value={fingerForDisplay(object.finger)} onChange={(e) => commit(patchBandFinger(object, canvas.viewKey, canvasSize, e.target.value))}>
              {FINGERS.map((f) => <option key={f} value={f}>{capitalize(f)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Position along finger</span>
            <CommittedRange min={0} max={1} step={0.01} value={band.position} ariaLabel="Position along finger" format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => commit(patchBandPosition(object, canvas.viewKey, canvasSize, v))} />
            <span className="muted small">0% = knuckle, 100% = fingertip</span>
          </label>
          <label className="field">
            <span>Band type</span>
            <select value={band.type} onChange={(e) => commit(patchBandType(object, e.target.value))}>
              {BAND_TYPES.map((t) => <option key={t} value={t}>{BAND_TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Angle across the finger</span>
            <CommittedRange min={-90} max={90} step={1} value={band.rotationOffset} ariaLabel="Angle across the finger" format={(v) => `${Math.round(v)}°`} onCommit={(v) => commit(patchBandRotationOffset(object, canvas.viewKey, canvasSize, v))} />
          </label>
          <button type="button" className="btn small" onClick={() => commit(patchBandFitToFinger(object, canvas.viewKey))}>Fit width to finger</button>
          <p className="muted small">Finger guides are approximate authoring aids. On the camera, a band follows its finger's bones.</p>
        </fieldset>
      )}

      {object.type === 'text' && (
        <label className="field">
          <span>Text</span>
          <CommittedText value={getText(object)} maxLength={TEXT_MAX_LENGTH} onCommit={(t) => commit(patchText(object, t))} />
          <span className="muted small">{getText(object).length}/{TEXT_MAX_LENGTH} characters</span>
        </label>
      )}

      {canvas.canvasType === 'hand' && !isBand && (
        <label className="field">
          <span>Finger (optional)</span>
          <select value={fingerForDisplay(object.finger)} onChange={(e) => commit({ finger: e.target.value || null })}>
            <option value="">— none —</option>
            {FINGERS.map((f) => <option key={f} value={f}>{capitalize(f)}</option>)}
          </select>
          {object.finger && <span className="muted small">Records which finger the marking is for (information only — the camera uses “Camera anchor” below).</span>}
        </label>
      )}

      {canvas.canvasType === 'hand' && <AnchorControl object={object} canvas={canvas} onCommit={commit} />}

      <div className="prop-actions">
        <button type="button" className="btn small" onClick={duplicateSelected}>Duplicate</button>
        <button type="button" className="btn small" onClick={copySelected}>Copy</button>
        <button type="button" className="btn small danger" onClick={() => deleteObject(object.id, canvas.id)}>Delete</button>
      </div>
    </div>
  );
}
