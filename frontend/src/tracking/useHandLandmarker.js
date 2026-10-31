import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Wraps @mediapipe/tasks-vision's HandLandmarker.
 *
 * WHY THIS LIBRARY (see the Phase 2 report for the full explanation):
 * - Runs entirely client-side via WebAssembly — no camera frame ever leaves
 *   the device, satisfying the "don't upload frames to a server" requirement
 *   by construction, not by discipline.
 * - Ships a purpose-built `VIDEO` running mode for exactly this use case
 *   (a live, continuous webcam stream with monotonically increasing
 *   timestamps), as opposed to the one-shot `IMAGE` mode.
 * - Gives 21 landmarks per hand out of the box (wrist, thumb, index,
 *   middle, ring, pinky, every joint) plus a handedness classification —
 *   exactly the landmark set Phase 2 §3 asks for, with no extra model needed
 *   for left/right (Phase 2 §4, not implemented yet — this hook only
 *   surfaces the raw label for now).
 *
 * Version note: the WASM fileset URL below is pinned to the SAME version as
 * the `@mediapipe/tasks-vision` npm dependency in package.json. If you ever
 * bump one, bump the other — a mismatch between the JS API and the WASM
 * binary it loads is a common source of confusing runtime errors.
 */

const PINNED_VERSION = '0.10.14';
// Optional overrides (frontend build environment) for deployments that self-host the MediaPipe files or block a CDN:
//   VITE_MEDIAPIPE_WASM_URL      folder holding vision_wasm_internal.{js,wasm} — MUST be the same version as above
//   VITE_HAND_LANDMARKER_MODEL   URL of hand_landmarker.task
// `import.meta.env` only exists under Vite; the guard keeps this module importable in plain Node tests.
const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};
export const WASM_BASE_URL = ENV.VITE_MEDIAPIPE_WASM_URL || `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${PINNED_VERSION}/wasm`;
export const MODEL_URL =
  ENV.VITE_HAND_LANDMARKER_MODEL ||
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** Which loading step failed, in words a visitor can act on. Pure, so it can be tested. */
export const TRACKER_ERRORS = Object.freeze({
  unsupported: "This browser can't run hand tracking. Please use an up-to-date Chrome, Edge, Safari or Firefox.",
  runtime: 'Could not load the hand-tracking engine. Check your internet connection and try again.',
  model: 'Could not load the hand-tracking model. Check your internet connection and try again.',
});

export const TRACKER_STATUS = {
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error',
};

export default function useHandLandmarker({ numHands = 1 } = {}) {
  // `numHands` is read once, when the model loads. 1 (the default) is the original behaviour; the public camera asks
  // for 2 only so it can tell "two hands in view" and ask for one, never to track both.
  const numHandsRef = useRef(numHands);
  const [status, setStatus] = useState(TRACKER_STATUS.LOADING);
  const [error, setError] = useState(null);
  const landmarkerRef = useRef(null);
  const lastTimestampRef = useRef(-1);
  const [attempt, setAttempt] = useState(0);

  /** Try loading again after a failure (e.g. the connection came back). */
  const retry = useCallback(() => {
    setError(null);
    setStatus(TRACKER_STATUS.LOADING);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (typeof WebAssembly === 'undefined') {
        setError(TRACKER_ERRORS.unsupported);
        setStatus(TRACKER_STATUS.ERROR);
        return;
      }
      let step = 'runtime';
      try {
        // Dynamically imported so the (fairly large) WASM/model download
        // only happens once something on screen actually needs it, not as
        // part of the app's main bundle.
        const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
        const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
        if (cancelled) return;
        step = 'model';

        const baseOptions = { modelAssetPath: MODEL_URL };
        let landmarker;
        try {
          landmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { ...baseOptions, delegate: 'GPU' },
            runningMode: 'VIDEO',
            numHands: numHandsRef.current,
          });
        } catch (gpuErr) {
          // Some browsers/devices don't support the GPU delegate — fall
          // back to CPU rather than failing outright.
          landmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { ...baseOptions, delegate: 'CPU' },
            runningMode: 'VIDEO',
            numHands: numHandsRef.current,
          });
        }

        if (cancelled) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        setStatus(TRACKER_STATUS.READY);
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[useHandLandmarker] failed to load model', err);
        setError(TRACKER_ERRORS[step] || TRACKER_ERRORS.model);
        setStatus(TRACKER_STATUS.ERROR);
      }
    }

    load();
    return () => {
      cancelled = true;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, [attempt]);

  /**
   * Call once per animation frame with the live <video> element. Returns
   * the raw MediaPipe result ({ landmarks, handedness, ... }) or null if
   * the tracker isn't ready yet / the video has no frame available yet.
   * VIDEO mode requires strictly increasing timestamps, so this guards
   * against calling twice for the same frame.
   */
  const detect = useCallback((videoEl) => {
    const landmarker = landmarkerRef.current;
    if (!landmarker || !videoEl || videoEl.readyState < 2) return null;
    const now = performance.now();
    if (now <= lastTimestampRef.current) return null;
    lastTimestampRef.current = now;
    try {
      return landmarker.detectForVideo(videoEl, now);
    } catch (err) {
      // A single bad frame (e.g. the video was resized mid-frame) must not stop the camera loop.
      return null;
    }
  }, []);

  return { status, error, detect, retry };
}
