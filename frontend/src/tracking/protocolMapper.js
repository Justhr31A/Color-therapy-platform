import { applyTransform, transformScale } from './similarityTransform';
// Reused, not reimplemented: a Dot + Ring is one structured protocol object (type 'dot' with `metadata.ring`),
// and Protocol Studio's own model functions are the single source of truth for what its ring means — whether
// it's showing at all, what colour it falls back to with no colour of its own, and what its effective gap is
// when no gap has ever been set. The AR mapper must never re-derive that logic independently, or the two could
// silently disagree about what a saved protocol looks like.
import { hasActiveRing, getRing, effectiveRingGapPx, hasRings, compositeRingLayers, getOutline, outlineActive } from '../builder/model/objectModel';
// The camera draws the SAME shared primitives as the website and the PDF for shapes it does not hand-map (Finger Band).
import { primitivesForObject } from '../viewer/renderMarkings';

/**
 * ROOT CAUSE of the dot-misplacement bug (found by numeric reproduction,
 * not guessed — see the diagnosis test suite): the reference points
 * (referenceHandPoints.js) are normalized 0-1 against each view's PNG,
 * which is a TALL image (~0.8:1 width:height). MediaPipe's live landmarks
 * are normalized 0-1 against the VIDEO frame, which is a WIDE image
 * (~1.78:1 for a 1280x720 stream). Fitting a UNIFORM-scale similarity
 * transform directly on these two differently-shaped normalized 0-1
 * spaces is dimensionally inconsistent: the same physical hand shape,
 * independently normalized against two containers of different aspect
 * ratios, produces two configurations that are NOT related by a pure
 * rotation+uniform-scale — forcing that fit distorts any point that isn't
 * extremely close to the calibration points' centroid, which is exactly
 * what "dot significantly misplaced" looks like.
 *
 * THE FIX: do the fit, and map any object, in each space's own TRUE PIXEL
 * units (reference pixels for the doctor's data, video pixels for the
 * live feed) — pixels correctly preserve real proportions within their
 * own image, unlike two independently-normalized 0-1 fractions. The
 * caller (CameraSessionPage.jsx) is responsible for fitting the transform
 * on PIXEL-space point pairs; this module converts a saved object's
 * normalized reference coordinate into reference pixels, applies that
 * pixel-space transform, then converts the result back into a normalized
 * VIDEO-FRAME fraction (dividing by videoWidth/videoHeight) so the
 * existing draw pipeline (drawProtocolOverlay.js, unchanged) keeps working
 * exactly as before — this bug and its fix are entirely contained to the
 * mapping step, nothing about how the mapped result gets drawn changes.
 */

/**
 * A Dot + Ring's ring, mapped alongside its dot, in the exact SAME reference-pixel -> live-pixel pipeline as
 * everything else here: work out the ring's geometry in REFERENCE pixels first (dot radius + effective gap +
 * half the stroke — precisely the formula Protocol Studio itself draws with, in DotRingShape.jsx), then carry
 * that one combined length through `transformScale`, exactly like the radius/stroke of a plain 'ring' object
 * below. This is why a gap is never mistaken for a stored ring width: `effectiveRingGapPx` (Studio's own
 * function, not reimplemented here) already returns the CORRECT gap whether one was ever explicitly set or
 * not, so nothing here needs to know which case it is.
 */
function mapRing(object, dotRefRadiusPx, scale, refWidth) {
  const ring = getRing(object);
  const thicknessRefPx = typeof ring.thickness === 'number' && Number.isFinite(ring.thickness) ? ring.thickness : 0;
  const gapRefPx = effectiveRingGapPx(object, ring, refWidth);
  const ringRefRadiusPx = dotRefRadiusPx + gapRefPx + thicknessRefPx / 2;
  return {
    radius: ringRefRadiusPx * scale,
    strokeWidth: thicknessRefPx * scale,
    color: ring.color,
  };
}

/** The object's own outline as a camera-space length, or null. Same rule as the website (`outlineActive`). */
function mapOutline(object, scale, videoWidth) {
  const o = getOutline(object);
  return outlineActive(o) ? { color: o.color, thickness: (o.thickness * scale) / videoWidth } : null;
}

/**
 * Multi-ring: a dot's `metadata.rings`, innermost first, as camera-space layers. The radii come from
 * `compositeRingLayers` — the one function the Studio, the website and the PDF draw from — so ring k always touches
 * ring k-1 (zero gap) here too. Each layer carries its own colour, thickness and outline.
 */
function mapRings(object, refWidth, scale, videoWidth) {
  return compositeRingLayers(object, refWidth).map((L) => ({
    radius: (L.radius * scale) / videoWidth,
    strokeWidth: (L.thickness * scale) / videoWidth,
    color: L.color,
    outline: outlineActive(L.outline) ? { color: L.outline.color, thickness: (L.outline.thickness * scale) / videoWidth } : null,
  }));
}

/**
 * The similarity transform as a 2D affine matrix (reference px -> video px), in canvas order {a,b,c,d,e,f}. This is
 * exactly `applyTransform` written as a matrix, so a primitive drawn under it lands where the mapper would put it.
 */
export function transformToMatrix(transform) {
  const { re, im } = transform.a;
  const { refCentroid: r, liveCentroid: l } = transform;
  return { a: re, b: im, c: -im, d: re, e: l.x - re * r.x + im * r.y, f: l.y - im * r.x - re * r.y };
}

/**
 * A "local mapping" is what one object needs from the hand: where a reference pixel lands (`apply`), how much a
 * reference length grows (`scale`) and the full 2D affine as a canvas matrix (`matrix`, for shapes). The whole-hand
 * similarity (legacy) and the per-object skinned affine (handSkeleton.js) both reduce to this.
 */
export function localFromSimilarity(transform) {
  return { apply: (p) => applyTransform(transform, p), scale: transformScale(transform), matrix: transformToMatrix(transform) };
}
export function localFromAffine(m) {
  return {
    apply: (p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }),
    scale: Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)),
    matrix: { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f },
  };
}

function mapOneObject(object, transform, refWidth, refHeight, videoWidth, videoHeight) {
  return mapOneObjectLocal(object, localFromSimilarity(transform), refWidth, refHeight, videoWidth, videoHeight);
}

function mapOneObjectLocal(object, local, refWidth, refHeight, videoWidth, videoHeight) {
  switch (object.type) {
    case 'dot': {
      const refPixel = { x: object.x * refWidth, y: object.y * refHeight };
      const livePixel = local.apply(refPixel);

      const refRadiusPixels = ((object.width || 0.03) / 2) * refWidth;
      const scale = local.scale;
      const liveRadiusPixels = refRadiusPixels * scale;

      const mapped = {
        id: object.id,
        type: 'dot',
        x: livePixel.x / videoWidth,
        y: livePixel.y / videoHeight,
        radius: liveRadiusPixels / videoWidth,
        color: object.color,
        opacity: object.opacity,
      };

      // A Dot + Ring is still ONE object (type 'dot' with `metadata.ring`) — the mapped output stays one
      // entry too, with the ring nested inside it, rather than a second synthetic mapped object. That keeps
      // exactly one published object corresponding to exactly one mapped/drawn thing, the same relationship
      // that already held before Dot + Ring existed.
      const dotOutline = mapOutline(object, scale, videoWidth);
      if (dotOutline) mapped.outline = dotOutline;
      if (hasRings(object)) {
        // Multi-ring (`metadata.rings`): takes over from any legacy single `metadata.ring` on the same object,
        // exactly as the website does. Plain dots and legacy single-ring dots never get a `rings` field.
        mapped.rings = mapRings(object, refWidth, scale, videoWidth);
      } else if (hasActiveRing(object)) {
        const live = mapRing(object, refRadiusPixels, scale, refWidth);
        mapped.ring = { radius: live.radius / videoWidth, strokeWidth: live.strokeWidth / videoWidth, color: live.color };
      }
      return mapped;
    }
    case 'ring': {
      // Step 7: same reference-pixel -> live-pixel transform already proven
      // for the dot. A ring's `width` field is a diameter fraction of the
      // reference width, exactly like a dot's (see RadialShape.jsx) — reuse
      // that conversion unchanged. `thickness` is stored as an ABSOLUTE
      // pixel value at reference canvas size (schema.sql), not a fraction,
      // so it scales by the transform's scale factor directly (same
      // reasoning as the radius: transformScale() correctly carries any
      // reference-pixel LENGTH into live-pixel space, whether that length
      // is a radius or a stroke width).
      const refPixel = { x: object.x * refWidth, y: object.y * refHeight };
      const livePixel = local.apply(refPixel);
      const scale = local.scale;

      const refRadiusPixels = ((object.width || 0.08) / 2) * refWidth;
      const liveRadiusPixels = refRadiusPixels * scale;
      const liveStrokePixels = (object.thickness || 4) * scale;

      const mappedRing = {
        id: object.id,
        type: 'ring',
        x: livePixel.x / videoWidth,
        y: livePixel.y / videoHeight,
        radius: liveRadiusPixels / videoWidth,
        strokeWidth: liveStrokePixels / videoWidth,
        color: object.color,
        opacity: object.opacity,
      };
      const ringOutline = mapOutline(object, scale, videoWidth);
      if (ringOutline) mappedRing.outline = ringOutline;
      return mappedRing;
    }
    case 'fingerBand': {
      // Finger Band: the shared primitives (reference px) plus the object's local transform as a matrix. With the
      // skeleton mapping (handSkeleton.js) that is the transform of the band's own finger bone, so it follows a bent
      // finger; with the legacy whole-hand similarity it only follows the hand as a whole.
      return {
        id: object.id,
        type: 'fingerBand',
        opacity: object.opacity,
        primitives: primitivesForObject(object, { width: refWidth, height: refHeight }),
        matrix: local.matrix,
      };
    }
    // Not yet implemented — Step 6H/7 are explicit that these come later.
    case 'hline':
    case 'vline':
    case 'freeline':
    case 'invertedTriangle':
    case 'triangle':
    case 'rectangle':
    case 'square':
    case 'arrow':
      return null;
    default:
      return null;
  }
}

/**
 * Shapes the camera draws straight from the SHARED primitives (the list the public page and the PDF are made from),
 * under the hand's fitted transform: lines, arrows, free lines, triangles, rectangles, squares and text. A similarity
 * transform (move + rotate + uniform scale) maps each of these EXACTLY, so nothing is approximated; what stays
 * approximate is only the whole-hand assumption (a bent finger moves differently from the palm). Kept separate from
 * `mapProtocolObjects` so the dot / ring mapper and its contract are untouched.
 */
export const SHARED_SHAPE_TYPES = ['hline', 'vline', 'arrow', 'freeline', 'triangle', 'invertedTriangle', 'rectangle', 'square', 'text'];

function mapShapeLocal(o, local, refWidth, refHeight) {
  const primitives = primitivesForObject(o, { width: refWidth, height: refHeight });
  return primitives.length ? { id: o.id, type: 'shape', shapeType: o.type, opacity: o.opacity, primitives, matrix: local.matrix } : null;
}

/**
 * Maps objects with a PER-OBJECT local affine (skeleton mapping): `affineFor(object)` returns the reference-px →
 * video-px affine for that object (or null to skip it). Layering order is preserved (zIndex, ties in saved order).
 * `extraFor(object)` may return fields merged into the mapped entry (e.g. { visibility }).
 */
export function mapObjectsWithAffines(objects, affineFor, refWidth, refHeight, videoWidth, videoHeight, extraFor = null) {
  if (!objects || !refWidth || !refHeight || !videoWidth || !videoHeight) return [];
  const out = [];
  for (const o of orderForDrawing(objects)) {
    const m = affineFor(o);
    if (!m) continue;
    const local = localFromAffine(m);
    const mapped = SHARED_SHAPE_TYPES.includes(o.type)
      ? mapShapeLocal(o, local, refWidth, refHeight)
      : mapOneObjectLocal(o, local, refWidth, refHeight, videoWidth, videoHeight);
    if (mapped) out.push(extraFor ? { ...mapped, ...extraFor(o) } : mapped);
  }
  return out;
}

export function mapSharedShapeObjects(objects, transform, refWidth, refHeight) {
  if (!objects || !transform || !refWidth || !refHeight) return [];
  const matrix = transformToMatrix(transform);
  return objects
    .filter((o) => o && SHARED_SHAPE_TYPES.includes(o.type))
    .map((o) => ({ id: o.id, type: 'shape', shapeType: o.type, opacity: o.opacity, primitives: primitivesForObject(o, { width: refWidth, height: refHeight }), matrix }))
    .filter((m) => m.primitives.length > 0);
}

/**
 * Maps every supported object in `objects` using `transform` (which MUST
 * already be fitted in reference-pixel -> video-pixel space — see
 * CameraSessionPage.jsx). `refWidth`/`refHeight` are the selected view's
 * reference canvas dimensions (canvas.width/canvas.height from the saved
 * protocol); `videoWidth`/`videoHeight` are the live video's intrinsic
 * pixel dimensions (video.videoWidth/videoHeight).
 */
export function mapProtocolObjects(objects, transform, refWidth, refHeight, videoWidth, videoHeight) {
  if (!objects || !transform || !refWidth || !refHeight || !videoWidth || !videoHeight) return [];
  return objects.map((o) => mapOneObject(o, transform, refWidth, refHeight, videoWidth, videoHeight)).filter(Boolean);
}

/**
 * Objects in the order they must be DRAWN: the protocol's own zIndex, lowest first (later on top), ties kept in saved
 * order — exactly the rule the website and the PDF use (`primitivesForCanvas` in viewer/renderMarkings.js). A stable
 * sort, so equal zIndex values never reshuffle between frames.
 */
export function orderForDrawing(objects) {
  const z = (o) => (typeof o.zIndex === 'number' && Number.isFinite(o.zIndex) ? o.zIndex : 0);
  return (objects || [])
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o && typeof o === 'object')
    .sort((a, b) => z(a.o) - z(b.o) || a.i - b.i)
    .map(({ o }) => o);
}

/**
 * Everything the camera overlay draws for one frame, in the protocol's own layering order: dots / rings / finger bands
 * through `mapProtocolObjects`, lines and shapes through `mapSharedShapeObjects` — one fitted transform for all of them.
 * (Mapping the two families separately and concatenating them would always put every shape above every dot, which is
 * not what the doctor saved.) Unsupported types are skipped.
 */
export function mapObjectsForOverlay(objects, transform, refWidth, refHeight, videoWidth, videoHeight) {
  if (!objects || !transform || !refWidth || !refHeight || !videoWidth || !videoHeight) return [];
  const out = [];
  for (const o of orderForDrawing(objects)) {
    const mapped = SHARED_SHAPE_TYPES.includes(o.type)
      ? mapSharedShapeObjects([o], transform, refWidth, refHeight)
      : mapProtocolObjects([o], transform, refWidth, refHeight, videoWidth, videoHeight);
    out.push(...mapped);
  }
  return out;
}
