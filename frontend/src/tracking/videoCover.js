/**
 * ROOT CAUSE of the dot-position bug (Part 6 of the investigation):
 *
 * `.camera-video` is styled with `object-fit: cover` — the browser scales
 * the video UNIFORMLY (preserving aspect ratio) until it fills its box,
 * cropping whatever overflows. `.camera-overlay-canvas` sits in the exact
 * same box but has no such property — a <canvas> element's CSS width/
 * height just STRETCHES its drawing buffer to fill the box, non-uniformly,
 * with no cropping. Those are two different mappings of the same
 * underlying video frame onto the same on-screen box. Whenever the video's
 * native aspect ratio (e.g. ~1280x720) differs from the container's
 * on-screen aspect ratio (near-certain on a phone in portrait orientation),
 * the video and the canvas disagree about where any given point in the
 * frame actually lands on screen — which is exactly why a mapped dot could
 * end up "significantly away" from where it should be, independent of how
 * accurate the reference points or the similarity transform are.
 *
 * The fix: give the canvas a drawing buffer that matches its own on-screen
 * pixel size (so CSS stretching is a 1:1 no-op), and manually replicate
 * object-fit:cover's scale+crop math when converting a normalized point in
 * VIDEO-FRAME space into a pixel position in that buffer. This is applied
 * only at the final draw step — the calibration/similarity-transform math
 * (similarityTransform.js, protocolMapper.js) is untouched and stays
 * entirely in video-frame-normalized space throughout, exactly as before.
 */

/**
 * `scale` is how much the video is uniformly enlarged to cover the
 * container; `offsetX`/`offsetY` are how far the (now-oversized) video is
 * shifted to center it, which is also how much gets cropped off each side.
 */
export function computeCoverMapping(videoWidth, videoHeight, containerWidth, containerHeight) {
  if (!videoWidth || !videoHeight || !containerWidth || !containerHeight) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.max(containerWidth / videoWidth, containerHeight / videoHeight);
  const offsetX = (containerWidth - videoWidth * scale) / 2;
  const offsetY = (containerHeight - videoHeight * scale) / 2;
  return { scale, offsetX, offsetY };
}

/** Converts a normalized (0-1) point in VIDEO-FRAME space into a pixel position in the canvas buffer. */
export function videoPointToCanvas(normX, normY, videoWidth, videoHeight, coverMapping) {
  return {
    x: coverMapping.offsetX + normX * videoWidth * coverMapping.scale,
    y: coverMapping.offsetY + normY * videoHeight * coverMapping.scale,
  };
}

/** Converts a distance (e.g. a radius) in VIDEO-FRAME-normalized units into canvas pixels. */
export function videoLengthToCanvas(normLength, videoWidth, coverMapping) {
  return normLength * videoWidth * coverMapping.scale;
}

/**
 * The canvas drawing-buffer size for a CSS box on a screen with `devicePixelRatio` (capped, to bound the per-frame
 * cost). The buffer keeps the box's exact aspect ratio, so CSS scales it uniformly back to the box and every mapping
 * above (computed against the BUFFER size) stays exact — it is only sharper on high-density screens.
 */
export function canvasBufferSize(cssWidth, cssHeight, devicePixelRatio = 1, maxRatio = 2) {
  const r = Math.min(Math.max(Number(devicePixelRatio) || 1, 1), maxRatio);
  return { width: Math.round(cssWidth * r), height: Math.round(cssHeight * r), ratio: r };
}

/**
 * Inverse of the whole display pipeline for one on-screen click: a point in the canvas element's CSS pixels (relative to
 * its top-left as the viewer sees it) → VIDEO-FRAME pixels. `mirrored` = the frame is shown with CSS scaleX(-1) (selfie
 * camera); `bufferRatio` = buffer px per CSS px.
 */
export function clientPointToVideo(cssX, cssY, { cssWidth, mirrored = false, bufferRatio = 1 }, coverMapping) {
  const x = (mirrored ? cssWidth - cssX : cssX) * bufferRatio;
  const y = cssY * bufferRatio;
  return { x: (x - coverMapping.offsetX) / coverMapping.scale, y: (y - coverMapping.offsetY) / coverMapping.scale };
}
