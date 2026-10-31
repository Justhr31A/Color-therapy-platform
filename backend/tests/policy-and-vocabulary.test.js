/** [DETERMINISTIC SOFTWARE TESTS] — protocol access policy and shared vocabulary (pure functions, no database). */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isAdmin, canManageProtocol } = require('../src/policy/protocolAccess');
const { OBJECT_TYPES, FINGERS, LEGACY_FINGER_ALIASES, canonicalFinger } = require('../src/protocol/vocabulary');

describe('[DETERMINISTIC] who may manage a protocol', () => {
  const admin = { id: 'a1', role: 'admin' };
  const doctorA = { id: 'd1', role: 'doctor' };
  const doctorB = { id: 'd2', role: 'doctor' };
  const patient = { id: 'p1', role: 'patient' };
  const ownedByA = { id: 'x', doctor_id: 'd1' };

  it('admin can manage any protocol, including ones created by doctors', () => {
    assert.equal(canManageProtocol(admin, ownedByA), true);
    assert.equal(canManageProtocol(admin, { id: 'y', doctor_id: 'someone-else' }), true);
  });
  it('a doctor can manage only their own protocols (unchanged legacy behaviour)', () => {
    assert.equal(canManageProtocol(doctorA, ownedByA), true);
    assert.equal(canManageProtocol(doctorB, ownedByA), false);
  });
  it('a patient can never manage a protocol — even one whose doctor_id equals their own id', () => {
    assert.equal(canManageProtocol(patient, ownedByA), false);
    assert.equal(canManageProtocol({ id: 'd1', role: 'patient' }, ownedByA), false);
  });
  it('missing user or protocol is never allowed (no crash)', () => {
    assert.equal(canManageProtocol(null, ownedByA), false);
    assert.equal(canManageProtocol(undefined, ownedByA), false);
    assert.equal(canManageProtocol(admin, null), false);
    assert.equal(canManageProtocol(admin, undefined), false);
  });
  it('isAdmin is true only for role "admin"', () => {
    assert.equal(isAdmin(admin), true);
    assert.equal(isAdmin(doctorA), false);
    assert.equal(isAdmin(patient), false);
    assert.equal(isAdmin(null), false);
  });
});

describe('[DETERMINISTIC] protocol vocabulary', () => {
  it('supports the ORIGINAL 10 object types unchanged and in the same order, plus the two added with the Studio', () => {
    const original = ['dot', 'ring', 'hline', 'vline', 'freeline', 'invertedTriangle', 'triangle', 'rectangle', 'square', 'arrow'];
    assert.deepEqual([...OBJECT_TYPES].slice(0, 10), original, 'none of the original ten was removed or reordered');
    assert.deepEqual([...OBJECT_TYPES].slice(10), ['fingerBand', 'text']);
    assert.equal(OBJECT_TYPES.length, 12);
  });
  it('canonical fingers are thumb, index, middle, ring, little', () => {
    assert.deepEqual([...FINGERS], ['thumb', 'index', 'middle', 'ring', 'little']);
  });
  it('legacy "pinky" is not canonical but is recognised as an alias of "little"', () => {
    assert.equal(FINGERS.includes('pinky'), false);
    assert.deepEqual({ ...LEGACY_FINGER_ALIASES }, { pinky: 'little' });
  });
  it('writing maps legacy "pinky" to "little" (case/space tolerant) and leaves canonical values alone', () => {
    assert.equal(canonicalFinger('pinky'), 'little');
    assert.equal(canonicalFinger('  Pinky '), 'little');
    for (const f of FINGERS) assert.equal(canonicalFinger(f), f);
  });
  it('empty values become null, and unknown values pass through untouched (the API never rejected them before)', () => {
    assert.equal(canonicalFinger(null), null);
    assert.equal(canonicalFinger(undefined), null);
    assert.equal(canonicalFinger(''), null);
    assert.equal(canonicalFinger('toe'), 'toe');
  });
});
