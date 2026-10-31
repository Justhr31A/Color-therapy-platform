/**
 * [DETERMINISTIC SOFTWARE TESTS] the four hand reference PNGs.
 *
 * These images are source assets: every reference calibration point in
 * frontend/src/tracking/referenceHandPoints.js was measured on these exact
 * pixels, and every saved protocol's normalized coordinates are relative to
 * their dimensions. Changing one silently would silently misplace every
 * overlay. This test therefore (a) checks the configured width/height match
 * the real files and (b) pins each file's SHA-256.
 *
 * If you REPLACE an asset on purpose: update the width/height in
 * src/config/handAssets.js, re-measure referenceHandPoints.js for that view,
 * re-validate on a real device, and only then update the hash below.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { HAND_ASSETS, HAND_VIEW_ORDER } = require('../src/config/handAssets');

const PINNED_SHA256 = {
  left_front: '69cee285a2d47706d49635041d19d109ee415e6a52b368c13a73ab5382b4a82a',
  right_front: '1f4b25c1bada5d0de944291a65be6ce3ae2b5f1783fc1809330cf19784aff30d',
  left_back: '2a8c5da428ef3b6b1b4761e550e8ce32a059453c287ed98e593b9bd934851b3e',
  right_back: 'e9b590ad818318df8f6170bd80cddf54674ecf172a86e5b40af96fc144131bcf',
};
const dir = path.join(__dirname, '..', 'assets', 'hands');

function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG file');
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('[DETERMINISTIC] hand reference PNG assets', () => {
  it('there are exactly four views, in the fixed order every hand protocol uses', () => {
    assert.deepEqual(HAND_VIEW_ORDER, ['left_front', 'right_front', 'left_back', 'right_back']);
    assert.deepEqual(Object.keys(HAND_ASSETS).sort(), [...HAND_VIEW_ORDER].sort());
  });
  for (const key of ['left_front', 'right_front', 'left_back', 'right_back']) {
    it(`${key}: configured size equals the real image size, and the file is byte-for-byte the pinned original`, () => {
      const buf = fs.readFileSync(path.join(dir, HAND_ASSETS[key].file));
      const { width, height } = pngSize(buf);
      assert.deepEqual({ width: HAND_ASSETS[key].width, height: HAND_ASSETS[key].height }, { width, height }, 'config does not match the PNG');
      assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), PINNED_SHA256[key], `${key}.png has changed — see the note at the top of this file`);
    });
  }
});
