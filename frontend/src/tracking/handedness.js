/**
 * Real-device test result (documented here because it directly overrides
 * what this file used to assume):
 *
 *   Physical RIGHT hand shown to camera -> app displayed "Left".
 *
 * Our code was: displayed = flip(raw). Since flip is its own inverse,
 * displayed="Left" means raw="Right" — i.e. MediaPipe's RAW output was
 * already the correct answer, and the flip that used to live in this file
 * broke it. That flip was based on a documented MediaPipe convention
 * (assumes mirrored/selfie input) that does not hold — at least not in the
 * way originally assumed — for this pipeline as actually observed.
 *
 * Pipeline fact that still holds (verified by re-reading the code, not
 * re-guessed): this app NEVER mirrors the actual pixel data handed to
 * MediaPipe, in either camera mode. The only mirroring anywhere is a CSS
 * `transform: scaleX(-1)` applied to the on-screen preview container when
 * using the front/user camera — and CSS transforms are a paint-time-only
 * operation that cannot affect what `detectForVideo()` reads from the
 * `<video>` element's decoded frame buffer. So `isPixelDataMirrored` below
 * is correctly always `false` for every camera mode this app uses.
 *
 * The function is kept (rather than deleted and called directly) as a
 * single, explicit, testable seam: if this pipeline ever changes to
 * actually mirror the pixel data before handing it to MediaPipe, this is
 * the one place that would need to flip — pass `true` for
 * `isPixelDataMirrored` there, nowhere else.
 */
export function correctHandedness(rawCategoryName, isPixelDataMirrored = false) {
  if (!rawCategoryName) return null;
  if (!isPixelDataMirrored) return rawCategoryName;
  if (rawCategoryName === 'Left') return 'Right';
  if (rawCategoryName === 'Right') return 'Left';
  return rawCategoryName;
}
