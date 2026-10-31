import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_OBJECT_COLOR } from './config/palette';
import { SIZE_BASES } from './config/sizePresets';

export const OBJECT_TYPES = [
  { type: 'dot', label: 'Dot' },
  { type: 'ring', label: 'Ring / Circle' },
  { type: 'hline', label: 'Horizontal Line' },
  { type: 'vline', label: 'Vertical Line' },
  { type: 'freeline', label: 'Free Line' },
  { type: 'invertedTriangle', label: 'Inverted Triangle' },
  { type: 'triangle', label: 'Triangle' },
  { type: 'rectangle', label: 'Rectangle' },
  { type: 'square', label: 'Square' },
  { type: 'arrow', label: 'Arrow' },
  // Added with the Protocol Studio. Both keep their extra data inside `metadata` (see model/objectModel.js).
  { type: 'fingerBand', label: 'Finger Band' },
  { type: 'text', label: 'Text' },
];

const DEFAULT_COLOR = DEFAULT_OBJECT_COLOR; // the palette's first colour, the same red as always

/**
 * Build a brand-new protocol object of `type` centered at normalized (x, y).
 * All size fields are normalized 0-1 fractions of the canvas's reference
 * width/height (see backend/src/config/handAssets.js) so they stay valid
 * no matter what pixel size the canvas is rendered at — this is also what
 * lets the same data be consumed later by the AR hand-landmark system.
 */
export function createDefaultObject(type, x, y) {
  const base = {
    id: uuidv4(),
    type,
    x,
    y,
    rotation: 0,
    color: DEFAULT_COLOR,
    thickness: 3,
    opacity: 1,
    width: null,
    height: null,
    points: null,
    finger: null,
    landmarkReference: null,
    metadata: {},
    zIndex: Date.now(),
  };

  switch (type) {
    case 'dot':
      return { ...base, width: 0.03, height: 0.03, thickness: 0 };
    case 'ring':
      return { ...base, width: 0.08, height: 0.08, thickness: 4 };
    case 'hline':
      return { ...base, width: 0.18, height: null, rotation: 0, thickness: 4 };
    case 'vline':
      return { ...base, width: 0.18, height: null, rotation: 90, thickness: 4 };
    case 'arrow':
      return { ...base, width: 0.18, height: null, rotation: 0, thickness: 4 };
    case 'freeline':
      return {
        ...base,
        points: [
          { x, y },
          { x: x + 0.08, y: y + 0.05 },
        ],
        thickness: 4,
      };
    case 'invertedTriangle':
      return { ...base, width: 0.12, height: 0.12, rotation: 180, thickness: 3 };
    case 'triangle':
      return { ...base, width: 0.12, height: 0.12, rotation: 0, thickness: 3 };
    case 'rectangle':
      return { ...base, width: 0.16, height: 0.1, thickness: 3 };
    case 'square':
      return { ...base, width: 0.1, height: 0.1, thickness: 3 };
    case 'fingerBand':
      // Simple fallback. The Studio creates bands through model/objectModel.js, which places them on a finger.
      return { ...base, width: SIZE_BASES.fingerBand.medium, height: null, thickness: 4 };
    case 'text':
      return { ...base, width: SIZE_BASES.text.medium, height: null, thickness: 0, metadata: { text: 'Text' } };
    default:
      return base;
  }
}

// Canonical finger names. Older saved protocols may still contain "pinky";
// it stays readable (fingerForDisplay maps it) and is written back as
// "little" the next time it is saved. Mirrors backend/src/protocol/vocabulary.js.
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];
export const LEGACY_FINGER_ALIASES = { pinky: 'little' };

export function fingerForDisplay(finger) {
  if (!finger) return '';
  return LEGACY_FINGER_ALIASES[finger] || finger;
}
