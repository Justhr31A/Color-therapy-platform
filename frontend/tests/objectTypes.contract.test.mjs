/** [DETERMINISTIC SOFTWARE TESTS] the frontend and backend must agree on object types and finger names. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OBJECT_TYPES as UI_TYPES, FINGERS as UI_FINGERS, LEGACY_FINGER_ALIASES as UI_ALIASES, fingerForDisplay } from '../src/builder/objectDefaults.js';

const require = createRequire(import.meta.url);
const backend = require('../../backend/src/protocol/vocabulary.js');

describe('[DETERMINISTIC] frontend <-> backend vocabulary contract', () => {
  it('the builder offers exactly the object types the API accepts (a mismatch would mean saves failing with "Unknown object type")', () => {
    assert.deepEqual(UI_TYPES.map((t) => t.type), [...backend.OBJECT_TYPES]);
    assert.equal(UI_TYPES.length, 12, 'the original ten plus fingerBand and text');
  });
  it('canonical finger names are identical on both sides', () => {
    assert.deepEqual([...UI_FINGERS], [...backend.FINGERS]);
    assert.deepEqual({ ...UI_ALIASES }, { ...backend.LEGACY_FINGER_ALIASES });
  });
  it('a legacy "pinky" from an old saved protocol is displayed as "little" (so the dropdown is not blank) and canonical values are unchanged', () => {
    assert.equal(fingerForDisplay('pinky'), 'little');
    for (const f of UI_FINGERS) assert.equal(fingerForDisplay(f), f);
    assert.equal(fingerForDisplay(null), '');
    assert.equal(fingerForDisplay(undefined), '');
    assert.ok(UI_FINGERS.includes(fingerForDisplay('pinky')), 'the displayed value must be one of the dropdown options');
  });
});
