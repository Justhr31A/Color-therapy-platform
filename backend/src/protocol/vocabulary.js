/**
 * Shared protocol vocabulary (single definition used by the routes and the
 * tests, so lists cannot silently drift apart).
 *
 * OBJECT_TYPES is the set the API accepts: the original ten plus `fingerBand` and
 * `text` (added with the Protocol Studio; nothing was removed). (Decision
 * recorded for a later phase: rectangle and square become one logical
 * shape with independent width/height; both legacy types stay valid so
 * existing saved objects keep loading.)
 *
 * FINGERS: the canonical values going forward. The legacy value "pinky"
 * stays READABLE — old rows are never rewritten by this phase — and is
 * mapped to "little" when new data is written.
 */
const OBJECT_TYPES = Object.freeze([
  'dot',
  'ring',
  'hline',
  'vline',
  'freeline',
  'invertedTriangle',
  'triangle',
  'rectangle',
  'square',
  'arrow',
  // Added with the Protocol Studio. Their extra data lives in `metadata` (no schema change).
  'fingerBand',
  'text',
]);

const FINGERS = Object.freeze(['thumb', 'index', 'middle', 'ring', 'little']);

const LEGACY_FINGER_ALIASES = Object.freeze({ pinky: 'little' });

/**
 * Returns the canonical finger name for a value being written. Empty -> null.
 * A known legacy alias is mapped; any other value is returned untouched (the
 * API never rejected unknown fingers before, and this phase does not start).
 */
function canonicalFinger(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return value;
  const alias = LEGACY_FINGER_ALIASES[value.trim().toLowerCase()];
  return alias || value;
}

module.exports = { OBJECT_TYPES, FINGERS, LEGACY_FINGER_ALIASES, canonicalFinger };
