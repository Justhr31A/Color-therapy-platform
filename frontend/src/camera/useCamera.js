import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * CameraManager (as a hook rather than a class — fits React's lifecycle
 * better and is the idiomatic way to wrap a browser API with cleanup).
 *
 * Handles exactly what Phase 2 Step 4 asks for: request permission clearly,
 * prefer the rear/environment camera (a patient typically holds the phone
 * in one hand and points the rear camera at their other hand), fall back to
 * whatever camera is available otherwise, and turn every known failure mode
 * into a specific, human-readable status instead of letting the app crash
 * or show a raw browser error.
 */

export const CAMERA_STATUS = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  GRANTED: 'granted',
  DENIED: 'denied',
  UNAVAILABLE: 'unavailable', // no camera hardware found
  INSECURE_CONTEXT: 'insecure_context', // needs https (or localhost)
  UNSUPPORTED: 'unsupported', // browser has no getUserMedia at all
  ERROR: 'error', // camera exists but couldn't be started (e.g. in use elsewhere)
};

const USER_MESSAGES = {
  [CAMERA_STATUS.DENIED]: 'Camera permission is required. Please allow camera access and try again.',
  [CAMERA_STATUS.UNAVAILABLE]: 'No camera was found on this device.',
  [CAMERA_STATUS.INSECURE_CONTEXT]: 'Camera access requires a secure (https) connection.',
  [CAMERA_STATUS.UNSUPPORTED]: "This browser doesn't support camera access. Please try an up-to-date Chrome or Safari.",
  [CAMERA_STATUS.ERROR]: "Couldn't start the camera. It may be in use by another app.",
};

function classifyGetUserMediaError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return CAMERA_STATUS.DENIED;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return CAMERA_STATUS.UNAVAILABLE;
    case 'NotReadableError':
    case 'TrackStartError':
      return CAMERA_STATUS.ERROR;
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'retry_relaxed'; // handled specially — try again with looser constraints
    default:
      return CAMERA_STATUS.ERROR;
  }
}

/**
 * Releases a camera stream: stops every track (the browser's camera-in-use indicator turns off) and detaches it from
 * the <video>. Safe to call with nothing. Nothing is ever recorded, copied or kept from the stream.
 */
export function stopStream(stream, videoEl) {
  if (stream && typeof stream.getTracks === 'function') stream.getTracks().forEach((t) => t.stop());
  if (videoEl) videoEl.srcObject = null;
}

/**
 * Asks the browser for a camera stream: the rear/environment camera first, any camera if that is impossible.
 * Resolves { stream, facing } or { status } (one of CAMERA_STATUS) — never throws. Pure apart from the browser call,
 * so it can be tested with a fake `mediaDevices`.
 */
export async function requestCameraStream(mediaDevices) {
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') return { status: CAMERA_STATUS.UNSUPPORTED };
  try {
    const stream = await mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    return { stream, facing: 'environment' };
  } catch (err) {
    const classified = classifyGetUserMediaError(err);
    if (classified !== 'retry_relaxed') return { status: classified };
    // The device doesn't have (or won't give us) an environment-facing camera under those constraints — fall back to
    // whatever default camera it has (typically the front/user camera on a laptop).
    try {
      const stream = await mediaDevices.getUserMedia({ video: true, audio: false });
      return { stream, facing: 'user' };
    } catch (err2) {
      const second = classifyGetUserMediaError(err2);
      return { status: second === 'retry_relaxed' ? CAMERA_STATUS.ERROR : second };
    }
  }
}

/**
 * A camera request can finish AFTER the person has already left (pressed Exit/Back, switched view, closed the page).
 * Such a late stream must be released at once — otherwise the camera light stays on with nothing showing it.
 * Returns true when the stream is still wanted (`requestId` is the latest request), false after releasing it.
 */
export function acceptOrReleaseStream(requestId, latestRequestId, stream) {
  if (requestId === latestRequestId) return true;
  stopStream(stream, null);
  return false;
}

export default function useCamera() {
  const [status, setStatus] = useState(CAMERA_STATUS.IDLE);
  const [facing, setFacing] = useState(null); // 'environment' | 'user' once granted
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const requestIdRef = useRef(0); // bumped by every start() and stop(); a stale request's stream is released
  const mountedRef = useRef(true);

  const stop = useCallback(() => {
    requestIdRef.current += 1; // any request still in flight is now stale
    stopStream(streamRef.current, videoRef.current);
    streamRef.current = null;
    if (mountedRef.current) {
      setStatus(CAMERA_STATUS.IDLE);
      setFacing(null);
    }
  }, []);

  // Unmounting always releases the camera, whoever owns this hook.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      stopStream(streamRef.current, videoRef.current);
      streamRef.current = null;
    };
  }, []);

  const attachStream = useCallback((stream, requestedFacing) => {
    streamRef.current = stream;
    setFacing(requestedFacing);
    setStatus(CAMERA_STATUS.GRANTED);
    // NOTE: we deliberately do NOT touch videoRef.current here. The <video>
    // element is only mounted by the caller once status === GRANTED (it's
    // conditionally rendered), so at this exact point in the code it does
    // not exist in the DOM yet — videoRef.current would still be null. The
    // effect below runs after that render commits, once the element is
    // guaranteed to exist, and does the actual attachment.
  }, []);

  // Attach the active stream to the <video> element once it exists. This
  // runs after React has committed the render triggered by setStatus(GRANTED)
  // above, so videoRef.current is guaranteed to be the real, mounted node.
  useEffect(() => {
    if (status === CAMERA_STATUS.GRANTED && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      // Some mobile browsers ignore autoPlay on a stream attached after mount; play() is harmless when already playing.
      const p = videoRef.current.play && videoRef.current.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }, [status]);

  const start = useCallback(async () => {
    if (!window.isSecureContext) {
      setStatus(CAMERA_STATUS.INSECURE_CONTEXT);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus(CAMERA_STATUS.UNSUPPORTED);
      return;
    }
    // Never hold two streams: release any current one before asking again.
    stopStream(streamRef.current, videoRef.current);
    streamRef.current = null;
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    setStatus(CAMERA_STATUS.REQUESTING);
    const result = await requestCameraStream(navigator.mediaDevices);
    if (result.stream) {
      if (!mountedRef.current || !acceptOrReleaseStream(requestId, requestIdRef.current, result.stream)) return;
      attachStream(result.stream, result.facing);
      return;
    }
    if (mountedRef.current && requestId === requestIdRef.current) setStatus(result.status);
  }, [attachStream]);

  const message = USER_MESSAGES[status] || null;

  return { videoRef, status, facing, message, start, stop };
}
