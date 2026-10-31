/**
 * The Studio's object model: pure functions (no React, no store) that build the
 * data patches every control applies to a protocol object.
 *
 * WHERE THE DATA LIVES (no backend change was needed):
 *   - the existing columns keep the RESOLVED geometry the AR mapper, the public
 *     render and older renderers already understand:
 *       width / height (fractions of the canvas), thickness (reference px), colour, opacity, rotation
 *   - the doctor's INTENT and the new structured data live in `metadata`:
 *       metadata.sizePreset      'small' | 'medium' | 'large' | 'xl'   (Extra Large)
 *       metadata.scale           custom multiplier on top of the preset  (width = base * scale)
 *       (thickness is the plain `thickness` column — a free positive number, NO maximum; the older
 *        metadata.thicknessPreset/thicknessScale are only READ for objects saved before that change)
 *       metadata.outline         { enabled, color, thickness } — the shared outline structure, any shape
 *       metadata.rings           Dot + Rings: an ARRAY of attached rings [{ color, thickness, outline }],
 *                                innermost first, always touching (GAP = 0). No maximum count.
 *       metadata.ring            LEGACY single ring with a gap — still rendered exactly as before until the
 *                                doctor converts it (convertLegacyRing) — never rewritten just by opening it
 *       metadata.band            Finger Band: { type, position, rotationOffset }
 *       metadata.text            Text/annotation content
 *   - `finger` (canonical: thumb/index/middle/ring/little) and `landmarkReference`
 *     (reserved for future AR, left null by this phase) are the existing columns.
 *
 * Every patch returned here is a fresh, deep-cloned object: applying one can
 * never make two protocol objects share a nested reference.
 *
 * Objects created before the Studio have no sizePreset. They are treated as
 * "Medium with a custom scale" (their width divided by the Medium base), which
 * loses nothing and rewrites nothing until the doctor actually edits them.
 */
import { createDefaultObject } from '../objectDefaults';
import { COLOR_PALETTE } from '../config/palette';
import {
  SIZE_PRESET_KEYS, DEFAULT_SIZE_PRESET, THICKNESS_PRESET_KEYS, DEFAULT_THICKNESS_PRESET, THICKNESS_BASES,
  SCALE_LIMITS, MIN_THICKNESS_PX, RING_SIZE_BASES, sizeBase, GAP_PRESET_KEYS, DEFAULT_GAP_PRESET, RING_GAP_BASES,
  DEFAULT_RING_THICKNESS, DEFAULT_OUTLINE_COLOR, DEFAULT_OUTLINE_THICKNESS,
} from '../config/sizePresets';
import {
  hasGuides, getGuide, canonicalFingerName, bandPlacement, projectToAxis, nearestFinger, clamp01, normalizeBandDeg, axisAngleDeg,
} from './fingerGeometry';

// ---------------------------------------------------------------- utilities
export const round2 = (n) => Math.round(n * 100) / 100;
export const round3 = (n) => Math.round(n * 1000) / 1000;
export const round4 = (n) => Math.round(n * 10000) / 10000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function deepClone(value) {
  if (value === undefined) return undefined;
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
const cloneMeta = (object) => deepClone(object && object.metadata && typeof object.metadata === 'object' ? object.metadata : {});

export function clampScale(scale) {
  const n = isNum(scale) ? scale : 1;
  return round3(Math.min(SCALE_LIMITS.max, Math.max(SCALE_LIMITS.min, n)));
}

// ------------------------------------------------------------- capabilities
/** The tools shown in the palette, in order. 'dotRing' is a tool only: it creates a `dot` with a ring. */
export const TOOL_IDS = Object.freeze([
  'select', 'dot', 'ring', 'dotRing', 'fingerBand', 'hline', 'vline', 'freeline',
  'invertedTriangle', 'triangle', 'rectangle', 'square', 'arrow', 'text', 'eraser',
]);
/** Tools that draw something (everything but select and eraser). */
export const DRAWING_TOOLS = Object.freeze(TOOL_IDS.filter((t) => t !== 'select' && t !== 'eraser'));

const CAPABILITIES = {
  dot: { size: true, thickness: false, rotation: false, outline: true },
  ring: { size: true, thickness: true, rotation: false, outline: true },
  hline: { size: true, thickness: true, rotation: true, outline: true },
  vline: { size: true, thickness: true, rotation: true, outline: true },
  arrow: { size: true, thickness: true, rotation: true, outline: true },
  freeline: { size: false, thickness: true, rotation: false, outline: true },
  triangle: { size: true, thickness: true, rotation: true, outline: true },
  invertedTriangle: { size: true, thickness: true, rotation: true, outline: true },
  rectangle: { size: true, thickness: true, rotation: true, outline: true },
  square: { size: true, thickness: true, rotation: true, outline: true },
  fingerBand: { size: true, thickness: true, rotation: true, outline: true },
  text: { size: true, thickness: false, rotation: true, outline: false },
};

/** Does this object type logically have `feature` ('size' | 'thickness' | 'rotation' | 'outline')? */
export function supports(type, feature) {
  return Boolean(CAPABILITIES[type] && CAPABILITIES[type][feature]);
}

// Types whose height always mirrors their width (the convention the builder has always used).
const UNIFORM_TYPES = new Set(['dot', 'ring', 'triangle', 'invertedTriangle', 'square']);

// ------------------------------------------------------------- size preset + scale
export function isSizeManaged(object) {
  return Boolean(object && object.metadata && SIZE_PRESET_KEYS.includes(object.metadata.sizePreset));
}

/** { preset, scale, managed, base } — `scale` is always derived from the real width so it can never disagree with it. */
export function getSizeState(object) {
  const managed = isSizeManaged(object);
  const preset = managed ? object.metadata.sizePreset : DEFAULT_SIZE_PRESET;
  const base = sizeBase(object.type, preset);
  const scale = base && isNum(object.width) ? round3(object.width / base) : 1;
  return { preset, scale, managed, base };
}

function resolveSizePatch(object, preset, scale, { resetAspect }) {
  const baseW = sizeBase(object.type, preset, 'width');
  if (!baseW) return {};
  const width = round4(baseW * scale);
  let height = object.height;
  if (UNIFORM_TYPES.has(object.type)) {
    height = width;
  } else if (object.type === 'rectangle') {
    const baseH = sizeBase('rectangle', preset, 'height');
    if (resetAspect || !isNum(object.height) || !isNum(object.width) || object.width === 0) height = round4(baseH * scale);
    else height = round4(object.height * (width / object.width)); // a custom scale keeps the doctor's proportions
  }
  const metadata = cloneMeta(object);
  metadata.sizePreset = preset;
  metadata.scale = scale;
  return { width, height, metadata };
}

/** Choosing Small/Medium/Large keeps the custom scale and takes that preset's proportions. */
export function patchSizePreset(object, preset) {
  if (!SIZE_PRESET_KEYS.includes(preset) || !supports(object.type, 'size')) return {};
  return resolveSizePatch(object, preset, clampScale(getSizeState(object).scale), { resetAspect: true });
}

/** A custom scale multiplies the current preset; a rectangle keeps its width:height proportion. */
export function patchScale(object, scale) {
  if (!supports(object.type, 'size')) return {};
  return resolveSizePatch(object, getSizeState(object).preset, clampScale(scale), { resetAspect: false });
}

// ------------------------------------------------------- thickness preset + scale
export function isThicknessManaged(object) {
  return Boolean(object && object.metadata && THICKNESS_PRESET_KEYS.includes(object.metadata.thicknessPreset));
}

export function getThicknessState(object) {
  const managed = isThicknessManaged(object);
  const preset = managed ? object.metadata.thicknessPreset : DEFAULT_THICKNESS_PRESET;
  const base = THICKNESS_BASES[preset];
  const scale = isNum(object.thickness) && base ? round3(object.thickness / base) : 1;
  return { preset, scale, managed, base };
}

function resolveThicknessPatch(object, preset, scale) {
  const thickness = Math.max(MIN_THICKNESS_PX, round2(THICKNESS_BASES[preset] * scale));
  const metadata = cloneMeta(object);
  metadata.thicknessPreset = preset;
  metadata.thicknessScale = scale;
  return { thickness, metadata };
}

export function patchThicknessPreset(object, preset) {
  if (!THICKNESS_PRESET_KEYS.includes(preset) || !supports(object.type, 'thickness')) return {};
  return resolveThicknessPatch(object, preset, clampScale(getThicknessState(object).scale));
}

export function patchThicknessScale(object, scale) {
  if (!supports(object.type, 'thickness')) return {};
  return resolveThicknessPatch(object, getThicknessState(object).preset, clampScale(scale));
}

// ------------------------------------------------------------- free thickness
/** A usable stroke thickness: a finite number above zero. There is deliberately NO upper bound. */
export const isValidThickness = (v) => isNum(v) && v > 0;

/**
 * Sets the object's thickness to any positive finite number (reference pixels) — no maximum, so a stroke can be
 * made thick enough to cover most or all of a hand. The older preset/scale metadata is dropped: a free value
 * is the only truth now, and leaving a stale `thicknessScale` behind (which the server caps) would be wrong.
 */
export function patchThickness(object, value) {
  if (!supports(object.type, 'thickness')) return {};
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!isValidThickness(n)) return {};
  const metadata = cloneMeta(object);
  delete metadata.thicknessPreset;
  delete metadata.thicknessScale;
  return { thickness: round2(n), metadata };
}

// ------------------------------------------------------------------ outline
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const isColor = (v) => typeof v === 'string' && HEX_COLOR.test(v);

/** Normalises a raw outline (an object's metadata.outline, or a ring entry's `outline`). Missing/invalid = OFF. */
export function normalizeOutline(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: o.enabled === true,
    color: isColor(o.color) ? o.color : DEFAULT_OUTLINE_COLOR,
    thickness: isValidThickness(o.thickness) ? o.thickness : DEFAULT_OUTLINE_THICKNESS,
  };
}
/** The outline of an object — OFF (with defaults ready for when it is switched on) for anything saved without one. */
export function getOutline(object) {
  return normalizeOutline(object && object.metadata && object.metadata.outline);
}
/** True when an outline will actually be drawn. */
export const outlineActive = (outline) => Boolean(outline) && outline.enabled === true && isValidThickness(outline.thickness);

function mergeOutline(current, patch) {
  const next = normalizeOutline(current);
  if (patch && typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch && isColor(patch.color)) next.color = patch.color;
  if (patch && isValidThickness(patch.thickness)) next.thickness = round2(patch.thickness);
  return next;
}
/** Independently set outline enabled / colour / thickness for an object (any shape that supports outlines). */
export function patchOutline(object, patch) {
  if (!supports(object.type, 'outline')) return {};
  const metadata = cloneMeta(object);
  metadata.outline = mergeOutline(metadata.outline, patch);
  return { metadata };
}

/**
 * Keeps the recorded intent (metadata.scale, thicknessScale, ring scales) equal to what the resolved
 * geometry actually is. Called after EVERY committed change, so a drag-resize on the canvas can never
 * leave a stale `scale` behind. Returns the same object when nothing needed fixing.
 */
export function syncDerivedMetadata(object) {
  if (!object || !object.metadata || typeof object.metadata !== 'object') return object;
  let metadata = null;
  const edit = () => { if (!metadata) metadata = deepClone(object.metadata); return metadata; };

  if (isSizeManaged(object) && isNum(object.width)) {
    const base = sizeBase(object.type, object.metadata.sizePreset);
    if (base) {
      const scale = round3(object.width / base);
      if (object.metadata.scale !== scale) edit().scale = scale;
    }
  }
  if (isThicknessManaged(object) && isNum(object.thickness)) {
    const scale = round3(object.thickness / THICKNESS_BASES[object.metadata.thicknessPreset]);
    if (object.metadata.thicknessScale !== scale) edit().thicknessScale = scale;
  }
  const ring = object.metadata.ring;
  if (ring && typeof ring === 'object') {
    if (SIZE_PRESET_KEYS.includes(ring.sizePreset) && isNum(ring.width)) {
      const scale = round3(ring.width / RING_SIZE_BASES[ring.sizePreset]);
      if (ring.scale !== scale) edit().ring.scale = scale;
    }
    if (THICKNESS_PRESET_KEYS.includes(ring.thicknessPreset) && isNum(ring.thickness)) {
      const scale = round3(ring.thickness / THICKNESS_BASES[ring.thicknessPreset]);
      if (ring.thicknessScale !== scale) edit().ring.thicknessScale = scale;
    }
    if (GAP_PRESET_KEYS.includes(ring.gapPreset) && isNum(ring.gap)) {
      const scale = round3(ring.gap / RING_GAP_BASES[ring.gapPreset]);
      if (ring.gapScale !== scale) edit().ring.gapScale = scale;
    }
  }
  return metadata ? { ...object, metadata } : object;
}

// ------------------------------------------------------------------ Dot + Ring
/**
 * Dot + Ring is ONE object: type 'dot' whose `metadata.ring` describes the ring around it. It moves,
 * scales, copies, deletes and undoes as a single unit. It stays a `dot` on purpose: anything that only
 * knows plain dots (the AR mapper) still shows the dot instead of dropping the object.
 */
export function defaultRing(color) {
  return {
    enabled: true,
    sizePreset: DEFAULT_SIZE_PRESET,
    scale: 1,
    width: RING_SIZE_BASES[DEFAULT_SIZE_PRESET],
    thicknessPreset: DEFAULT_THICKNESS_PRESET,
    thicknessScale: 1,
    thickness: THICKNESS_BASES[DEFAULT_THICKNESS_PRESET],
    color,
  };
}

/**
 * The ring, with a colour ALWAYS present: legacy or hand-written data can have a ring with no `color` of
 * its own (it predates independent ring colours, or was imported from elsewhere), and callers should never
 * have to special-case that — they get the dot's own colour instead, without anything being rewritten just
 * by reading it. `patchRingColor` still sets an explicit, independent ring colour when the doctor changes it.
 */
export function getRing(object) {
  const r = object && object.metadata && object.metadata.ring;
  if (!r || typeof r !== 'object') return null;
  return typeof r.color === 'string' && r.color ? r : { ...r, color: object.color };
}

/**
 * The actual empty space, in reference pixels, between the dot's OUTER edge and the ring's INNER edge —
 * exactly what a doctor sees as "the gap" — regardless of whether this ring has ever had an explicit gap
 * set. A ring created or saved before this feature existed has no `gap` of its own; rather than treat that
 * as "no gap" (which would usually mean the ring sits jammed against the dot, an unannounced visual change),
 * this derives the gap that its existing, already-rendered width implies, so nothing visually moves for
 * data that predates this feature. Needs `canvasWidth` because the dot/ring sizes are normalized (a
 * fraction of the canvas) while the gap and thickness are reference pixels — the same unit mismatch
 * `fingerGeometry.js` resolves the same way, by converting through the canvas at the point of use.
 */
export function effectiveRingGapPx(object, ring, canvasWidth) {
  const dotRadiusPx = ((isNum(object.width) ? object.width : 0.03) / 2) * canvasWidth;
  const thicknessPx = isNum(ring.thickness) ? ring.thickness : 0;
  if (isNum(ring.gap)) return Math.max(0, ring.gap);
  const ringRadiusPx = ((isNum(ring.width) ? ring.width : 0.08) / 2) * canvasWidth;
  return Math.max(0, round2(ringRadiusPx - dotRadiusPx - thicknessPx / 2));
}

/** The gap preset/scale to show in the panel — derived the same backward-compatible way as the gap itself. */
export function getRingGapState(object, ring, canvasWidth) {
  const preset = GAP_PRESET_KEYS.includes(ring.gapPreset) ? ring.gapPreset : DEFAULT_GAP_PRESET;
  const gapPx = effectiveRingGapPx(object, ring, canvasWidth);
  const base = RING_GAP_BASES[preset];
  return { preset, scale: isNum(ring.gapScale) ? ring.gapScale : (base > 0 ? round3(gapPx / base) : 1), gap: gapPx };
}

/** True when a dot currently shows its ring. */
export function hasActiveRing(object) {
  return Boolean(object) && object.type === 'dot' && Boolean(getRing(object)) && getRing(object).enabled === true;
}

export function getRingSizeState(ring) {
  const preset = SIZE_PRESET_KEYS.includes(ring.sizePreset) ? ring.sizePreset : DEFAULT_SIZE_PRESET;
  const base = RING_SIZE_BASES[preset];
  return { preset, scale: isNum(ring.width) ? round3(ring.width / base) : 1 };
}
export function getRingThicknessState(ring) {
  const preset = THICKNESS_PRESET_KEYS.includes(ring.thicknessPreset) ? ring.thicknessPreset : DEFAULT_THICKNESS_PRESET;
  const base = THICKNESS_BASES[preset];
  return { preset, scale: isNum(ring.thickness) ? round3(ring.thickness / base) : 1 };
}

function withRing(object, mutate) {
  if (!object || object.type !== 'dot') return {};
  const metadata = cloneMeta(object);
  metadata.ring = metadata.ring && typeof metadata.ring === 'object' ? metadata.ring : defaultRing(object.color);
  mutate(metadata.ring);
  return { metadata };
}

export function patchRingEnabled(object, enabled) {
  return withRing(object, (ring) => { ring.enabled = Boolean(enabled); }); // turning it off keeps its settings for turning it back on
}
// Setting a size directly clears any explicit gap: size and gap are two different ways of saying how big the
// ring is, and once a gap is set it is authoritative for rendering (see effectiveRingGapPx) — so without this,
// picking a ring size after setting a gap would silently do nothing, a dead control. Whichever the doctor
// touches most recently wins; the choice they didn't touch is re-derived to describe the result truthfully
// (getRingGapState already does this for gap from a plain width, so nothing further is needed for that side).
function clearExplicitGap(ring) {
  delete ring.gap;
  delete ring.gapPreset;
  delete ring.gapScale;
}
export function patchRingSizePreset(object, preset) {
  if (!SIZE_PRESET_KEYS.includes(preset)) return {};
  return withRing(object, (ring) => {
    const { scale } = getRingSizeState(ring);
    ring.sizePreset = preset;
    ring.scale = clampScale(scale);
    ring.width = round4(RING_SIZE_BASES[preset] * ring.scale);
    clearExplicitGap(ring);
  });
}
export function patchRingScale(object, scale) {
  return withRing(object, (ring) => {
    const { preset } = getRingSizeState(ring);
    ring.sizePreset = preset;
    ring.scale = clampScale(scale);
    ring.width = round4(RING_SIZE_BASES[preset] * ring.scale);
    clearExplicitGap(ring);
  });
}
export function patchRingThicknessPreset(object, preset) {
  if (!THICKNESS_PRESET_KEYS.includes(preset)) return {};
  return withRing(object, (ring) => {
    const { scale } = getRingThicknessState(ring);
    ring.thicknessPreset = preset;
    ring.thicknessScale = clampScale(scale);
    ring.thickness = Math.max(MIN_THICKNESS_PX, round2(THICKNESS_BASES[preset] * ring.thicknessScale));
  });
}
export function patchRingThicknessScale(object, scale) {
  return withRing(object, (ring) => {
    const { preset } = getRingThicknessState(ring);
    ring.thicknessPreset = preset;
    ring.thicknessScale = clampScale(scale);
    ring.thickness = Math.max(MIN_THICKNESS_PX, round2(THICKNESS_BASES[preset] * ring.thicknessScale));
  });
}
export function patchRingColor(object, color) {
  return withRing(object, (ring) => { ring.color = color; });
}

/**
 * Sets an EXPLICIT gap between the dot's outer edge and the ring's inner edge, in reference pixels via the
 * small/medium/large table, then recomputes `ring.width` (and its preset/scale) so the existing "Ring size"
 * display still describes the resulting ring truthfully — even though, once a gap is set, rendering uses the
 * gap directly (effectiveRingGapPx) rather than `ring.width`. `canvasSize` is only needed for that
 * width-for-display conversion; the gap value itself is stored canvas-independent, like thickness.
 */
// The scale/preset "already chosen for gap," used INSIDE the patch functions — unlike getRingGapState (which
// derives a sensible display value from the current width when no gap has ever been set, for the panel to
// show something reasonable before the doctor has touched it), this defaults scale to a neutral 1. Reusing
// getRingGapState's derived-from-width scale here would apply a scale computed against ONE preset's base to
// a DIFFERENT preset the doctor just picked (e.g. computing "2.35x" against the medium base, then multiplying
// the small base by 2.35x) — correct only once a real gap has been chosen, which this only runs before that.
function currentGapChoice(ring) {
  return { preset: GAP_PRESET_KEYS.includes(ring.gapPreset) ? ring.gapPreset : DEFAULT_GAP_PRESET, scale: isNum(ring.gapScale) ? ring.gapScale : 1 };
}
export function patchRingGapPreset(object, canvasSize, preset) {
  if (!GAP_PRESET_KEYS.includes(preset)) return {};
  return withRing(object, (ring) => {
    const { scale } = currentGapChoice(ring);
    ring.gapPreset = preset;
    ring.gapScale = clampScale(scale);
    ring.gap = round2(RING_GAP_BASES[preset] * ring.gapScale);
    syncRingWidthToGap(object, ring, canvasSize.width);
  });
}
export function patchRingGapScale(object, canvasSize, scale) {
  return withRing(object, (ring) => {
    const { preset } = currentGapChoice(ring);
    ring.gapPreset = preset;
    ring.gapScale = clampScale(scale);
    ring.gap = round2(RING_GAP_BASES[preset] * ring.gapScale);
    syncRingWidthToGap(object, ring, canvasSize.width);
  });
}
function syncRingWidthToGap(object, ring, canvasWidth) {
  const dotRadiusPx = ((isNum(object.width) ? object.width : 0.03) / 2) * canvasWidth;
  const ringRadiusPx = dotRadiusPx + ring.gap + (isNum(ring.thickness) ? ring.thickness : 0) / 2;
  ring.width = round4((2 * ringRadiusPx) / canvasWidth);
  const sizeState = getRingSizeState(ring);
  ring.sizePreset = sizeState.preset;
  ring.scale = sizeState.scale;
}

/** Resizing the composite on the canvas scales the dot AND the ring by the same factor. */
export function patchCompositeResize(object, factor) {
  const width = round4(object.width * factor);
  const metadata = cloneMeta(object);
  if (metadata.ring && isNum(metadata.ring.width)) metadata.ring.width = round4(metadata.ring.width * factor);
  // Attached rings scale with the dot: every ring thickness (and outline thickness) grows by the same factor, so
  // the whole stack keeps its proportions — and, being attached, it can never open a gap while it scales.
  if (Array.isArray(metadata.rings)) {
    metadata.rings.forEach((r) => {
      if (isValidThickness(r.thickness)) r.thickness = round2(r.thickness * factor);
      if (r.outline && isValidThickness(r.outline.thickness)) r.outline.thickness = round2(r.outline.thickness * factor);
    });
  }
  return { width, height: width, metadata };
}

// ------------------------------------------------------- Dot + attached rings (multi-ring)
/**
 * A Dot + Rings is still ONE object: type 'dot' whose `metadata.rings` is an ARRAY of rings, innermost first:
 *
 *     dot  →  rings[0] (touches the dot)  →  rings[1] (touches rings[0])  →  rings[2] …   (no maximum count)
 *
 * There is NO gap setting, anywhere, by design: every ring's inner edge IS the previous layer's outer edge.
 * A ring is just { color, thickness, outline } — its position is never stored, it is always calculated:
 *
 *     outer(dot)   = dotRadius
 *     outer(ring k) = outer(previous) + thickness(k)         centre-line radius = outer(previous) + thickness(k) / 2
 */
// Taken from the ONE palette (config/palette.js) by key — never re-declared here — so the colours a new ring cycles
// through are always colours the doctor can also pick by hand.
const RING_COLOR_KEYS = ['blue', 'green', 'orange', 'violet', 'red', 'teal'];
const RING_COLOR_CYCLE = Object.freeze(RING_COLOR_KEYS.map((k) => COLOR_PALETTE.find((c) => c.key === k).value));

/** The next ring's default: a visible thickness, a colour that differs from its neighbours, outline off. */
export function defaultRingEntry(index = 0) {
  return {
    color: RING_COLOR_CYCLE[index % RING_COLOR_CYCLE.length],
    thickness: DEFAULT_RING_THICKNESS,
    outline: { enabled: false, color: DEFAULT_OUTLINE_COLOR, thickness: DEFAULT_OUTLINE_THICKNESS },
  };
}

/** The dot's rings as clean entries (never mutated by reading). Anything malformed is skipped, never thrown on. */
export function getRings(object) {
  const raw = object && object.type === 'dot' && object.metadata && Array.isArray(object.metadata.rings) ? object.metadata.rings : [];
  return raw
    .filter((r) => r && typeof r === 'object')
    .map((r, i) => ({
      color: isColor(r.color) ? r.color : (object.color || RING_COLOR_CYCLE[i % RING_COLOR_CYCLE.length]),
      thickness: isValidThickness(r.thickness) ? r.thickness : DEFAULT_RING_THICKNESS,
      outline: normalizeOutline(r.outline),
    }));
}
export const hasRings = (object) => getRings(object).length > 0;
/** A dot still carrying the OLD single spaced ring (and none of the new kind). */
export const isLegacyRingObject = (object) => hasActiveRing(object) && !hasRings(object);

function withRings(object, mutate) {
  if (!object || object.type !== 'dot') return {};
  const metadata = cloneMeta(object);
  metadata.rings = Array.isArray(metadata.rings) ? metadata.rings : [];
  mutate(metadata);
  return { metadata };
}

/** The legacy single ring expressed as the first attached ring (its colour and thickness carry over; its GAP does not exist any more). */
export function convertLegacyRing(object) {
  if (!isLegacyRingObject(object)) return {};
  const legacy = getRing(object);
  return withRings(object, (m) => {
    m.rings = [{
      color: legacy.color,
      thickness: isValidThickness(legacy.thickness) ? legacy.thickness : DEFAULT_RING_THICKNESS,
      outline: { enabled: false, color: DEFAULT_OUTLINE_COLOR, thickness: DEFAULT_OUTLINE_THICKNESS },
    }];
    delete m.ring;
  });
}

/** "+ Add Ring": appends the next ring with sensible defaults. Converts an older single ring first, so nothing is lost. */
export function addRing(object) {
  if (!object || object.type !== 'dot') return {};
  const base = isLegacyRingObject(object) ? { ...object, metadata: convertLegacyRing(object).metadata } : object;
  return withRings(base, (m) => { m.rings.push(defaultRingEntry(m.rings.length)); });
}
export function removeRingAt(object, index) {
  return withRings(object, (m) => { if (index >= 0 && index < m.rings.length) m.rings.splice(index, 1); });
}
/** Changes one ring independently: { color?, thickness?, outline?: { enabled?, color?, thickness? } }. Invalid values are ignored. */
export function patchRingAt(object, index, patch) {
  const base = isLegacyRingObject(object) ? { ...object, metadata: convertLegacyRing(object).metadata } : object;
  return withRings(base, (m) => {
    const ring = m.rings[index];
    if (!ring || !patch) return;
    if (isColor(patch.color)) ring.color = patch.color;
    if (isValidThickness(patch.thickness)) ring.thickness = round2(patch.thickness);
    if (patch.outline) ring.outline = mergeOutline(ring.outline, patch.outline);
  });
}

/**
 * Every ring of a Dot + Rings (or the single legacy ring) as drawable layers, innermost first, in reference pixels.
 * This is the ONE place radii are worked out — Studio, the public page and the PDF all draw from it.
 *   { radius (centre-line, what a stroke is drawn at), thickness, color, outline, innerRadius, outerRadius, legacy }
 * For the new model: innerRadius === the previous layer's outerRadius exactly (zero gap, by construction).
 */
export function compositeRingLayers(object, canvasWidth) {
  if (!object || object.type !== 'dot') return [];
  const dotRadius = ((isNum(object.width) ? object.width : 0.03) / 2) * canvasWidth;
  const rings = getRings(object);
  if (rings.length) {
    let outer = dotRadius;
    return rings.map((r) => {
      const innerRadius = outer;
      outer += r.thickness;
      return { radius: innerRadius + r.thickness / 2, thickness: r.thickness, color: r.color, outline: r.outline, innerRadius, outerRadius: outer, legacy: false };
    });
  }
  if (hasActiveRing(object)) {
    const ring = getRing(object);
    const thickness = isNum(ring.thickness) ? ring.thickness : 0;
    const gap = effectiveRingGapPx(object, ring, canvasWidth);
    const innerRadius = dotRadius + gap;
    return [{ radius: innerRadius + thickness / 2, thickness, color: ring.color, outline: null, innerRadius, outerRadius: innerRadius + thickness, legacy: true }];
  }
  return [];
}
/** Radius, in reference pixels, of the outermost edge of the dot and all its rings. */
export function compositeOuterRadius(object, canvasWidth) {
  const layers = compositeRingLayers(object, canvasWidth);
  if (layers.length) return layers[layers.length - 1].outerRadius;
  return ((isNum(object && object.width) ? object.width : 0.03) / 2) * canvasWidth;
}

// ----------------------------------------------------------------- Finger Band
export const BAND_TYPES = Object.freeze(['plain', 'double']);
export const BAND_TYPE_LABELS = Object.freeze({ plain: 'Plain band', double: 'Double band' });
const DEFAULT_BAND_POSITION = 0.35;

export function getBand(object) {
  const b = (object && object.metadata && object.metadata.band) || {};
  return {
    type: BAND_TYPES.includes(b.type) ? b.type : 'plain',
    position: clamp01(isNum(b.position) ? b.position : DEFAULT_BAND_POSITION),
    rotationOffset: isNum(b.rotationOffset) ? b.rotationOffset : 0,
  };
}

function bandPatch(object, viewKey, canvas, { finger, position, rotationOffset, type }) {
  const current = getBand(object);
  const fingerName = canonicalFingerName(finger !== undefined ? finger : object.finger);
  const band = {
    type: type !== undefined ? type : current.type,
    position: round3(clamp01(position !== undefined ? position : current.position)),
    rotationOffset: round2(rotationOffset !== undefined ? rotationOffset : current.rotationOffset),
  };
  const metadata = cloneMeta(object);
  metadata.band = band;
  const place = fingerName ? bandPlacement(viewKey, fingerName, band.position, canvas, band.rotationOffset) : null;
  return { finger: fingerName, metadata, ...(place || {}) };
}

export function patchBandFinger(object, viewKey, canvas, finger) {
  return bandPatch(object, viewKey, canvas, { finger });
}
export function patchBandPosition(object, viewKey, canvas, position) {
  return bandPatch(object, viewKey, canvas, { position });
}
export function patchBandType(object, type) {
  if (!BAND_TYPES.includes(type)) return {};
  const metadata = cloneMeta(object);
  metadata.band = { ...getBand(object), type };
  return { metadata };
}
export function patchBandRotationOffset(object, viewKey, canvas, offset) {
  return bandPatch(object, viewKey, canvas, { rotationOffset: Math.max(-90, Math.min(90, offset)) });
}
/** After a drag: snap the band back onto the finger's axis and record where along it the band now sits. */
export function patchBandDrag(object, viewKey, canvas, nx, ny) {
  const proj = object.finger ? projectToAxis(viewKey, object.finger, canvas, nx, ny) : null;
  return proj ? bandPatch(object, viewKey, canvas, { position: proj.t }) : { x: round4(nx), y: round4(ny) };
}
/** After a Transformer resize/rotate on the canvas: the new width, and any turn becomes an offset from "across the finger". */
export function patchBandTransform(object, viewKey, canvas, { widthNorm, rotation }) {
  const patch = {};
  if (isNum(widthNorm)) patch.width = round4(widthNorm);
  if (isNum(rotation) && object.finger && getGuide(viewKey, object.finger)) {
    const across = normalizeBandDeg(axisAngleDeg(viewKey, object.finger, canvas) + 90);
    const offset = Math.max(-90, Math.min(90, normalizeBandDeg(rotation - across)));
    Object.assign(patch, bandPatch(object, viewKey, canvas, { rotationOffset: offset }));
  } else if (isNum(rotation)) {
    patch.rotation = round2(rotation);
  }
  return patch;
}
/** Sets the band's width to match the finger it is on. */
export function patchBandFitToFinger(object, viewKey) {
  const g = object.finger ? getGuide(viewKey, object.finger) : null;
  if (!g) return {};
  return patchSizeToWidth(object, round4(g.width * 0.95));
}

/** Sets an exact width (keeping the current preset) and records the resulting scale. */
export function patchSizeToWidth(object, width) {
  const { preset } = getSizeState(object);
  const base = sizeBase(object.type, preset);
  if (!base) return {};
  const metadata = cloneMeta(object);
  metadata.sizePreset = preset;
  metadata.scale = round3(width / base);
  return { width: round4(width), metadata };
}

// ------------------------------------------------------------------------ Text
export const TEXT_MAX_LENGTH = 200;
export const DEFAULT_TEXT = 'Text';

export function getText(object) {
  return object && object.metadata && typeof object.metadata.text === 'string' ? object.metadata.text : '';
}
export function patchText(object, text) {
  const metadata = cloneMeta(object);
  metadata.text = String(text === null || text === undefined ? '' : text).slice(0, TEXT_MAX_LENGTH);
  return { metadata };
}

// -------------------------------------------------------------- object factory
/**
 * Builds a new object for a palette tool at normalized (x, y).
 *  ctx = { viewKey, canvasWidth, canvasHeight }  (needed only to place a Finger Band)
 * Returns null when the object cannot be created (a Finger Band on a view with no finger guides).
 */
export function createStudioObject(tool, x, y, ctx = {}) {
  const type = tool === 'dotRing' ? 'dot' : tool;
  const object = deepClone(createDefaultObject(type, x, y));
  const metadata = {};

  if (supports(type, 'size')) {
    const base = sizeBase(type, DEFAULT_SIZE_PRESET);
    object.width = base;
    if (UNIFORM_TYPES.has(type)) object.height = base;
    if (type === 'rectangle') object.height = sizeBase('rectangle', DEFAULT_SIZE_PRESET, 'height');
    metadata.sizePreset = DEFAULT_SIZE_PRESET;
    metadata.scale = 1;
  }
  if (supports(type, 'thickness')) {
    object.thickness = THICKNESS_BASES[DEFAULT_THICKNESS_PRESET]; // a plain number; thickness is free, not a preset
  }
  object.metadata = metadata;

  if (tool === 'dotRing') metadata.rings = [defaultRingEntry(0)];
  if (type === 'text') metadata.text = DEFAULT_TEXT;

  if (type === 'fingerBand') {
    if (!hasGuides(ctx.viewKey)) return null;
    const canvas = { width: ctx.canvasWidth, height: ctx.canvasHeight };
    const near = nearestFinger(ctx.viewKey, canvas, x, y);
    if (!near) return null;
    const guide = getGuide(ctx.viewKey, near.finger);
    metadata.band = { type: 'plain', position: round3(near.t), rotationOffset: 0 };
    object.finger = near.finger;
    object.width = round4(guide.width * 0.95);
    metadata.scale = round3(object.width / sizeBase('fingerBand', DEFAULT_SIZE_PRESET));
    Object.assign(object, bandPlacement(ctx.viewKey, near.finger, near.t, canvas, 0));
    object.landmarkReference = null; // reserved for a future AR mapping; deliberately not filled in by this phase
  }
  return object;
}

/**
 * Where a copy/duplicate goes: nudged so it does not sit exactly on the original. Ordinary objects move
 * down-right (as they always have); a Finger Band slides along its finger, and is re-placed on the
 * TARGET view's finger (it may be pasted onto a different hand view).
 *  target = { viewKey, canvas: {width, height} }
 */
export function offsetForCopy(object, target = {}) {
  if (object.type === 'fingerBand' && object.finger && target.viewKey && hasGuides(target.viewKey) && target.canvas) {
    const pos = getBand(object).position;
    const next = pos + 0.08 <= 1 ? pos + 0.08 : pos - 0.08;
    return bandPatch(object, target.viewKey, target.canvas, { position: next });
  }
  return { x: Math.min(0.95, object.x + 0.04), y: Math.min(0.95, object.y + 0.04) };
}
