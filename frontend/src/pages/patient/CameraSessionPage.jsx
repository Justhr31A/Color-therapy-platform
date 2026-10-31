import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom';
import api from '../../api/client';
import useCamera, { CAMERA_STATUS } from '../../camera/useCamera';
import useHandLandmarker, { TRACKER_STATUS } from '../../tracking/useHandLandmarker';
import { drawHandLandmarks } from '../../tracking/drawHandLandmarks';
import { transformScale, transformRotation, transformTranslation } from '../../tracking/similarityTransform';
import { drawProtocolOverlay } from '../../tracking/drawProtocolOverlay';
import { computeCoverMapping, videoPointToCanvas, canvasBufferSize } from '../../tracking/videoCover';
import { cameraGuidance, viewInstruction } from '../../tracking/cameraGuidance';
import { prepareArView, computeArFrame, AR_OBJECT_TYPES as FRAME_AR_OBJECT_TYPES } from '../../tracking/arFrame';
import { createHandTracker } from '../../tracking/handTracker';
import { createCalibrator, calibrationMessage } from '../../tracking/calibration';
import { readLocalOverride } from '../../tracking/referenceLandmarks';
import { palmWidthOf } from '../../tracking/arMetrics';
import ArValidationPanel from '../../camera/ArValidationPanel';

/**
 * Phase 2, Step 6 (validated on real device) + Step 7 — ring/circle mapping
 * added on top of the SAME proven pixel-space transform. No second
 * tracking/calibration system: dots and rings both flow through one
 * `mapProtocolObjects` call and one fitted transform per frame. See
 * protocolMapper.js for the ring-specific conversion (radius/stroke width
 * both scale by the transform's scale factor, same principle as the dot's
 * radius). Handedness/chirality logic from Step 6 is UNCHANGED — it's
 * already validated and working correctly.
 *
 * ROOT CAUSE found this pass (reproduced numerically, not guessed): the
 * similarity transform was being fitted directly on two differently-shaped
 * normalized 0-1 coordinate spaces — reference points normalized against a
 * TALL PNG (~0.8:1) and live landmarks normalized against a WIDE video
 * frame (~1.78:1). A uniform-scale transform can't correctly reconcile two
 * spaces with different aspect ratios; the fit only looked reasonable for
 * points very close to the calibration cluster's centroid and distorted
 * for anything else — including the doctor's dot. See protocolMapper.js
 * for the full explanation and the fix: fit and apply the transform in
 * each space's own TRUE PIXEL units instead of raw normalized fractions.
 */
/** Which saved objects the camera can draw (see tracking/arFrame.js): dots with their rings, rings, finger bands, lines and shapes. */
export const AR_OBJECT_TYPES = FRAME_AR_OBJECT_TYPES;

/**
 * The legacy PATIENT route: /patient/protocols/:id/session/:viewKey. It only finds the canvas (from the router state
 * or the patient API) and hands it to the shared camera session below, which is exactly the code that used to live in
 * this component. The public route (pages/public/PublicCameraPage.jsx) hands the same core a PUBLISHED canvas.
 */
export default function CameraSessionPage() {
  const { id, viewKey } = useParams();
  const location = useLocation();

  const [canvas, setCanvas] = useState(location.state?.canvas || null);
  const [canvasError, setCanvasError] = useState(null);
  const viewLabel = location.state?.viewLabel || canvas?.backgroundLabel || `View ${viewKey.slice(0, 8)}`;

  useEffect(() => {
    if (canvas) return;
    api
      .get(`/patient/protocols/${id}`)
      .then((res) => {
        const found = res.data.canvases.find((c) => c.id === viewKey);
        if (found) setCanvas(found);
        else setCanvasError('That view could not be found in this protocol.');
      })
      .catch((err) => setCanvasError(err.message));
  }, [canvas, id, viewKey]);

  if (canvasError) {
    return (
      <div className="page-center">
        <div className="card">
          <h2>Couldn&apos;t open this view</h2>
          <p>{canvasError}</p>
          <Link to={`/patient/protocols/${id}`}>Back</Link>
        </div>
      </div>
    );
  }
  if (!canvas) {
    return (
      <div className="page-center">
        <p className="muted" role="status">Loading this view…</p>
      </div>
    );
  }
  return <CameraSessionCore canvas={canvas} viewLabel={viewLabel} backTo={`/patient/protocols/${id}`} />;
}

/**
 * The live camera session for ONE hand view. `canvas` is a protocol canvas: { viewKey, canvasType, width, height,
 * objects } — the same shape from the patient API and from the published render contract. Camera frames stay in the
 * browser: nothing here uploads, stores or records them.
 *
 * `variant="public"` adds the guided, visitor-friendly messages and hides the developer readout and hand skeleton
 * (`debug` brings both back, e.g. via ?debug=1 on the public route). `title` is shown above the view label.
 *
 * Callers should mount it with a `key` that changes with the protocol and view, so a new selection always starts from
 * a clean slate (no previous overlay, no previous smoothing state, a fresh camera request).
 */
export function CameraSessionCore({ canvas, viewLabel, backTo, variant = 'legacy', viewLinks = null, title = null, debug = false, mapping = 'skeleton', predictMs = null, palmModel = 'perspective' }) {
  const navigate = useNavigate();
  const guided = variant === 'public';
  const showDiagnostics = !guided || Boolean(debug);
  const hadHandRef = useRef(false);

  // An administrator's "preview on this device" reference skeleton (admin/hand-reference), if any. Read once.
  const referenceOverride = useMemo(() => readLocalOverride(), []);
  // Everything that depends only on the selected view (reference skeleton, skinning weights, drawable objects in order).
  const view = useMemo(() => prepareArView(canvas, { referenceOverride }), [canvas, referenceOverride]);
  const expectedHandSide = view.expectedHandSide;
  // Temporal tracking (outliers, smoothing, hold/fade, reliability) and the guided calibration — one of each per view.
  const handTracker = useMemo(() => createHandTracker(Number.isFinite(predictMs) ? { predictMs } : {}), [canvas, predictMs]); // eslint-disable-line react-hooks/exhaustive-deps
  const calibrator = useMemo(() => createCalibrator(), [canvas]); // eslint-disable-line react-hooks/exhaustive-deps
  const [calibrationSkipped, setCalibrationSkipped] = useState(false);
  const calibrationOn = !calibrationSkipped;
  // Latest frame, for the validation tools — kept in a ref so the loop never re-renders React for it.
  const frameDataRef = useRef(null);
  const validationRef = useRef(null);

  const camera = useCamera();
  // The public camera asks for two hands so it can say "please show only one hand"; the legacy page keeps tracking one.
  const tracker = useHandLandmarker({ numHands: guided ? 2 : 1 });

  const frameRef = useRef(null);
  const canvasElRef = useRef(null);
  const rafRef = useRef(null);
  const loopTokenRef = useRef(0); // guarantees exactly ONE running animation loop per session
  const fpsRef = useRef({ frames: 0, lastSample: performance.now() });
  const containerSizeRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        containerSizeRef.current = {
          width: Math.round(entry.contentRect.width),
          height: Math.round(entry.contentRect.height),
        };
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [camera.status]);

  const [debugState, setDebug] = useState({
    handDetected: false,
    isConfident: false,
    rawHandedness: null,
    finalHandSide: null,
    confidence: 0,
    landmarkCount: 0,
    fps: 0,
    handMatches: null,
    calibration: 'idle',
    videoMirrored: false,
    videoSourceW: 0,
    videoSourceH: 0,
    displayedW: 0,
    displayedH: 0,
    coverScale: 0,
    coverOffsetX: 0,
    coverOffsetY: 0,
    wristLive: null,
    mappedCount: 0,
    savedDotNorm: null,
    refDotPixel: null,
    liveDotPixel: null,
    liveDotNorm: null,
    finalCanvasXY: null,
    transformScale: null,
    transformRotationDeg: null,
    transformTranslation: null,
    savedCircleNorm: null,
    savedCircleRadius: null,
    refCirclePixel: null,
    liveCirclePixel: null,
    liveCircleNorm: null,
    finalCircleCanvasXY: null,
    transformedRadius: null,
  });
  const debug_ = debugState;
  const lastCalibrationRef = useRef('idle');

  const clearOverlay = useCallback(() => {
    const el = canvasElRef.current;
    if (el && el.width && el.height) el.getContext('2d')?.clearRect(0, 0, el.width, el.height);
  }, []);

  const runFrame = useCallback(() => {
    const video = camera.videoRef.current;
    const canvasEl = canvasElRef.current;
    const container = containerSizeRef.current;
    if (!(video && canvasEl && video.videoWidth > 0 && container.width > 0)) return;

    // Drawing buffer = CSS box × devicePixelRatio (same aspect ratio, so every mapping stays exact; just sharper).
    const buffer = canvasBufferSize(container.width, container.height, typeof window !== 'undefined' ? window.devicePixelRatio : 1);
    if (canvasEl.width !== buffer.width || canvasEl.height !== buffer.height) {
      canvasEl.width = buffer.width;
      canvasEl.height = buffer.height;
    }
    const coverMapping = computeCoverMapping(video.videoWidth, video.videoHeight, canvasEl.width, canvasEl.height);
    const ctx = canvasEl.getContext('2d');
    // Every frame starts from an empty overlay: nothing from an earlier frame, view or protocol can linger.
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    const detectStart = performance.now();
    const result = tracker.detect(video);
    const detectMs = performance.now() - detectStart;
    if (result && showDiagnostics) {
      drawHandLandmarks(ctx, canvasEl.width, canvasEl.height, result, video.videoWidth, video.videoHeight, coverMapping);
    }

    const now = performance.now();
    const frame = computeArFrame({
      result,
      view,
      video: { width: video.videoWidth, height: video.videoHeight },
      tracker: handTracker,
      calibrator: calibrationOn ? calibrator : null,
      timestampMs: now,
      multiHandCheck: guided,
      mapping,
      palmModel,
    });
    const isMirrored = camera.facing === 'user';
    let debugTrace = {};
    if (frame.mapped.length > 0) {
      // 'ok' or 'holding' (a brief dropout, fading out) — never anything else.
      drawProtocolOverlay(ctx, video.videoWidth, video.videoHeight, coverMapping, frame.mapped, { mirrored: isMirrored });
    }
    if (frame.calibration === 'ok') hadHandRef.current = true;
    const live = frame.liveLandmarksPixels;
    const prevT = frameDataRef.current ? frameDataRef.current.t : now;
    frameDataRef.current = {
      t: now, dt: now - prevT, detectMs, state: frame.trackerState, calibration: frame.calibration,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight, coverMapping, bufferRatio: buffer.ratio,
      cssWidth: container.width, cssHeight: container.height, mirrored: isMirrored,
      palmWidthPx: live ? palmWidthOf(live) : 0,
      palmModelUsed: frame.palmModelUsed || null,
      markings: frame.mapped.map((m) => ({ id: m.id, type: m.type, x: m.x * video.videoWidth, y: m.y * video.videoHeight, v: m.visibility })),
    };
    if (validationRef.current && validationRef.current.recording) {
      const fd = frameDataRef.current;
      validationRef.current.recordFrame({ t: fd.t, dt: fd.dt, detectMs, state: fd.state, calibration: fd.calibration, palmWidthPx: fd.palmWidthPx, markings: fd.markings.filter((m) => Number.isFinite(m.x)).map(({ id, x, y, v }) => ({ id, x, y, v })) });
    }
    if (frame.calibration === 'ok' && frame.transform) {
      if (showDiagnostics) {
        const { transform, mapped } = frame;
        const objects = view.mappableObjects;
        debugTrace = {
          transformScale: transformScale(transform),
          transformRotationDeg: (transformRotation(transform) * 180) / Math.PI,
          transformTranslation: transformTranslation(transform),
        };
        const savedDot = objects.find((o) => o.type === 'dot');
        const mappedDot = savedDot && mapped.find((m) => m.id === savedDot.id);
        if (savedDot && mappedDot) {
          debugTrace.savedDotNorm = { x: savedDot.x, y: savedDot.y };
          debugTrace.refDotPixel = { x: savedDot.x * canvas.width, y: savedDot.y * canvas.height };
          debugTrace.liveDotPixel = { x: mappedDot.x * video.videoWidth, y: mappedDot.y * video.videoHeight };
          debugTrace.liveDotNorm = { x: mappedDot.x, y: mappedDot.y };
          debugTrace.finalCanvasXY = videoPointToCanvas(mappedDot.x, mappedDot.y, video.videoWidth, video.videoHeight, coverMapping);
        }
        const savedRing = objects.find((o) => o.type === 'ring');
        const mappedRing = savedRing && mapped.find((m) => m.id === savedRing.id);
        if (savedRing && mappedRing) {
          debugTrace.savedCircleNorm = { x: savedRing.x, y: savedRing.y };
          debugTrace.savedCircleRadius = savedRing.width;
          debugTrace.refCirclePixel = { x: savedRing.x * canvas.width, y: savedRing.y * canvas.height };
          debugTrace.liveCirclePixel = { x: mappedRing.x * video.videoWidth, y: mappedRing.y * video.videoHeight };
          debugTrace.liveCircleNorm = { x: mappedRing.x, y: mappedRing.y };
          debugTrace.finalCircleCanvasXY = videoPointToCanvas(mappedRing.x, mappedRing.y, video.videoWidth, video.videoHeight, coverMapping);
          debugTrace.transformedRadius = mappedRing.radius;
        }
      }
    }

    fpsRef.current.frames += 1;
    const elapsed = now - fpsRef.current.lastSample;
    // The visible status updates at once when the alignment state changes (e.g. the hand leaves), otherwise twice a second.
    if (elapsed >= 500 || frame.calibration !== lastCalibrationRef.current) {
      // Computed NOW: React runs the state updater later, after the counter below has been reset.
      const fpsNow = elapsed >= 500 ? Math.round((fpsRef.current.frames * 1000) / elapsed) : null;
      lastCalibrationRef.current = frame.calibration;
      const hands = result?.landmarks || [];
      setDebug((prev) => ({
        ...prev,
        handDetected: frame.hasHand,
        isConfident: frame.isConfident,
        rawHandedness: frame.rawHandedness,
        finalHandSide: frame.finalHandSide,
        confidence: frame.confidence,
        landmarkCount: frame.hasHand ? hands[0].length : 0,
        fps: fpsNow != null ? fpsNow : prev.fps,
        handMatches: frame.chiralityMatches,
        calibration: frame.calibration,
        videoMirrored: isMirrored,
        videoSourceW: video.videoWidth,
        videoSourceH: video.videoHeight,
        displayedW: canvasEl.width,
        displayedH: canvasEl.height,
        coverScale: coverMapping.scale,
        coverOffsetX: coverMapping.offsetX,
        coverOffsetY: coverMapping.offsetY,
        wristLive: frame.hasHand ? { x: hands[0][0].x, y: hands[0][0].y } : null,
        mappedCount: frame.mapped.length,
        trackerState: frame.trackerState,
        palmModelUsed: frame.palmModelUsed || '—',
        overlayAlpha: frame.alpha,
        calibrationProgress: frame.calibrationProgress,
        calibrationReasons: frame.calibrationReasons,
        detectMs,
        bufferRatio: buffer.ratio,
        ...debugTrace,
      }));
      if (elapsed >= 500) {
        fpsRef.current.frames = 0;
        fpsRef.current.lastSample = now;
      }
    }
  }, [camera.videoRef, camera.facing, tracker.detect, view, handTracker, calibrator, calibrationOn, mapping, palmModel, guided, showDiagnostics, canvas]);

  useEffect(() => {
    if (camera.status !== CAMERA_STATUS.GRANTED || tracker.status !== TRACKER_STATUS.READY) return undefined;
    loopTokenRef.current += 1;
    const token = loopTokenRef.current;
    const tick = () => {
      if (token !== loopTokenRef.current) return; // a newer loop (or a stop) has taken over — this one ends
      runFrame();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      loopTokenRef.current += 1;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      handTracker.reset();
      clearOverlay();
    };
  }, [camera.status, tracker.status, runFrame, handTracker, clearOverlay]);

  /** Start calibration again (e.g. after changing hands or lighting). */
  const recalibrate = useCallback(() => {
    calibrator.reset();
    handTracker.setBaseline(null);
    setCalibrationSkipped(false);
  }, [calibrator, handTracker]);

  const stopCamera = useCallback(() => {
    loopTokenRef.current += 1;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    clearOverlay();
    handTracker.reset();
    calibrator.reset(); // a restarted (possibly different) camera calibrates again
    handTracker.setBaseline(null);
    hadHandRef.current = false;
    lastCalibrationRef.current = 'idle';
    setDebug((prev) => ({ ...prev, calibration: 'idle', handDetected: false, mappedCount: 0 }));
    camera.stop();
  }, [camera.stop, clearOverlay, handTracker, calibrator]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the page (route change, tab close, going to the background app) always releases the camera.
  useEffect(() => {
    const release = () => camera.stop();
    window.addEventListener('pagehide', release);
    return () => {
      window.removeEventListener('pagehide', release);
      release();
    };
  }, [camera.stop]);

  const isMirrored = camera.facing === 'user';
  const guidanceBase = cameraGuidance({ calibration: debug_.calibration, expectedHandSide, hadHand: hadHandRef.current, viewKey: canvas?.viewKey });
  const calibrating = calibrationOn && !calibrator.done;
  const guidance = debug_.calibration === 'calibrating'
    ? { ...guidanceBase, message: `${calibrationMessage(debug_.calibrationReasons)}${debug_.calibrationProgress > 0 ? ` ${Math.round(debug_.calibrationProgress * 100)} %` : ''}` }
    : guidanceBase;
  const hasDrawable = view.mappableObjects.length > 0;
  const unsupportedCount = canvas ? (canvas.objects || []).filter((o) => o && !AR_OBJECT_TYPES.includes(o.type)).length : 0;

  const fmt = (p) => (p ? `x=${p.x.toFixed(1)}, y=${p.y.toFixed(1)}` : '—');
  const fmtNorm = (p) => (p ? `x=${p.x.toFixed(4)}, y=${p.y.toFixed(4)}` : '—');

  return (
    <div className="camera-page" data-testid="camera-session" data-view-key={canvas?.viewKey || ''}>
      <header className="camera-topbar">
        <Link to={backTo} className="back-link" onClick={() => stopCamera()}>
          ← Back
        </Link>
        <span className="camera-title">
          {title && <span className="camera-protocol-name" data-testid="camera-protocol-name">{title}</span>}
          <span className="camera-view-name" data-testid="camera-view-name">{viewLabel}</span>
        </span>
        {Array.isArray(viewLinks) && viewLinks.length > 1 && (
          <nav className="camera-view-switch" aria-label="Switch hand view" data-testid="camera-view-switch">
            {viewLinks.map((v) => (
              <Link key={v.viewKey} to={v.to} className={v.active ? 'active' : ''} aria-current={v.active ? 'page' : undefined} onClick={() => stopCamera()}>
                {v.label}
              </Link>
            ))}
          </nav>
        )}
      </header>

      <div className="camera-viewport">
        {camera.status !== CAMERA_STATUS.GRANTED && (
          <div className="camera-overlay-message">
            {camera.status === CAMERA_STATUS.IDLE && (
              <>
                <p>This screen uses your camera to find your hand and show this protocol&apos;s markings on it. Nothing is uploaded or recorded — all processing happens on your device.</p>
                {guided && <p data-testid="camera-instruction">{viewInstruction(canvas.viewKey)}</p>}
                {guided && !hasDrawable && <p data-testid="camera-no-markings">This view has no markings that can be shown on the camera.</p>}
                <button type="button" className="btn primary" onClick={camera.start} data-testid="camera-start">
                  Start Camera
                </button>
              </>
            )}
            {camera.status === CAMERA_STATUS.REQUESTING && <p role="status">Requesting camera access…</p>}
            {[CAMERA_STATUS.DENIED, CAMERA_STATUS.UNAVAILABLE, CAMERA_STATUS.INSECURE_CONTEXT, CAMERA_STATUS.UNSUPPORTED, CAMERA_STATUS.ERROR].includes(
              camera.status
            ) && (
              <>
                <p role="alert" data-testid="camera-error">{camera.message}</p>
                <button type="button" className="btn" onClick={camera.start}>
                  Try Again
                </button>
              </>
            )}
          </div>
        )}

        {camera.status === CAMERA_STATUS.GRANTED && (
          <div ref={frameRef} className="camera-frame" style={{ transform: isMirrored ? 'scaleX(-1)' : 'none' }}>
            <video ref={camera.videoRef} autoPlay playsInline muted className="camera-video" />
            <canvas ref={canvasElRef} className="camera-overlay-canvas" aria-hidden="true" />
          </div>
        )}

        {camera.status === CAMERA_STATUS.GRANTED && tracker.status === TRACKER_STATUS.LOADING && (
          <div className="camera-status-banner" role="status">Loading hand tracking…</div>
        )}
        {tracker.status === TRACKER_STATUS.ERROR && (
          <div className="camera-status-banner error" role="alert" data-testid="tracker-error">
            {tracker.error}{' '}
            {tracker.retry && (
              <button type="button" className="camera-inline-btn" onClick={tracker.retry}>Retry</button>
            )}
          </div>
        )}

        {camera.status === CAMERA_STATUS.GRANTED && tracker.status === TRACKER_STATUS.READY && (
          <div
            data-testid="camera-guidance"
            role="status"
            className={`camera-status-banner ${
              guided ? (guidance.tone === 'ok' ? 'ok' : guidance.tone === 'warn' ? 'warn' : '') : debug_.calibration === 'ok' ? 'ok' : debug_.handDetected ? 'warn' : ''
            }`}
          >
            {(guided || debug_.calibration === 'calibrating') && guidance.message}
            {debug_.calibration === 'calibrating' && (
              <span className="camera-calibration-bar" aria-hidden="true"><span style={{ width: `${Math.round((debug_.calibrationProgress || 0) * 100)}%` }} /></span>
            )}
            {!guided && debug_.calibration !== 'calibrating' && !debug_.handDetected && 'Hand not detected'}
            {!guided && debug_.calibration !== 'calibrating' && debug_.handDetected && !debug_.isConfident && `Hand detected, but confidence is low (${debug_.confidence}%) — hold steady`}
            {!guided && debug_.calibration !== 'calibrating' && debug_.handDetected && debug_.isConfident && !debug_.handMatches && expectedHandSide && `Please show your ${expectedHandSide} hand`}
            {!guided && debug_.calibration !== 'calibrating' && debug_.handDetected && debug_.isConfident && debug_.handMatches && `Hand detected ✓ (${debug_.finalHandSide || '?'}, ${debug_.confidence}%)`}
          </div>
        )}
      </div>

      {guided && camera.status === CAMERA_STATUS.GRANTED && (
        <p className="camera-footnote">
          The markings are an approximate visual guide that follows your hand; they are not millimetre-precise.
          {unsupportedCount > 0 ? ` ${unsupportedCount} marking${unsupportedCount > 1 ? 's' : ''} in this view cannot be shown on the camera — see the protocol page.` : ''}
        </p>
      )}

      {camera.status === CAMERA_STATUS.GRANTED && showDiagnostics && (
        <div className="camera-debug-panel">
          <span>View: {viewLabel}</span>
          <span>Raw MediaPipe (diagnostic only): {debug_.rawHandedness || '—'}</span>
          <span>Final hand side (geometric): {debug_.finalHandSide || '—'}</span>
          <span>Video mirrored (CSS): {String(debug_.videoMirrored)}</span>
          <span>Video source: {debug_.videoSourceW}×{debug_.videoSourceH}</span>
          <span>Displayed (canvas buffer): {debug_.displayedW}×{debug_.displayedH}</span>
          <span>Cover scale: {debug_.coverScale.toFixed(4)}</span>
          <span>Cover crop offset: x={debug_.coverOffsetX.toFixed(1)}, y={debug_.coverOffsetY.toFixed(1)}</span>
          <span>Wrist (live, normalized): {debug_.wristLive ? fmtNorm(debug_.wristLive) : '—'}</span>
          <span>Markings drawn: {debug_.mappedCount}</span>
          <span>— Dot coordinate trace —</span>
          <span>Saved dot (normalized, reference space): {debug_.savedDotNorm ? fmtNorm(debug_.savedDotNorm) : '—'}</span>
          <span>Reference dot (pixels): {debug_.refDotPixel ? fmt(debug_.refDotPixel) : '—'}</span>
          <span>Transform scale: {debug_.transformScale ? debug_.transformScale.toFixed(4) : '—'}</span>
          <span>Transform rotation: {debug_.transformRotationDeg ? `${debug_.transformRotationDeg.toFixed(1)}°` : '—'}</span>
          <span>Transform translation (pixels): {debug_.transformTranslation ? fmt(debug_.transformTranslation) : '—'}</span>
          <span>Transformed live dot (pixels, video space): {debug_.liveDotPixel ? fmt(debug_.liveDotPixel) : '—'}</span>
          <span>Transformed live dot (normalized): {debug_.liveDotNorm ? fmtNorm(debug_.liveDotNorm) : '—'}</span>
          <span>Final canvas XY (pixels, on-screen): {debug_.finalCanvasXY ? fmt(debug_.finalCanvasXY) : '—'}</span>
          {debug_.savedCircleNorm && (
            <>
              <span>— Circle (ring) coordinate trace —</span>
              <span>Saved circle center (normalized): {fmtNorm(debug_.savedCircleNorm)}</span>
              <span>Saved radius (fraction of reference width): {debug_.savedCircleRadius?.toFixed(4)}</span>
              <span>Reference center (pixels): {fmt(debug_.refCirclePixel)}</span>
              <span>Transformed live center (pixels, video space): {fmt(debug_.liveCirclePixel)}</span>
              <span>Transformed live center (normalized): {fmtNorm(debug_.liveCircleNorm)}</span>
              <span>Final canvas center (pixels, on-screen): {fmt(debug_.finalCircleCanvasXY)}</span>
              <span>Transformed radius (normalized, video space): {debug_.transformedRadius?.toFixed(4)}</span>
            </>
          )}
          <span>— Tracking —</span>
          <span>Mapping: {mapping} · palm {debug_.palmModelUsed || '—'} (requested {palmModel}){referenceOverride ? ' · LOCAL reference override in use' : ''}</span>
          <span>Tracker: {debug_.trackerState || '—'} · overlay alpha {(debug_.overlayAlpha ?? 0).toFixed(2)}</span>
          <span>Calibration: {calibrationSkipped ? 'skipped' : calibrator.done ? 'done' : `${Math.round((debug_.calibrationProgress || 0) * 100)} % ${(debug_.calibrationReasons || []).join(', ')}`}</span>
          <span>Detect: {(debug_.detectMs ?? 0).toFixed(1)} ms · canvas buffer ×{(debug_.bufferRatio ?? 1).toFixed(2)}</span>
          <span>Landmarks: {debug_.landmarkCount}</span>
          <span>Confidence: {debug_.confidence}%</span>
          <span>Calibration: {debug_.calibration}</span>
          <span>FPS: {debug_.fps}</span>
          <span className="muted small">Developer readout — hidden from visitors (add ?debug=1 to the public camera address to show it).</span>
          <ArValidationPanel
            frameDataRef={frameDataRef}
            validationRef={validationRef}
            protocol={title}
            viewKey={canvas?.viewKey}
            mapping={mapping}
            videoRef={camera.videoRef}
          />
        </div>
      )}

      <div className="camera-controls">
        {camera.status === CAMERA_STATUS.GRANTED && (
          <button type="button" className="btn" onClick={stopCamera} data-testid="camera-stop">
            Stop Camera
          </button>
        )}
        {camera.status === CAMERA_STATUS.GRANTED && tracker.status === TRACKER_STATUS.READY && (calibrating ? (
          <button type="button" className="btn" onClick={() => setCalibrationSkipped(true)} data-testid="calibration-skip" title="Show the markings without the calibration step (less able to detect a bent finger)">
            Skip calibration
          </button>
        ) : (
          <button type="button" className="btn" onClick={recalibrate} data-testid="calibration-redo">
            Recalibrate
          </button>
        ))}
        <button
          type="button"
          className="btn"
          data-testid="camera-exit"
          onClick={() => {
            stopCamera();
            navigate(backTo);
          }}
        >
          Exit
        </button>
      </div>
    </div>
  );
}
