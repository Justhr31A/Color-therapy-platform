/** [DETERMINISTIC SOFTWARE TESTS] slug generation (pure functions). */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { slugify, isValidSlug, uniqueSlug, MAX_SLUG_LENGTH } = require('../src/services/slug');

describe('[DETERMINISTIC] slugs', () => {
  it('turns a name into a lowercase, URL-safe slug (the example from the brief)', () => {
    assert.equal(slugify('Headache Relief Protocol'), 'headache-relief-protocol');
  });
  it('is deterministic: the same name always gives the same slug', () => {
    for (let i = 0; i < 5; i += 1) assert.equal(slugify('  Sleep & Relaxation!! '), 'sleep-and-relaxation');
  });
  it('strips accents, punctuation and repeated separators; never starts/ends with a hyphen', () => {
    assert.equal(slugify('Café  --  Crème'), 'cafe-creme');
    assert.equal(slugify('---Hello___World---'), 'hello-world');
    assert.equal(slugify("Back & Neck (Chronic) #1"), 'back-and-neck-chronic-1');
  });
  it('always produces something valid, even from a name with no Latin letters', () => {
    assert.equal(slugify('सिरदर्द', { fallback: 'protocol' }), 'protocol');
    assert.equal(slugify('!!!'), 'item');
    assert.equal(slugify(null, { fallback: 'category' }), 'category');
  });
  it('caps the length without leaving a trailing hyphen', () => {
    const s = slugify(`${'a'.repeat(79)} bbb`);
    assert.ok(s.length <= MAX_SLUG_LENGTH);
    assert.ok(!s.endsWith('-'));
    assert.equal(slugify('x'.repeat(500)).length, MAX_SLUG_LENGTH);
  });
  it('everything slugify returns is accepted by isValidSlug', () => {
    for (const name of ['A', 'Hello World', 'Ünïcödé Näme', 'a'.repeat(300), '9 lives', '$$$', 'Tab\tand\nnewline']) {
      assert.ok(isValidSlug(slugify(name)), `slugify(${JSON.stringify(name)}) -> ${slugify(name)}`);
    }
  });
  it('isValidSlug rejects uppercase, spaces, double/edge hyphens, symbols, empty and over-long values', () => {
    for (const bad of ['Upper', 'has space', 'a--b', '-a', 'a-', 'a_b', 'a/b', '', 'a'.repeat(81), null, undefined, 5]) assert.equal(isValidSlug(bad), false, String(bad));
    for (const good of ['a', 'a-b', 'headache-relief-protocol', 'x1', '2024-plan', 'a'.repeat(80)]) assert.equal(isValidSlug(good), true, good);
  });
  it('resolves collisions with -2, -3 … and returns the plain slug when it is free', () => {
    const taken = new Set(['calm', 'calm-2']);
    assert.equal(uniqueSlug('sleep', (s) => taken.has(s)), 'sleep');
    assert.equal(uniqueSlug('calm', (s) => taken.has(s)), 'calm-3');
  });
  it('keeps a suffixed slug within the length limit and still valid', () => {
    const base = 'a'.repeat(MAX_SLUG_LENGTH);
    const taken = new Set([base]);
    const out = uniqueSlug(base, (s) => taken.has(s));
    assert.ok(out.length <= MAX_SLUG_LENGTH && isValidSlug(out));
    assert.notEqual(out, base);
  });
  it('never loops forever, even when everything looks taken', () => {
    const out = uniqueSlug('x', () => true, { maxAttempts: 5 });
    assert.ok(isValidSlug(out) && out.startsWith('x-'));
  });
});
