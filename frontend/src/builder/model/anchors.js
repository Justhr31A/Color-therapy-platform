import { getReferenceLandmarks } from '../../tracking/referenceLandmarks';
import { computeSkinWeights, regionLabel, REGION_IDS } from '../../tracking/handSkeleton';

/**
 * Camera (AR) anchors for Studio markings. A marking's anchor says which part of the hand it moves with on the live
 * camera. It is stored in the object's existing, reserved `landmarkReference` field — no schema or API change:
 *
 *   landmarkReference: null                                   Automatic (the default; every existing protocol)
 *   landmarkReference: { region: 'index.middle', source: 'doctor' }   Pinned by the doctor to one region
 *
 * Automatic anchoring is computed from where the marking sits on the reference diagram (tracking/handSkeleton.js). Where
 * that is genuinely ambiguous — a marking between a finger root and the palm, or between two fingers — the Studio says
 * so and asks the doctor to choose, instead of silently guessing a precise anchor.
 */
export const AMBIGUOUS_BELOW = 0.65;

export const ANCHOR_OPTIONS = Object.freeze(REGION_IDS.map((id) => ({ value: id, label: regionLabel(id) })));

/** Plain patch to pin (region id) or un-pin (null) a marking — goes through the store's normal undoable commit. */
export function anchorPatch(region) {
  return { landmarkReference: region && REGION_IDS.includes(region) ? { region, source: 'doctor' } : null };
}

/**
 * What the camera will do with this marking: { mode: 'auto' | 'pinned' | 'none', region, label, confidence,
 * ambiguous, alternatives: [{ region, label, weight }] }. 'none' = this view has no reference hand (not a hand view).
 */
export function describeAnchor(object, canvas) {
  const ref = canvas && canvas.canvasType === 'hand' ? getReferenceLandmarks(canvas.viewKey) : null;
  if (!object || !ref || !(canvas.width > 0) || !(canvas.height > 0)) return { mode: 'none', region: null, label: null, confidence: 0, ambiguous: false, alternatives: [] };
  const refPx = ref.map((p) => ({ x: p.x * canvas.width, y: p.y * canvas.height }));
  const p = { x: (object.x ?? 0.5) * canvas.width, y: (object.y ?? 0.5) * canvas.height };
  const pinned = object.landmarkReference && REGION_IDS.includes(object.landmarkReference.region) ? object.landmarkReference : null;
  const auto = computeSkinWeights(p, refPx, { finger: object.type === 'fingerBand' ? object.finger : null });
  const alternatives = auto.weights.map((w) => ({ region: w.region, label: regionLabel(w.region), weight: w.w }));
  if (pinned) {
    // A pinned marking that was later dragged elsewhere: its pin no longer matches where it sits. Say so.
    const mismatch = !auto.weights.some((w) => w.region === pinned.region && w.w >= 0.05);
    return { mode: 'pinned', region: pinned.region, label: regionLabel(pinned.region), confidence: 1, ambiguous: false, mismatch, nearest: regionLabel(auto.primary), alternatives };
  }
  return { mode: 'auto', region: auto.primary, label: regionLabel(auto.primary), confidence: auto.confidence, ambiguous: auto.confidence < AMBIGUOUS_BELOW, alternatives };
}
