/**
 * Organ / body diagram registry.
 *
 * IMPORTANT — read this: no real organ/body reference artwork was provided
 * for this build (only the four hand diagrams were supplied). The single
 * entry below is a crude, clearly-generic placeholder wireframe included
 * only so the organ/body canvas type is wired up end-to-end and testable
 * (see Phase 1 acceptance tests 19-21). It is marked `isPlaceholder: true`,
 * which the frontend reads and displays as a visible "placeholder asset"
 * banner in the builder — it is never presented as a finished diagram.
 *
 * Asset files can be PNG, JPG, or SVG — the static file server
 * (backend/src/server.js) and the frontend's background-image loader both
 * work from the file extension, so nothing else needs to change to accept
 * a vector organ/body diagram later.
 *
 * To add a real organ/body diagram later:
 *   1. Drop the image file (png/jpg/svg) into backend/assets/organs/
 *   2. Add an entry here with a unique key, label, file name, category,
 *      and the file's real pixel width/height (for an SVG, use its
 *      viewBox width/height).
 *   3. Omit `isPlaceholder` (or set it to false) once it's a real asset.
 *   4. No other code changes are needed — the builder, canvas renderer,
 *      and save/load logic all read this registry dynamically.
 */
const ORGAN_ASSETS = {
  body_front_placeholder: {
    key: 'body_front_placeholder',
    label: 'Generic Body Outline (placeholder — replace with real asset)',
    category: 'body',
    file: 'body_front_placeholder.png',
    width: 800,
    height: 1400,
    isPlaceholder: true,
  },
};

module.exports = { ORGAN_ASSETS };
