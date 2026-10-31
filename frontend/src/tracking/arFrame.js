import { correctHandedness } from './handedness';
import { CALIBRATION_LANDMARK_INDEXES, getReferencePointsForView, expectedHandSideForView } from './referenceHandPoints';
import { getReferenceLandmarks } from './referenceLandmarks';
import { computeSimilarityTransform } from './similarityTransform';
import { mapObjectsForOverlay, mapObjectsWithAffines, orderForDrawing, SHARED_SHAPE_TYPES } from './protocolMapper';
import { referenceChiralitySign, liveChiralitySign } from './handChirality';
import { classifyHandFrame } from './cameraGuidance';
import { computeSkinWeights, computeRegionTransforms, blendAffine, blendReliability, computePalmHomography, linearizeHomography, PALM } from './handSkeleton';

/**
 * One frame of the live AR camera, as a PURE function: MediaPipe's result in, "what to draw and what to say" out.
 * The camera page's animation loop only clears the canvas, calls this, and draws what it returns — so every decision
 * (no hand / two hands / low confidence / wrong hand / calibrating / aligned / holding) and every mapped marking can be
 * tested with synthetic landmarks, without a camera or a browser.
 *
 * Mapping modes:
 *   'skeleton'   (default) every marking follows its own anatomical region — palm affine + per-bone frames, blended by
 *                skinning weights (handSkeleton.js) over all 21 landmarks.
 *   'similarity' the previous design: one similarity transform for the whole hand from 6 points. Kept for comparison
 *                (?mapping=similarity with ?debug=1) and as a regression baseline in the accuracy benchmark.
 */

/** MediaPipe handedness score below which a detection is treated as too shaky to draw on. */
export const CONFIDENCE_THRESHOLD = 0.6;

/** Which saved objects the camera can draw: dots (with their rings), plain rings, finger bands, lines and shapes. */
export const AR_OBJECT_TYPES = Object.freeze(['dot', 'ring', 'fingerBand', ...SHARED_SHAPE_TYPES]);

/** A marking below this visibility (tracking fade × region reliability) is not drawn at all. */
export const MIN_VISIBILITY = 0.15;

const objectKey = (o, i) => (o && o.id != null ? String(o.id) : `#${i}`);

/** The reference point a marking is anchored by: its centre (x, y) in reference pixels. */
function anchorPointPx(o, canvas) {
  return { x: (Number.isFinite(o.x) ? o.x : 0.5) * canvas.width, y: (Number.isFinite(o.y) ? o.y : 0.5) * canvas.height };
}

/**
 * Everything that depends only on the selected protocol VIEW (not on the frame): computed once per view.
 * `canvas` is a published render-contract canvas { viewKey, canvasType, width, height, objects }.
 * `referenceOverride` ({ viewKey: 21×[x,y] }) replaces the built-in reference skeleton (admin preview).
 */
export function prepareArView(canvas, { referenceOverride = null } = {}) {
  const isHand = Boolean(canvas && canvas.canvasType === 'hand' && canvas.width > 0 && canvas.height > 0);
  const referencePoints = isHand ? getReferencePointsForView(canvas.viewKey) : null;
  const ref21 = isHand ? getReferenceLandmarks(canvas.viewKey, referenceOverride) : null;
  const referenceLandmarksPixels = ref21 ? ref21.map((p) => ({ x: p.x * canvas.width, y: p.y * canvas.height })) : null;
  const mappableObjects = canvas ? orderForDrawing((canvas.objects || []).filter((o) => o && AR_OBJECT_TYPES.includes(o.type))) : [];
  // Skinning weights per marking, computed ONCE here (never per frame).
  const skin = new Map();
  if (referenceLandmarksPixels) {
    mappableObjects.forEach((o, i) => {
      const anchor = o.landmarkReference && typeof o.landmarkReference === 'object' ? o.landmarkReference : null;
      skin.set(objectKey(o, i), computeSkinWeights(anchorPointPx(o, canvas), referenceLandmarksPixels, {
        anchor,
        finger: o.type === 'fingerBand' ? o.finger : null,
      }));
    });
  }
  return {
    canvas: canvas || null,
    expectedHandSide: isHand ? expectedHandSideForView(canvas.viewKey) : null,
    referenceSign: referencePoints ? referenceChiralitySign(referencePoints) : 0,
    // 6 reference points in PIXELS (legacy similarity mode; see protocolMapper.js for why pixels).
    referencePointsPixels: referencePoints ? referencePoints.map((p) => ({ x: p.x * canvas.width, y: p.y * canvas.height })) : null,
    referenceLandmarksPixels,
    mappableObjects,
    skin,
    objectKeys: new Map(mappableObjects.map((o, i) => [o, objectKey(o, i)])),
    anchors: new Map(mappableObjects.map((o) => [o, canvas ? anchorPointPx(o, canvas) : { x: 0, y: 0 }])),
  };
}

const HIDE_NOW = new Set(['wrong-hand', 'multiple-hands', 'no-reference', 'no-objects']);

/**
 * `result`: MediaPipe HandLandmarker result (or null). `view`: from prepareArView. `video`: { width, height } in pixels.
 * Optional stateful helpers (all reset-able, all pure):
 *   tracker     createHandTracker()   — outlier rejection, One Euro smoothing, hold/fade, reacquisition, reliability
 *   calibrator  createCalibrator()    — when given, nothing is drawn until calibration is done
 *   smoother    createLandmarkSmoother() — legacy 6-point smoothing, used only when no tracker is given
 * `mapping`: 'skeleton' (default) | 'similarity'. `palmModel`: 'perspective' (default: palm homography when it is
 * well-conditioned, else affine) | 'affine'.
 *
 * Returns { calibration, hasHand, handCount, isConfident, confidence, rawHandedness, finalHandSide, chiralityMatches,
 *           transform, regionTransforms, mapped, alpha, trackerState, calibrationProgress, calibrationReasons,
 *           livePointsPixels, liveLandmarksPixels }.
 */
export function computeArFrame({
  result, view, video, smoother = null, tracker = null, calibrator = null, timestampMs = 0, multiHandCheck = false,
  confidenceThreshold = CONFIDENCE_THRESHOLD, mapping = 'skeleton', palmModel = 'perspective',
}) {
  const hands = result && Array.isArray(result.landmarks) ? result.landmarks : [];
  const hasHand = hands.length > 0 && Array.isArray(hands[0]) && hands[0].length >= 21;
  const rawCategory = hasHand ? result.handedness?.[0]?.[0] : null;
  const score = rawCategory?.score ?? 0;
  const isConfident = hasHand && score >= confidenceThreshold;
  const { expectedHandSide, referenceSign, referencePointsPixels, referenceLandmarksPixels, mappableObjects, canvas } = view;

  const liveSign = hasHand ? liveChiralitySign(hands[0]) : 0;
  const chiralityMatches = expectedHandSide ? liveSign !== 0 && liveSign === referenceSign : hasHand;
  const diagnosticRawLabel = rawCategory ? correctHandedness(rawCategory.categoryName, false) : null;
  const finalHandSide = !expectedHandSide
    ? diagnosticRawLabel
    : liveSign === 0
    ? null
    : chiralityMatches
    ? expectedHandSide
    : expectedHandSide === 'Left'
    ? 'Right'
    : 'Left';

  const base = {
    hasHand,
    handCount: hands.length,
    isConfident,
    confidence: Math.round(score * 100),
    rawHandedness: rawCategory?.categoryName || null,
    finalHandSide,
    chiralityMatches,
    transform: null,
    regionTransforms: null,
    mapped: [],
    alpha: 0,
    trackerState: tracker ? tracker.state : null,
    calibrationProgress: calibrator ? (calibrator.done ? 1 : 0) : 1,
    calibrationReasons: [],
    livePointsPixels: null,
    liveLandmarksPixels: null,
  };

  const verdict = classifyHandFrame({
    hasHand,
    handCount: hands.length,
    multiHandCheck,
    isConfident,
    chiralityMatches,
    hasReference: Boolean(referencePointsPixels),
    objectCount: mappableObjects.length,
  });
  const videoOk = video && video.width > 0 && video.height > 0;
  const ready = verdict === 'ready' && videoOk;
  const raw21 = ready ? hands[0].map((p) => ({ x: p.x * video.width, y: p.y * video.height })) : null;

  // ---- calibration gate (optional) ----
  let calibrationState = null;
  if (calibrator && !calibrator.done) {
    const c = ready
      ? calibrator.update({ landmarks: hands[0], score, video, timestampMs })
      : calibrator.update({ landmarks: null, score, video, timestampMs });
    if (c.status === 'done' && tracker) tracker.setBaseline(c.baseline.ratios);
    calibrationState = c;
  }

  // ---- temporal tracking ----
  let live21 = raw21;
  let alpha = ready ? 1 : 0;
  let reliability = null;
  if (tracker) {
    const tr = tracker.update({ landmarks: raw21, score, timestampMs, usable: ready, hideNow: HIDE_NOW.has(verdict) });
    live21 = tr.landmarks;
    alpha = tr.alpha;
    reliability = tr.reliability;
    base.trackerState = tr.state;
  } else if (smoother && !ready) {
    smoother.reset();
  }

  if (calibrationState && calibrationState.status !== 'done') {
    return {
      ...base,
      calibration: ready ? 'calibrating' : (videoOk ? verdict : 'not-detected'),
      calibrationProgress: calibrationState.progress,
      calibrationReasons: calibrationState.reasons,
      liveLandmarksPixels: live21,
    };
  }

  if (!live21) {
    const calibration = !videoOk ? 'not-detected' : verdict === 'ready' ? 'acquiring' : verdict;
    return { ...base, calibration, calibrationProgress: calibrator ? 1 : base.calibrationProgress };
  }

  // Live calibration points (6) in VIDEO PIXELS — for the legacy mode and the developer trace.
  let livePointsPixels = CALIBRATION_LANDMARK_INDEXES.map((idx) => live21[idx]);
  if (!tracker && smoother) livePointsPixels = smoother.smooth(livePointsPixels, timestampMs);
  const transform = computeSimilarityTransform(referencePointsPixels, livePointsPixels);
  if (!transform) {
    if (smoother) smoother.reset();
    return { ...base, calibration: 'no-reference' };
  }
  const calibration = ready ? 'ok' : 'holding';
  const common = { ...base, calibration, transform, alpha, livePointsPixels, liveLandmarksPixels: live21, calibrationProgress: 1 };

  if (mapping === 'similarity' || !referenceLandmarksPixels) {
    const mapped = mapObjectsForOverlay(mappableObjects, transform, canvas.width, canvas.height, video.width, video.height)
      .map((m) => ({ ...m, visibility: alpha }));
    return { ...common, mapped: alpha >= MIN_VISIBILITY ? mapped : [] };
  }

  const regionTransforms = computeRegionTransforms(referenceLandmarksPixels, live21);
  if (!regionTransforms) return { ...base, calibration: 'no-reference' };
  // Perspective palm: a per-marking linearisation of the palm homography replaces the palm affine (exact at the marking).
  const palmH = palmModel === 'perspective' ? computePalmHomography(referenceLandmarksPixels, live21, regionTransforms[PALM]) : null;
  const transformsFor = (o, weights) => {
    if (!palmH || !weights.some((w) => w.region === PALM)) return regionTransforms;
    return { ...regionTransforms, [PALM]: linearizeHomography(palmH, view.anchors.get(o)) };
  };
  const visibilityOf = new Map();
  const mapped = mapObjectsWithAffines(
    mappableObjects,
    (o) => {
      const s = view.skin.get(view.objectKeys.get(o));
      if (!s) return regionTransforms.palm;
      const v = alpha * blendReliability(s.weights, reliability);
      visibilityOf.set(o, v);
      return v >= MIN_VISIBILITY ? blendAffine(s.weights, transformsFor(o, s.weights)) : null;
    },
    canvas.width, canvas.height, video.width, video.height,
    (o) => ({ visibility: visibilityOf.has(o) ? visibilityOf.get(o) : alpha })
  );
  return { ...common, regionTransforms, palmModelUsed: palmH ? 'perspective' : 'affine', mapped };
}
