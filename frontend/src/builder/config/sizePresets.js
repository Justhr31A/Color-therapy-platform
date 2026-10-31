/**
 * Size and thickness presets — the single source for every numeric preset
 * value. Nothing else in the Studio hard-codes them, so they can be tuned here
 * (and later served from settings) without touching any component.
 *
 * Sizes are exactly Small / Medium / Large / Extra Large. THICKNESS is a separate concept and is NOT a preset
 * any more: it is a freely adjustable positive number with no artificial maximum (a stroke thick enough to
 * cover a whole hand is legitimate). The three-value THICKNESS/GAP preset lists below are kept only so data
 * saved by earlier versions (metadata.thicknessPreset, legacy `metadata.ring` gap presets) still reads.
 *
 * A protocol object records
 * the doctor's INTENT as  metadata.sizePreset + metadata.scale  and also
 * stores the RESOLVED geometry in the long-standing columns (width / height /
 * thickness). Anything that only knows the old schema (the AR mapper, the
 * public render, older renderers) keeps working from those resolved values:
 *
 *     width = base(type, sizePreset) * scale
 *
 * Widths/heights are fractions of the canvas's reference width/height (the
 * existing normalized coordinate model). Thickness is in reference pixels,
 * exactly as the schema has always stored it.
 *
 * The MEDIUM values equal the defaults the builder has always produced, so
 * existing protocols and the meaning of "default size" are unchanged (a test
 * pins this).
 */
export const SIZE_PRESET_KEYS = Object.freeze(['small', 'medium', 'large', 'xl']);
export const SIZE_PRESET_LABELS = Object.freeze({ small: 'Small', medium: 'Medium', large: 'Large', xl: 'Extra Large' });
// The three-value lists that older data used for thickness and gap presets (read-only compatibility).
export const LEGACY_PRESET_KEYS = Object.freeze(['small', 'medium', 'large']);
export const LEGACY_PRESET_LABELS = Object.freeze({ small: 'Small', medium: 'Medium', large: 'Large' });
export const DEFAULT_SIZE_PRESET = 'medium';

// `width` per type. dot/ring/polygons: diameter; lines/arrow: length; text: font size; fingerBand: span across the finger.
export const SIZE_BASES = Object.freeze({
  dot: { small: 0.02, medium: 0.03, large: 0.045, xl: 0.065 },
  ring: { small: 0.05, medium: 0.08, large: 0.12, xl: 0.17 },
  hline: { small: 0.1, medium: 0.18, large: 0.28, xl: 0.4 },
  vline: { small: 0.1, medium: 0.18, large: 0.28, xl: 0.4 },
  arrow: { small: 0.1, medium: 0.18, large: 0.28, xl: 0.4 },
  triangle: { small: 0.08, medium: 0.12, large: 0.18, xl: 0.26 },
  invertedTriangle: { small: 0.08, medium: 0.12, large: 0.18, xl: 0.26 },
  rectangle: { small: 0.1, medium: 0.16, large: 0.24, xl: 0.34 },
  square: { small: 0.07, medium: 0.1, large: 0.15, xl: 0.22 },
  fingerBand: { small: 0.1, medium: 0.13, large: 0.16, xl: 0.2 },
  text: { small: 0.02, medium: 0.03, large: 0.045, xl: 0.065 },
});

// Only rectangles have an independent height.
export const SIZE_BASES_HEIGHT = Object.freeze({
  rectangle: { small: 0.06, medium: 0.1, large: 0.15, xl: 0.22 },
});

// Ring part of a Dot + Ring composite (diameter, fraction of canvas width).
export const RING_SIZE_BASES = Object.freeze({ small: 0.05, medium: 0.08, large: 0.12, xl: 0.17 });

// LEGACY: thickness used to be a Small/Medium/Large preset + scale. It is now a free number (see
// objectModel.patchThickness); these remain so older saved objects keep reading, and so the "Medium" default
// thickness a new object starts with is still defined in one place.
export const THICKNESS_PRESET_KEYS = LEGACY_PRESET_KEYS;
export const THICKNESS_PRESET_LABELS = LEGACY_PRESET_LABELS;
export const DEFAULT_THICKNESS_PRESET = 'medium';
export const THICKNESS_BASES = Object.freeze({ small: 2, medium: 4, large: 8 }); // reference pixels

// The empty space between a Dot + Ring's dot (outer edge) and its ring (inner edge), in reference pixels —
// the same units as THICKNESS_BASES, and for the same reason: a spacing that should look the same regardless
// of which of the (slightly different-sized) hand views it's drawn on, rather than scaling with canvas width.
// LEGACY: only the older single-ring `metadata.ring` model has a gap. The multi-ring model attaches every ring
// directly to the previous one (GAP = 0, always) and has no gap setting at all.
export const GAP_PRESET_KEYS = LEGACY_PRESET_KEYS;
export const GAP_PRESET_LABELS = LEGACY_PRESET_LABELS;
export const DEFAULT_GAP_PRESET = 'medium';
export const RING_GAP_BASES = Object.freeze({ small: 8, medium: 16, large: 28 });

// Custom scale multiplier limits (applies on top of a preset).
export const SCALE_LIMITS = Object.freeze({ min: 0.25, max: 3, step: 0.05 });

export const MIN_THICKNESS_PX = 0.5;

// ---- multi-ring Dot + Rings and outlines -------------------------------------------------------------
// What "+ Add Ring" gives a new ring, and what a freshly-enabled outline starts as. Reference pixels, like all
// thickness. There is deliberately NO maximum ring count and NO maximum thickness anywhere.
export const DEFAULT_RING_THICKNESS = 10;
export const DEFAULT_OUTLINE_COLOR = '#000000';
export const DEFAULT_OUTLINE_THICKNESS = 4;

export function sizeBase(type, preset, axis = 'width') {
  const table = axis === 'height' ? SIZE_BASES_HEIGHT[type] : SIZE_BASES[type];
  return table && table[preset] ? table[preset] : null;
}
