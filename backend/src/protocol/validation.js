/**
 * Publish-time validation (pure: works on a candidate snapshot plus the
 * category/condition rows it references; no database access).
 *
 * Drafts may be incomplete — the builder saves whatever the doctor has drawn.
 * These rules apply only when a protocol is about to become PUBLIC, and they
 * validate exactly the snapshot that is about to be frozen.
 *
 * Every problem is reported (not just the first) as
 *   { code, path, message }
 * so a UI can show them all at once.
 */
const { OBJECT_TYPES, FINGERS, LEGACY_FINGER_ALIASES } = require('./vocabulary');
const { isValidSlug } = require('../services/slug');
const { canonicalStringify } = require('./snapshot');
const { HAND_VIEW_ORDER } = require('../config/handAssets');
const { ORGAN_ASSETS } = require('../config/organAssets');

const LIMITS = Object.freeze({
  NAME: 120,
  DISPLAY_NAME: 120,
  SHORT_DESCRIPTION: 300,
  DESCRIPTION: 20000,
  SNAPSHOT_BYTES: 1_000_000,
  MAX_OBJECTS: 500,
  MAX_POINTS: 2000,
  // There is deliberately NO maximum thickness (a stroke thick enough to cover a whole hand is legitimate) and NO
  // maximum ring count. What bounds a protocol is its total size (SNAPSHOT_BYTES) and the request body limit.
});

// Fields each object type must carry to be drawable (matches the builder's defaults).
// (fingerBand: span across the finger; text: font size — both as a fraction of the canvas width)
const NEEDS_WIDTH = new Set(['dot', 'ring', 'hline', 'vline', 'arrow', 'triangle', 'invertedTriangle', 'rectangle', 'square', 'fingerBand', 'text']);
const NEEDS_HEIGHT = new Set(['triangle', 'invertedTriangle', 'rectangle', 'square']);

// Hex colours only: the value ends up in canvas/SVG drawing code, so free text is not accepted.
// Sizes are Small / Medium / Large / Extra Large. The three-value list is what OLDER data used for thickness and
// gap presets (thickness is a free number now; only the legacy single spaced ring still has a gap) — still readable.
const SIZE_PRESETS = ['small', 'medium', 'large', 'xl'];
const LEGACY_PRESETS = ['small', 'medium', 'large'];
const BAND_TYPES = ['plain', 'double'];
const TEXT_MAX = 200;
const CANONICAL_FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const inUnitRange = (v) => isFiniteNumber(v) && v >= 0 && v <= 1;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The Studio keeps its structured data in `object.metadata` (size/thickness presets and scale, the ring of a
 * Dot + Ring, a Finger Band's details, text). Only the STRUCTURE is checked here — the public API still just
 * carries the data through untouched.
 */
function validateOutline(ol, path, label, add) {
  if (!isPlainObject(ol)) return add('OUTLINE_INVALID', path, `${label}: outline must be an object.`);
  if (ol.enabled !== undefined && typeof ol.enabled !== 'boolean') add('OUTLINE_INVALID', `${path}.enabled`, `${label}: outline.enabled must be true or false.`);
  if (ol.color !== undefined && (typeof ol.color !== 'string' || !COLOR_RE.test(ol.color))) add('COLOR_INVALID', `${path}.color`, `${label}: outline.color must be a hex colour.`);
  if (ol.thickness !== undefined && !(isFiniteNumber(ol.thickness) && ol.thickness > 0)) add('OUTLINE_INVALID', `${path}.thickness`, `${label}: outline.thickness must be a finite number above 0 (there is no upper limit).`);
  return undefined;
}

function validateStudioData(o, path, label, add) {
  const m = isPlainObject(o.metadata) ? o.metadata : {};
  const scaleOk = (v) => isFiniteNumber(v) && v > 0 && v <= 10;
  if (m.sizePreset !== undefined && !SIZE_PRESETS.includes(m.sizePreset)) add('SIZE_PRESET_INVALID', `${path}.metadata.sizePreset`, `${label}: sizePreset must be one of ${SIZE_PRESETS.join(', ')} (got ${JSON.stringify(m.sizePreset)}).`);
  if (m.thicknessPreset !== undefined && !LEGACY_PRESETS.includes(m.thicknessPreset)) add('THICKNESS_PRESET_INVALID', `${path}.metadata.thicknessPreset`, `${label}: thicknessPreset must be one of ${LEGACY_PRESETS.join(', ')}.`);
  if (m.scale !== undefined && !scaleOk(m.scale)) add('SCALE_INVALID', `${path}.metadata.scale`, `${label}: scale must be a number above 0 and at most 10.`);
  if (m.thicknessScale !== undefined && !scaleOk(m.thicknessScale)) add('SCALE_INVALID', `${path}.metadata.thicknessScale`, `${label}: thicknessScale must be a number above 0 and at most 10.`);

  if (m.ring !== undefined) {
    const r = m.ring;
    if (!isPlainObject(r)) {
      add('RING_INVALID', `${path}.metadata.ring`, `${label}: ring must be an object.`);
    } else {
      if (typeof r.enabled !== 'boolean') add('RING_INVALID', `${path}.metadata.ring.enabled`, `${label}: ring.enabled must be true or false.`);
      if (r.sizePreset !== undefined && !SIZE_PRESETS.includes(r.sizePreset)) add('SIZE_PRESET_INVALID', `${path}.metadata.ring.sizePreset`, `${label}: ring sizePreset must be one of ${SIZE_PRESETS.join(', ')}.`);
      if (r.thicknessPreset !== undefined && !LEGACY_PRESETS.includes(r.thicknessPreset)) add('THICKNESS_PRESET_INVALID', `${path}.metadata.ring.thicknessPreset`, `${label}: ring thicknessPreset must be one of ${LEGACY_PRESETS.join(', ')}.`);
      if (!(isFiniteNumber(r.width) && r.width > 0 && r.width <= 1)) add('RING_INVALID', `${path}.metadata.ring.width`, `${label}: ring.width must be a number above 0 and at most 1.`);
      if (!(isFiniteNumber(r.thickness) && r.thickness >= 0)) add('RING_INVALID', `${path}.metadata.ring.thickness`, `${label}: ring.thickness must be a finite number, 0 or more (there is no upper limit).`);
      // Optional, like every other ring field above: a ring predating independent ring colours (or hand-written/
      // imported data) has no colour of its own and falls back to the dot's colour wherever it is read (the
      // Studio's getRing(), and the public projection's consumers do the same) — so its absence here must not
      // block publishing. A PRESENT-but-invalid colour is still rejected, unchanged from before.
      if (r.color !== undefined && (typeof r.color !== 'string' || !COLOR_RE.test(r.color))) add('COLOR_INVALID', `${path}.metadata.ring.color`, `${label}: ring.color must be a hex colour.`);
      if (r.gapPreset !== undefined && !LEGACY_PRESETS.includes(r.gapPreset)) add('SIZE_PRESET_INVALID', `${path}.metadata.ring.gapPreset`, `${label}: ring gapPreset must be one of ${LEGACY_PRESETS.join(', ')}.`);
      if (r.gapScale !== undefined && !scaleOk(r.gapScale)) add('SCALE_INVALID', `${path}.metadata.ring.gapScale`, `${label}: ring gapScale must be a number above 0 and at most 10.`);
      if (r.gap !== undefined && !(isFiniteNumber(r.gap) && r.gap >= 0)) add('RING_INVALID', `${path}.metadata.ring.gap`, `${label}: ring.gap must be a finite number, 0 or more.`);
    }
    if (o.type !== 'dot') add('RING_INVALID', `${path}.metadata.ring`, `${label}: only a dot can carry a ring.`);
  }

  // Outline (any shape): { enabled, color, thickness }. Every field is optional, but one that is present must be valid.
  if (m.outline !== undefined) validateOutline(m.outline, `${path}.metadata.outline`, label, add);

  // Attached rings of a Dot + Rings: an ARRAY, innermost first. No maximum count and no maximum thickness; there is no
  // gap field because rings always touch (a stray `gap` on an entry is simply not part of the model and is ignored).
  if (m.rings !== undefined) {
    if (!Array.isArray(m.rings)) {
      add('RINGS_INVALID', `${path}.metadata.rings`, `${label}: rings must be a list.`);
    } else {
      m.rings.forEach((r, i) => {
        const rp = `${path}.metadata.rings[${i}]`;
        if (!isPlainObject(r)) return add('RINGS_INVALID', rp, `${label}: ring ${i + 1} must be an object.`);
        if (r.color !== undefined && (typeof r.color !== 'string' || !COLOR_RE.test(r.color))) add('COLOR_INVALID', `${rp}.color`, `${label}: ring ${i + 1} colour must be a hex colour.`);
        if (!(isFiniteNumber(r.thickness) && r.thickness > 0)) add('RINGS_INVALID', `${rp}.thickness`, `${label}: ring ${i + 1} thickness must be a finite number above 0 (there is no upper limit).`);
        if (r.outline !== undefined) validateOutline(r.outline, `${rp}.outline`, `${label}: ring ${i + 1}`, add);
        return undefined;
      });
    }
    if (o.type !== 'dot') add('RINGS_INVALID', `${path}.metadata.rings`, `${label}: only a dot can carry rings.`);
  }

  if (o.type === 'fingerBand') {
    if (!CANONICAL_FINGERS.includes(o.finger) && o.finger !== 'pinky') add('FINGER_REQUIRED', `${path}.finger`, `${label}: a finger band must name its finger (${CANONICAL_FINGERS.join(', ')}).`);
    const b = m.band;
    if (b !== undefined) {
      if (!isPlainObject(b)) {
        add('BAND_INVALID', `${path}.metadata.band`, `${label}: band must be an object.`);
      } else {
        if (b.type !== undefined && !BAND_TYPES.includes(b.type)) add('BAND_INVALID', `${path}.metadata.band.type`, `${label}: band type must be one of ${BAND_TYPES.join(', ')}.`);
        if (b.position !== undefined && !inUnitRange(b.position)) add('BAND_INVALID', `${path}.metadata.band.position`, `${label}: band position must be between 0 and 1.`);
        if (b.rotationOffset !== undefined && !isFiniteNumber(b.rotationOffset)) add('BAND_INVALID', `${path}.metadata.band.rotationOffset`, `${label}: band rotationOffset must be a number.`);
      }
    }
  }

  if (o.type === 'text') {
    if (typeof m.text !== 'string' || !m.text.trim()) add('TEXT_REQUIRED', `${path}.metadata.text`, `${label}: a text object needs some text.`);
    else if (m.text.length > TEXT_MAX) add('TEXT_TOO_LONG', `${path}.metadata.text`, `${label}: text must be at most ${TEXT_MAX} characters.`);
  }
}

function validateObject(o, path, add) {
  if (!isPlainObject(o)) return add('OBJECT_INVALID', path, 'Object must be a JSON object.');
  const label = `${path} (${o.type || 'unknown type'})`;

  if (typeof o.id !== 'string' || !o.id) add('OBJECT_ID_MISSING', `${path}.id`, `${label}: id is required.`);
  if (!OBJECT_TYPES.includes(o.type)) {
    add('OBJECT_TYPE_UNKNOWN', `${path}.type`, `${label}: unknown object type "${o.type}". Known: ${OBJECT_TYPES.join(', ')}.`);
    return undefined; // type-specific rules make no sense for an unknown type
  }

  if (!inUnitRange(o.x)) add('COORDINATE_INVALID', `${path}.x`, `${label}: x must be a number between 0 and 1 (got ${o.x}).`);
  if (!inUnitRange(o.y)) add('COORDINATE_INVALID', `${path}.y`, `${label}: y must be a number between 0 and 1 (got ${o.y}).`);

  const sizeOk = (v) => isFiniteNumber(v) && v > 0 && v <= 1;
  if (NEEDS_WIDTH.has(o.type) && !sizeOk(o.width)) add('SIZE_INVALID', `${path}.width`, `${label}: width must be a number greater than 0 and at most 1 (got ${o.width}).`);
  if (NEEDS_HEIGHT.has(o.type) && !sizeOk(o.height)) add('SIZE_INVALID', `${path}.height`, `${label}: height must be a number greater than 0 and at most 1 (got ${o.height}).`);
  if (!NEEDS_WIDTH.has(o.type) && o.width !== null && o.width !== undefined && !sizeOk(o.width)) add('SIZE_INVALID', `${path}.width`, `${label}: width, if set, must be greater than 0 and at most 1.`);
  if (!NEEDS_HEIGHT.has(o.type) && o.height !== null && o.height !== undefined && !sizeOk(o.height)) add('SIZE_INVALID', `${path}.height`, `${label}: height, if set, must be greater than 0 and at most 1.`);

  if (!isFiniteNumber(o.rotation)) add('ROTATION_INVALID', `${path}.rotation`, `${label}: rotation must be a number.`);
  if (typeof o.color !== 'string' || !COLOR_RE.test(o.color)) add('COLOR_INVALID', `${path}.color`, `${label}: color must be a hex colour such as #e5484d (got ${JSON.stringify(o.color)}).`);
  if (!isFiniteNumber(o.thickness) || o.thickness < 0) add('THICKNESS_INVALID', `${path}.thickness`, `${label}: thickness must be a finite number, 0 or more — there is no upper limit (got ${JSON.stringify(o.thickness)}).`);
  if (!inUnitRange(o.opacity)) add('OPACITY_INVALID', `${path}.opacity`, `${label}: opacity must be a number between 0 and 1 (got ${o.opacity}).`);
  if (!isFiniteNumber(o.zIndex)) add('ZINDEX_INVALID', `${path}.zIndex`, `${label}: zIndex must be a number.`);

  if (o.type === 'freeline') {
    if (!Array.isArray(o.points) || o.points.length < 2) {
      add('POINTS_INVALID', `${path}.points`, `${label}: a free line needs at least 2 points.`);
    } else if (o.points.length > LIMITS.MAX_POINTS) {
      add('POINTS_INVALID', `${path}.points`, `${label}: too many points (${o.points.length}; maximum ${LIMITS.MAX_POINTS}).`);
    } else if (!o.points.every((p) => isPlainObject(p) && inUnitRange(p.x) && inUnitRange(p.y))) {
      add('POINTS_INVALID', `${path}.points`, `${label}: every point must have x and y between 0 and 1.`);
    }
  }

  if (o.finger !== null && o.finger !== undefined && !FINGERS.includes(o.finger) && !Object.prototype.hasOwnProperty.call(LEGACY_FINGER_ALIASES, o.finger)) {
    add('FINGER_INVALID', `${path}.finger`, `${label}: unknown finger "${o.finger}". Known: ${FINGERS.join(', ')}.`);
  }
  validateStudioData(o, path, label, add);
  if (o.landmarkReference !== null && o.landmarkReference !== undefined && !isPlainObject(o.landmarkReference)) add('LANDMARK_INVALID', `${path}.landmarkReference`, `${label}: landmarkReference must be an object or null.`);
  if (o.metadata !== null && o.metadata !== undefined && !isPlainObject(o.metadata)) add('METADATA_INVALID', `${path}.metadata`, `${label}: metadata must be an object or null.`);
  return undefined;
}

/**
 * @param working  the loaded working copy ({protocol, category, conditions, ...}) — for reference checks
 * @param snapshot the candidate schema-2 snapshot that would be frozen
 * @returns {Array<{code:string, path:string, message:string}>} empty when publishable
 */
function validateForPublish(working, snapshot) {
  const errors = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  const p = snapshot.protocol;

  // ---- metadata --------------------------------------------------------
  if (typeof p.name !== 'string' || !p.name.trim()) add('NAME_REQUIRED', 'protocol.name', 'Protocol name is required.');
  else if (p.name.length > LIMITS.NAME) add('NAME_TOO_LONG', 'protocol.name', `Protocol name must be at most ${LIMITS.NAME} characters.`);
  if (!isValidSlug(p.slug)) add('SLUG_INVALID', 'protocol.slug', 'Slug must be lowercase letters, digits and single hyphens (max 80 characters).');
  if (p.displayName && p.displayName.length > LIMITS.DISPLAY_NAME) add('DISPLAY_NAME_TOO_LONG', 'protocol.displayName', `Display name must be at most ${LIMITS.DISPLAY_NAME} characters.`);
  if (p.shortDescription.length > LIMITS.SHORT_DESCRIPTION) add('SHORT_DESCRIPTION_TOO_LONG', 'protocol.shortDescription', `Short description must be at most ${LIMITS.SHORT_DESCRIPTION} characters.`);
  if (p.description.length > LIMITS.DESCRIPTION) add('DESCRIPTION_TOO_LONG', 'protocol.description', `Description must be at most ${LIMITS.DESCRIPTION} characters.`);
  if (!isPlainObject(p.metadata)) add('METADATA_INVALID', 'protocol.metadata', 'Protocol metadata must be a JSON object.');

  // ---- references (category / conditions) -------------------------------
  if (working.protocol.category_id) {
    if (!working.category) add('CATEGORY_MISSING', 'protocol.category', 'The protocol refers to a category that no longer exists.');
    else if (!working.category.is_active) add('CATEGORY_INACTIVE', 'protocol.category', `Category "${working.category.name}" is inactive. Activate it or choose another before publishing.`);
  }
  working.conditions.forEach((c, i) => {
    if (!c.is_active) add('CONDITION_INACTIVE', `protocol.conditions[${i}]`, `Condition "${c.name}" is inactive. Activate it or detach it before publishing.`);
  });

  // ---- canvases ---------------------------------------------------------
  if (!snapshot.canvases.length) add('NO_CANVAS', 'canvases', 'The protocol has no views (canvases).');
  const seenViews = new Set();
  let objectCount = 0;
  const seenObjectIds = new Set();

  snapshot.canvases.forEach((c, ci) => {
    const cp = `canvases[${ci}]`;
    if (seenViews.has(c.viewKey)) add('VIEW_DUPLICATE', `${cp}.viewKey`, `View "${c.viewKey}" appears more than once.`);
    seenViews.add(c.viewKey);

    const knownView = c.canvasType === 'hand' ? HAND_VIEW_ORDER.includes(c.viewKey) : c.canvasType === 'organ' && Boolean(ORGAN_ASSETS[c.viewKey]);
    if (!knownView) add('VIEW_UNKNOWN', `${cp}.viewKey`, `Unknown ${c.canvasType} view "${c.viewKey}".`);
    if (c.isPlaceholderAsset) add('PLACEHOLDER_ASSET', `${cp}.backgroundAssetKey`, `View "${c.viewKey}" uses a placeholder background image; a protocol cannot be published on a placeholder.`);
    if (!Number.isInteger(c.width) || c.width <= 0 || !Number.isInteger(c.height) || c.height <= 0) add('CANVAS_SIZE_INVALID', `${cp}`, `View "${c.viewKey}" has an invalid reference size.`);

    if (!Array.isArray(c.objects)) {
      add('OBJECTS_INVALID', `${cp}.objects`, 'objects must be a list.');
      return;
    }
    c.objects.forEach((o, oi) => {
      objectCount += 1;
      if (o && typeof o.id === 'string') {
        if (seenObjectIds.has(o.id)) add('OBJECT_ID_DUPLICATE', `${cp}.objects[${oi}].id`, `Object id "${o.id}" is used more than once.`);
        seenObjectIds.add(o.id);
      }
      validateObject(o, `${cp}.objects[${oi}]`, add);
    });
  });

  if (objectCount === 0) add('NO_OBJECTS', 'canvases', 'The protocol has no markings on any view; there is nothing to publish.');
  if (objectCount > LIMITS.MAX_OBJECTS) add('TOO_MANY_OBJECTS', 'canvases', `The protocol has ${objectCount} objects; the maximum is ${LIMITS.MAX_OBJECTS}.`);

  // ---- must be serializable, and not absurdly large ---------------------
  try {
    const text = canonicalStringify(snapshot);
    if (Buffer.byteLength(text, 'utf8') > LIMITS.SNAPSHOT_BYTES) add('SNAPSHOT_TOO_LARGE', 'snapshot', `The protocol data is larger than ${LIMITS.SNAPSHOT_BYTES} bytes.`);
  } catch (err) {
    add('SNAPSHOT_NOT_SERIALIZABLE', 'snapshot', `The protocol data cannot be serialized: ${err.message}`);
  }
  return errors;
}

module.exports = { validateForPublish, LIMITS, NEEDS_WIDTH, NEEDS_HEIGHT };
