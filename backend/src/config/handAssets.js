/**
 * The four official hand reference diagrams, as provided by the doctor.
 * These files are the exact cropped assets from the supplied reference sheet —
 * nothing here is generated, redrawn, or substituted. If you need to replace
 * one, drop a new PNG into backend/assets/hands/ with the same filename and
 * update width/height below to match its real pixel dimensions.
 *
 * `width`/`height` become the canvas's reference dimensions — every object's
 * normalized (0-1) x/y/width/height is relative to these numbers, so keep
 * them in sync with the actual file if you ever swap an asset.
 */
const HAND_ASSETS = {
  left_front: {
    key: 'left_front',
    label: 'Left Front',
    handSide: 'left',
    handView: 'front',
    file: 'left_front.png',
    width: 1586,
    height: 1982,
  },
  right_front: {
    key: 'right_front',
    label: 'Right Front',
    handSide: 'right',
    handView: 'front',
    file: 'right_front.png',
    width: 1585,
    height: 1983,
  },
  left_back: {
    key: 'left_back',
    label: 'Left Back',
    handSide: 'left',
    handView: 'back',
    file: 'left_back.png',
    width: 1585,
    height: 1981,
  },
  right_back: {
    key: 'right_back',
    label: 'Right Back',
    handSide: 'right',
    handView: 'back',
    file: 'right_back.png',
    width: 1971,
    height: 2010,
  },
};

// Fixed, ordered list — every hand protocol gets exactly these four canvases.
const HAND_VIEW_ORDER = ['left_front', 'right_front', 'left_back', 'right_back'];

module.exports = { HAND_ASSETS, HAND_VIEW_ORDER };
