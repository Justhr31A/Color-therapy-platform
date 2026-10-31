// Standard MediaPipe 21-point hand topology (wrist=0, then thumb, index,
// middle, ring, pinky, each base→tip). Used only to draw connecting lines
// for the dev-mode skeleton overlay — this is NOT the protocol mapping
// layer (that's Phase 2 §7, not built yet).
import { correctHandedness } from './handedness';
import { videoPointToCanvas, videoLengthToCanvas } from './videoCover';

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [5, 9], [9, 10], [10, 11], [11, 12], // middle
  [9, 13], [13, 14], [14, 15], [15, 16], // ring
  [13, 17], [17, 18], [18, 19], [19, 20], // pinky
  [0, 17], // palm base
];

/**
 * Draws the detected hand skeleton onto the overlay canvas. `landmarks` are
 * MediaPipe's normalized (0-1) VIDEO-FRAME coordinates; `coverMapping`
 * (from videoCover.js) converts those into the canvas's own pixel buffer,
 * accounting for the object-fit:cover crop/scale the <video> element
 * undergoes so the skeleton lines up with what's actually on screen. This
 * is purely a dev-visualization aid — it does not touch the Phase 1
 * protocol coordinate system at all.
 */
export function drawHandLandmarks(ctx, canvasWidth, canvasHeight, result, videoWidth, videoHeight, coverMapping) {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  if (!result || !result.landmarks || result.landmarks.length === 0) return;

  const toCanvas = (p) => videoPointToCanvas(p.x, p.y, videoWidth, videoHeight, coverMapping);
  const lengthToCanvas = (n) => videoLengthToCanvas(n, videoWidth, coverMapping);

  result.landmarks.forEach((landmarks, handIndex) => {
    const rawLabel = result.handedness?.[handIndex]?.[0]?.categoryName;
    const handednessLabel = correctHandedness(rawLabel) || '?';
    const color = handednessLabel === 'Left' ? '#e5484d' : '#1a73e8';

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, lengthToCanvas(0.004));
    HAND_CONNECTIONS.forEach(([a, b]) => {
      const pa = landmarks[a];
      const pb = landmarks[b];
      if (!pa || !pb) return;
      const ca = toCanvas(pa);
      const cb = toCanvas(pb);
      ctx.beginPath();
      ctx.moveTo(ca.x, ca.y);
      ctx.lineTo(cb.x, cb.y);
      ctx.stroke();
    });

    ctx.fillStyle = '#ffffff';
    landmarks.forEach((p) => {
      const c = toCanvas(p);
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(3, lengthToCanvas(0.006)), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Label near the wrist point.
    const wrist = landmarks[0];
    if (wrist) {
      const c = toCanvas(wrist);
      ctx.font = `${Math.max(14, lengthToCanvas(0.025))}px sans-serif`;
      ctx.fillStyle = color;
      ctx.fillText(handednessLabel, c.x + 12, c.y);
    }
  });
}
