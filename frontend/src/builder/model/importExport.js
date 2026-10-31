/**
 * JSON export / import of a protocol's markings.
 *
 * The file is STRUCTURED protocol data (the same object shape the API stores), never an image:
 *   { format, version, exportedAt, protocol: { name, protocolType }, views: [{ viewKey, width, height, objects }] }
 *
 * Import is defensive by design — a file is untrusted input:
 *   - it never throws; problems come back as a list of readable errors;
 *   - only known fields are copied (anything else is dropped);
 *   - every value is range-checked (coordinates 0..1, hex colours, known types, presets small/medium/large, …);
 *   - every imported object gets a NEW id. Object ids are global database keys, so reusing the ids in a file
 *     would collide with the protocol it was exported from.
 * It replaces the objects of the views that appear in the file and leaves the other views untouched.
 */
import { v4 as uuidv4 } from 'uuid';
import { OBJECT_TYPES } from '../objectDefaults';
import { SIZE_PRESET_KEYS, THICKNESS_PRESET_KEYS, GAP_PRESET_KEYS } from '../config/sizePresets';
import { canonicalFingerName } from './fingerGeometry';
import { deepClone, TEXT_MAX_LENGTH, BAND_TYPES } from './objectModel';

export const EXPORT_FORMAT = 'colour-therapy-protocol';
export const EXPORT_VERSION = 1;
export const IMPORT_LIMITS = Object.freeze({ MAX_OBJECTS_PER_VIEW: 500, MAX_ERRORS: 40, MAX_METADATA_CHARS: 1500000, MAX_POINTS: 2000 });

const KNOWN_TYPES = OBJECT_TYPES.map((t) => t.type);
const KNOWN_FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inUnit = (v) => isNum(v) && v >= 0 && v <= 1;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function buildExport(protocol, canvases) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    protocol: { name: protocol ? protocol.name : '', protocolType: protocol ? protocol.protocolType : 'hand' },
    views: canvases.map((c) => ({ viewKey: c.viewKey, width: c.width, height: c.height, objects: deepClone(c.objects) })),
  };
}

/** { enabled, color, thickness } — each field optional, but one that is present must be valid. Thickness has no maximum. */
function checkOutline(ol, path, add) {
  if (!isPlain(ol)) { add(path, 'outline must be an object.'); return; }
  if (ol.enabled !== undefined && typeof ol.enabled !== 'boolean') add(`${path}.enabled`, 'outline.enabled must be true or false.');
  if (ol.color !== undefined && (typeof ol.color !== 'string' || !COLOR_RE.test(ol.color))) add(`${path}.color`, 'outline.color must be a hex colour.');
  if (ol.thickness !== undefined && !(isNum(ol.thickness) && ol.thickness > 0)) add(`${path}.thickness`, 'outline.thickness must be a finite number above 0 (there is no upper limit).');
}

function checkMetadata(meta, path, add) {
  if (meta === null || meta === undefined) return;
  if (!isPlain(meta)) { add(`${path}.metadata`, 'metadata must be an object.'); return; }
  let size;
  try { size = JSON.stringify(meta).length; } catch (e) { add(`${path}.metadata`, 'metadata cannot be read.'); return; }
  if (size > IMPORT_LIMITS.MAX_METADATA_CHARS) add(`${path}.metadata`, 'metadata is too large.');
  if (meta.sizePreset !== undefined && !SIZE_PRESET_KEYS.includes(meta.sizePreset)) add(`${path}.metadata.sizePreset`, 'sizePreset must be small, medium, large or xl (Extra Large).');
  if (meta.thicknessPreset !== undefined && !THICKNESS_PRESET_KEYS.includes(meta.thicknessPreset)) add(`${path}.metadata.thicknessPreset`, 'thicknessPreset must be small, medium or large.');
  if (meta.scale !== undefined && !(isNum(meta.scale) && meta.scale > 0 && meta.scale <= 10)) add(`${path}.metadata.scale`, 'scale must be a positive number.');
  if (meta.thicknessScale !== undefined && !(isNum(meta.thicknessScale) && meta.thicknessScale > 0 && meta.thicknessScale <= 10)) add(`${path}.metadata.thicknessScale`, 'thicknessScale must be a positive number.');
  if (meta.text !== undefined && (typeof meta.text !== 'string' || meta.text.length > TEXT_MAX_LENGTH)) add(`${path}.metadata.text`, `text must be a string of at most ${TEXT_MAX_LENGTH} characters.`);
  if (meta.ring !== undefined) {
    const r = meta.ring;
    if (!isPlain(r)) { add(`${path}.metadata.ring`, 'ring must be an object.'); } else {
      if (typeof r.enabled !== 'boolean') add(`${path}.metadata.ring.enabled`, 'ring.enabled must be true or false.');
      if (r.sizePreset !== undefined && !SIZE_PRESET_KEYS.includes(r.sizePreset)) add(`${path}.metadata.ring.sizePreset`, 'ring sizePreset must be small, medium, large or xl (Extra Large).');
      if (r.thicknessPreset !== undefined && !THICKNESS_PRESET_KEYS.includes(r.thicknessPreset)) add(`${path}.metadata.ring.thicknessPreset`, 'ring thicknessPreset must be small, medium or large.');
      if (!(isNum(r.width) && r.width > 0 && r.width <= 1)) add(`${path}.metadata.ring.width`, 'ring.width must be a number above 0 and at most 1.');
      if (!(isNum(r.thickness) && r.thickness >= 0)) add(`${path}.metadata.ring.thickness`, 'ring.thickness must be a finite number, 0 or more (there is no upper limit).');
      // Optional, unlike the dot's own colour: a ring predating independent ring colours, or hand-written by
      // someone who didn't know about them, has no colour of its own. sanitizeObject fills it in with the
      // (already-validated) dot's colour below, rather than rejecting the whole file over a missing colour.
      if (r.color !== undefined && (typeof r.color !== 'string' || !COLOR_RE.test(r.color))) add(`${path}.metadata.ring.color`, 'ring.color must be a hex colour.');
      if (r.gapPreset !== undefined && !GAP_PRESET_KEYS.includes(r.gapPreset)) add(`${path}.metadata.ring.gapPreset`, 'ring gapPreset must be small, medium or large.');
      if (r.gapScale !== undefined && !(isNum(r.gapScale) && r.gapScale > 0 && r.gapScale <= 10)) add(`${path}.metadata.ring.gapScale`, 'ring.gapScale must be a positive number.');
      if (r.gap !== undefined && !(isNum(r.gap) && r.gap >= 0)) add(`${path}.metadata.ring.gap`, 'ring.gap must be a finite number, 0 or more.');
    }
  }
  if (meta.outline !== undefined) checkOutline(meta.outline, `${path}.metadata.outline`, add);
  if (meta.rings !== undefined) {
    if (!Array.isArray(meta.rings)) {
      add(`${path}.metadata.rings`, 'rings must be a list.');
    } else {
      // No maximum number of rings, and no maximum thickness: only the shape of each ring is checked.
      meta.rings.forEach((r, i) => {
        const rp = `${path}.metadata.rings[${i}]`;
        if (!isPlain(r)) { add(rp, `ring ${i + 1} must be an object.`); return; }
        if (r.color !== undefined && (typeof r.color !== 'string' || !COLOR_RE.test(r.color))) add(`${rp}.color`, `ring ${i + 1} colour must be a hex colour.`);
        if (!(isNum(r.thickness) && r.thickness > 0)) add(`${rp}.thickness`, `ring ${i + 1} thickness must be a finite number above 0 (there is no upper limit).`);
        if (r.outline !== undefined) checkOutline(r.outline, `${rp}.outline`, add);
      });
    }
  }
  if (meta.band !== undefined) {
    const b = meta.band;
    if (!isPlain(b)) { add(`${path}.metadata.band`, 'band must be an object.'); } else {
      if (b.type !== undefined && !BAND_TYPES.includes(b.type)) add(`${path}.metadata.band.type`, `band type must be one of: ${BAND_TYPES.join(', ')}.`);
      if (b.position !== undefined && !inUnit(b.position)) add(`${path}.metadata.band.position`, 'band position must be between 0 and 1.');
      if (b.rotationOffset !== undefined && !isNum(b.rotationOffset)) add(`${path}.metadata.band.rotationOffset`, 'band rotationOffset must be a number.');
    }
  }
}

function sanitizeObject(o, path, index, add) {
  if (!isPlain(o)) { add(path, 'must be an object.'); return null; }
  const before = add.count();
  if (!KNOWN_TYPES.includes(o.type)) add(`${path}.type`, `unknown object type "${o.type}".`);
  if (!inUnit(o.x)) add(`${path}.x`, 'x must be a number between 0 and 1.');
  if (!inUnit(o.y)) add(`${path}.y`, 'y must be a number between 0 and 1.');
  for (const k of ['width', 'height']) {
    if (o[k] !== null && o[k] !== undefined && !(isNum(o[k]) && o[k] > 0 && o[k] <= 1)) add(`${path}.${k}`, `${k} must be null or a number above 0 and at most 1.`);
  }
  if (o.rotation !== undefined && !isNum(o.rotation)) add(`${path}.rotation`, 'rotation must be a number.');
  if (typeof o.color !== 'string' || !COLOR_RE.test(o.color)) add(`${path}.color`, 'color must be a hex colour such as #e5484d.');
  if (o.thickness !== undefined && !(isNum(o.thickness) && o.thickness >= 0)) add(`${path}.thickness`, 'thickness must be a finite number, 0 or more — there is no upper limit.');
  if (o.opacity !== undefined && !inUnit(o.opacity)) add(`${path}.opacity`, 'opacity must be a number between 0 and 1.');
  if (o.type === 'freeline') {
    const ok = Array.isArray(o.points) && o.points.length >= 2 && o.points.length <= IMPORT_LIMITS.MAX_POINTS && o.points.every((p) => isPlain(p) && inUnit(p.x) && inUnit(p.y));
    if (!ok) add(`${path}.points`, 'a free line needs 2 or more points, each with x and y between 0 and 1.');
  }
  let finger = null;
  if (o.finger !== null && o.finger !== undefined && o.finger !== '') {
    finger = canonicalFingerName(o.finger);
    if (!KNOWN_FINGERS.includes(finger)) add(`${path}.finger`, `unknown finger "${o.finger}".`);
  }
  if (o.landmarkReference !== null && o.landmarkReference !== undefined && !isPlain(o.landmarkReference)) add(`${path}.landmarkReference`, 'landmarkReference must be an object or null.');
  checkMetadata(o.metadata, path, add);
  if (add.count() > before) return null;

  const metadata = o.metadata ? deepClone(o.metadata) : {};
  if (metadata.ring && typeof metadata.ring === 'object' && metadata.ring.color === undefined) {
    metadata.ring.color = o.color; // legacy / hand-written files: the ring falls back to the dot's own colour
  }
  if (Array.isArray(metadata.rings)) {
    metadata.rings.forEach((r) => { if (r && r.color === undefined) r.color = o.color; }); // same rule for attached rings
  }

  return {
    id: uuidv4(), // always new — see the note at the top of this file
    type: o.type,
    x: o.x,
    y: o.y,
    width: o.width === undefined ? null : o.width,
    height: o.height === undefined ? null : o.height,
    rotation: o.rotation === undefined ? 0 : o.rotation,
    color: o.color,
    thickness: o.thickness === undefined ? 3 : o.thickness,
    opacity: o.opacity === undefined ? 1 : o.opacity,
    points: o.type === 'freeline' ? deepClone(o.points) : null,
    finger,
    landmarkReference: o.landmarkReference ? deepClone(o.landmarkReference) : null,
    metadata,
    zIndex: isNum(o.zIndex) ? o.zIndex : index,
  };
}

/**
 * @param data     the parsed JSON (anything at all)
 * @param canvases the protocol's current canvases (ids + viewKeys) that objects will be applied to
 * @returns {{ok:boolean, errors:string[], views:Array<{canvasId,viewKey,objects}>}}
 */
export function validateImport(data, canvases) {
  const errors = [];
  const add = (path, message) => { if (errors.length < IMPORT_LIMITS.MAX_ERRORS) errors.push(`${path}: ${message}`); errors.total = (errors.total || 0) + 1; };
  add.count = () => errors.total || 0;
  try {
    if (!isPlain(data)) { add('file', 'is not a protocol export (expected a JSON object).'); return { ok: false, errors, views: [] }; }
    if (data.format !== EXPORT_FORMAT) { add('format', `expected "${EXPORT_FORMAT}".`); return { ok: false, errors, views: [] }; }
    if (!isNum(data.version) || data.version > EXPORT_VERSION) { add('version', `this Studio reads version ${EXPORT_VERSION} files or older.`); return { ok: false, errors, views: [] }; }
    if (!Array.isArray(data.views) || data.views.length === 0) { add('views', 'must be a non-empty list.'); return { ok: false, errors, views: [] }; }

    const views = [];
    const seen = new Set();
    data.views.forEach((v, vi) => {
      const vp = `views[${vi}]`;
      if (!isPlain(v) || typeof v.viewKey !== 'string') { add(vp, 'each view needs a viewKey.'); return; }
      const target = canvases.find((c) => c.viewKey === v.viewKey);
      if (!target) { add(`${vp}.viewKey`, `this protocol has no "${v.viewKey}" view.`); return; }
      if (seen.has(v.viewKey)) { add(`${vp}.viewKey`, `"${v.viewKey}" appears more than once.`); return; }
      seen.add(v.viewKey);
      if (!Array.isArray(v.objects)) { add(`${vp}.objects`, 'must be a list.'); return; }
      if (v.objects.length > IMPORT_LIMITS.MAX_OBJECTS_PER_VIEW) { add(`${vp}.objects`, `too many objects (maximum ${IMPORT_LIMITS.MAX_OBJECTS_PER_VIEW}).`); return; }
      const objects = [];
      v.objects.forEach((o, oi) => {
        const clean = sanitizeObject(o, `${vp}.objects[${oi}]`, oi, add);
        if (clean) objects.push(clean);
      });
      views.push({ canvasId: target.id, viewKey: target.viewKey, objects });
    });
    if (add.count() > 0) return { ok: false, errors, views: [] };
    return { ok: true, errors: [], views };
  } catch (err) {
    return { ok: false, errors: [`file: could not be read (${err && err.message ? err.message : 'unexpected error'}).`], views: [] };
  }
}

/** Parses text and validates it in one step; malformed JSON is reported, never thrown. */
export function parseAndValidateImport(text, canvases) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { ok: false, errors: ['file: is not valid JSON.'], views: [] }; }
  return validateImport(data, canvases);
}
