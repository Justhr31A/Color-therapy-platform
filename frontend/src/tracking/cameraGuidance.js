import { expectedHandSideForView } from './referenceHandPoints';

/**
 * The words the camera screen uses, as pure functions (so they can be tested without a camera).
 *
 * Everything here is plain, non-medical guidance about HOW TO HOLD YOUR HAND IN FRONT OF THE CAMERA. Nothing here
 * claims the markings are medically correct or millimetre-accurate — the overlay is an approximate visual aid.
 */
export const HAND_VIEWS = Object.freeze([
  { viewKey: 'left_front', label: 'Left Front', side: 'Left', face: 'front' },
  { viewKey: 'right_front', label: 'Right Front', side: 'Right', face: 'front' },
  { viewKey: 'left_back', label: 'Left Back', side: 'Left', face: 'back' },
  { viewKey: 'right_back', label: 'Right Back', side: 'Right', face: 'back' },
]);

export const handViewInfo = (viewKey) => HAND_VIEWS.find((v) => v.viewKey === viewKey) || null;

/** "Show your left hand with the palm facing the camera." — the instruction for the view the person chose. */
export function viewInstruction(viewKey) {
  const v = handViewInfo(viewKey);
  if (!v) return 'Hold your hand in front of the camera.';
  const side = v.side.toLowerCase();
  return v.face === 'front'
    ? `Show your ${side} hand with the palm facing the camera, fingers gently spread.`
    : `Show your ${side} hand with the back of the hand facing the camera, fingers gently spread.`;
}

/**
 * The per-frame verdict, in the order the checks must run (this is exactly the chain the camera loop used inline):
 *   no hand -> 'not-detected'; more than one hand (public camera only) -> 'multiple-hands'; shaky detection ->
 *   'low-confidence'; the wrong hand for this view (geometric chirality) -> 'wrong-hand'; no calibration points ->
 *   'no-reference'; nothing to draw -> 'no-objects'; otherwise 'ready' (the loop then fits the transform and draws).
 */
export function classifyHandFrame({ hasHand, handCount = 0, multiHandCheck = false, isConfident, chiralityMatches, hasReference, objectCount }) {
  if (!hasHand) return 'not-detected';
  if (multiHandCheck && handCount > 1) return 'multiple-hands';
  if (!isConfident) return 'low-confidence';
  if (!chiralityMatches) return 'wrong-hand';
  if (!hasReference) return 'no-reference';
  if (objectCount === 0) return 'no-objects';
  return 'ready';
}

/**
 * What to tell the person right now.
 *   calibration: the per-frame result of the camera loop ('ok' | 'not-detected' | 'low-confidence' | 'wrong-hand' |
 *                'multiple-hands' | 'no-reference' | 'no-objects')
 *   hadHand:     true once markings have been shown at least once (so "hand left the view" can be told apart from "not found yet")
 * Returns { state, tone: 'neutral' | 'warn' | 'ok', message }.
 */
export function cameraGuidance({ calibration, expectedHandSide = null, hadHand = false, viewKey = null } = {}) {
  const side = expectedHandSide ? expectedHandSide.toLowerCase() : null;
  // The geometric check cannot tell "other hand" from "other side of the hand" (a left palm is the mirror image of a
  // right back), so when the view is known the message names both: which hand AND which side faces the camera.
  const v = handViewInfo(viewKey);
  switch (calibration) {
    case 'ok':
      return { state: 'aligned', tone: 'ok', message: 'Hand found — the markings follow your hand. Keep it in view.' };
    case 'holding':
      return { state: 'holding', tone: 'warn', message: 'Hold on — finding your hand again…' };
    case 'acquiring':
      return { state: 'acquiring', tone: 'neutral', message: 'Hand found — lining up the markings…' };
    case 'calibrating':
      return { state: 'calibrating', tone: 'neutral', message: 'Hold your hand flat, fingers straight and slightly spread, facing the camera…' };
    case 'wrong-hand':
      if (v) {
        return { state: 'wrong-hand', tone: 'warn', message: `Please show your ${v.side.toLowerCase()} hand with the ${v.face === 'front' ? 'palm' : 'back of the hand'} facing the camera.` };
      }
      return { state: 'wrong-hand', tone: 'warn', message: side ? `Please show your ${side} hand.` : 'Please show the other hand.' };
    case 'multiple-hands':
      return { state: 'multiple-hands', tone: 'warn', message: 'Please show only one hand.' };
    case 'low-confidence':
      return { state: 'low-confidence', tone: 'warn', message: 'Hold your hand steady in the light so it can be seen clearly.' };
    case 'no-objects':
      return { state: 'no-markings', tone: 'neutral', message: 'Your hand is found, but this view has no markings to show.' };
    case 'no-reference':
      return { state: 'unavailable', tone: 'warn', message: 'This view cannot be shown on the camera.' };
    case 'not-detected':
    default:
      return hadHand
        ? { state: 'lost', tone: 'warn', message: 'Your hand left the view — bring it back and the markings will return.' }
        : { state: 'searching', tone: 'neutral', message: side ? `Hold your ${side} hand in front of the camera.` : 'Hold your hand in front of the camera.' };
  }
}

/** The side a view needs, or null (re-exported so callers do not need two imports). */
export const sideForView = (viewKey) => expectedHandSideForView(viewKey) || null;
