/**
 * [DETERMINISTIC SOFTWARE TESTS] the AI Protocol Assistant's text helpers and matcher (src/ai/text.js, protocolMatcher.js).
 * Pure functions — no database, no network, no randomness: the same words always give the same ranking.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeText, stem, contentTokens, containsPhrase, phraseInfo } = require('../src/ai/text');
const { rank, THRESHOLDS } = require('../src/ai/protocolMatcher');

// A small published catalogue, in the shape assistantService builds from the public projections.
const entry = (o) => ({ shortDescription: '', description: '', categoryName: null, conditions: [], searchTerms: [], ...o });
const BACK = entry({
  slug: 'back-pain', name: 'Back Pain — Website Test Protocol', displayName: 'Back Pain', shortDescription: 'A gentle routine for the lower back.', categoryName: 'Musculoskeletal',
  conditions: [{ name: 'Back pain', synonyms: ['lower back stiffness', 'lumbago'] }], searchTerms: ['backache', 'sore back'],
});
const KNEE = entry({ slug: 'knee-pain', name: 'Knee Pain', displayName: 'Knee Pain', shortDescription: 'Support for sore knees.', categoryName: 'Musculoskeletal', conditions: [{ name: 'Knee pain', synonyms: [] }], searchTerms: ['knee ache', 'arthritis knee'] });
const MIGRAINE = entry({ slug: 'migraine-relief', name: 'Migraine Relief', displayName: 'Migraine Relief', shortDescription: 'For recurring headaches.', categoryName: 'Head & Neck', conditions: [{ name: 'Migraine', synonyms: ['sick headache'] }], searchTerms: ['headache'] });
const CATALOGUE = [BACK, KNEE, MIGRAINE];
const top = (q, cat = CATALOGUE) => rank([q], cat)[0];
const slugs = (q, cat = CATALOGUE) => rank([q], cat).map((r) => r.slug);

describe('[DETERMINISTIC] text normalisation', () => {
  it('lower-cases, strips accents and punctuation, drops apostrophes, collapses spaces', () => {
    assert.equal(normalizeText('  BÄCK-Pain?!  '), 'back pain');
    assert.equal(normalizeText("I don't know — what's this?"), 'i dont know whats this');
    assert.equal(normalizeText(null), '');
    assert.equal(normalizeText(undefined), '');
    assert.equal(normalizeText(12345), '12345');
  });
  it('light stemming makes plural / -ness / -ing forms meet', () => {
    const same = [['stiffness', 'stiff'], ['aches', 'ache'], ['migraines', 'migraine'], ['knees', 'knee'], ['headaches', 'headache'], ['swelling', 'swell']];
    same.forEach(([a, b]) => assert.equal(stem(a), stem(b), `${a} vs ${b}`));
    assert.equal(stem('back'), 'back');
    assert.equal(stem('ss'), 'ss');
  });
  it('everyday ways of saying "pain" are one concept, so discomfort/aches/sore all meet "pain"', () => {
    ['pain', 'pains', 'discomfort', 'ache', 'aching', 'sore', 'hurts', 'painful'].forEach((w) => assert.deepEqual(contentTokens(w), ['pain'], w));
  });
  it('stop-words (including "protocol" and request words) are dropped, duplicates removed, order kept', () => {
    assert.deepEqual(contentTokens('I want the Back Pain protocol'), ['back', 'pain']);
    assert.deepEqual(contentTokens('back back BACK pain'), ['back', 'pain']);
    assert.deepEqual(contentTokens('Do you have something for back stiffness?'), ['back', 'stiff']);
  });
  it('text with no usable English words (other scripts, emoji, punctuation) reduces to nothing and matches nothing', () => {
    ['', '   ', '???', '😀😀', 'पीठ दर्द', '日本語'].forEach((t) => assert.deepEqual(contentTokens(t), [], JSON.stringify(t)));
    assert.deepEqual(rank(['पीठ दर्द'], CATALOGUE), []);
  });
  it('containsPhrase works on whole words only ("back" is not in "backpack")', () => {
    assert.equal(containsPhrase('lower back pain', 'back pain'), true);
    assert.equal(containsPhrase('backpack', 'back'), false);
    assert.equal(containsPhrase('abc', ''), false);
  });
  it('phraseInfo exposes the comparable tokens and phrase', () => {
    assert.deepEqual(phraseInfo('Back Pain!'), { tokens: ['back', 'pain'], phrase: 'back pain' });
  });
});

describe('[DETERMINISTIC] matching: which published protocol fits the words', () => {
  it('a protocol NAME typed exactly or inside a sentence ranks that protocol first, by name', () => {
    ['Back Pain', 'I want the Back Pain protocol', 'show me the back-pain protocol', 'BACK PAIN!!', 'the back pain protocol please'].forEach((q) => {
      const t = top(q);
      assert.equal(t.slug, 'back-pain', q);
      assert.ok(t.score >= THRESHOLDS.STRONG, `${q}: ${t.score}`);
    });
    assert.equal(top('I want the Back Pain protocol').field, 'name');
  });
  it('matches on the protocol\'s display name as well as its internal name', () => {
    const cat = [entry({ slug: 'p1', name: 'internal-name-77', displayName: 'Evening Calm', conditions: [], searchTerms: [] })];
    assert.equal(top('I want the Evening Calm protocol', cat).slug, 'p1');
    assert.equal(top('internal name 77', cat).slug, 'p1');
  });
  it('matches the curated SEARCH TERMS', () => {
    assert.equal(top('sore back').slug, 'back-pain');
    assert.equal(top('knee ache').slug, 'knee-pain');
    assert.equal(top('my arthritis knee').slug, 'knee-pain');
    assert.equal(top('headache').slug, 'migraine-relief');
    assert.ok(top('I keep getting a headache').score >= THRESHOLDS.STRONG);
  });
  it('matches CONDITION names', () => {
    assert.equal(top('I get bad migraines at night').slug, 'migraine-relief');
    assert.equal(top('migraine').slug, 'migraine-relief');
    assert.ok(top('I get bad migraines at night').score >= THRESHOLDS.STRONG);
    assert.equal(top('I get bad migraines at night').field, 'condition');
  });
  it('matches condition SYNONYMS recorded by an admin', () => {
    assert.equal(top('lumbago').slug, 'back-pain');
    assert.equal(top('lumbago').field, 'synonym');
    assert.equal(top('lower back stiffness').slug, 'back-pain');
    assert.equal(top('I have a sick headache').slug, 'migraine-relief');
  });
  it('understands natural-language concerns, in any word order', () => {
    const concerns = [
      'Do you have something for back stiffness?',
      'I have lower back stiffness. Which protocol would be relevant?',
      "I have been having discomfort around my lower back and I don't know which protocol I should use.",
      'my back hurts',
      'pain in the back when I sit',
    ];
    concerns.forEach((q) => { const t = top(q); assert.equal(t.slug, 'back-pain', q); assert.ok(t.score >= THRESHOLDS.STRONG, `${q}: ${t.score}`); });
    assert.equal(top('my knees ache').slug, 'knee-pain');
  });
  it('the shared word "pain" never links two different protocols', () => {
    assert.ok(!slugs('knee pain').includes('back-pain'));
    assert.ok(!slugs('back pain').includes('knee-pain'));
  });
  it('a single generic word matches nothing ("pain", "problem", "discomfort", "I feel unwell")', () => {
    ['pain', 'problem', 'discomfort', 'I have some discomfort', 'I feel unwell', 'something is wrong'].forEach((q) => assert.deepEqual(rank([q], CATALOGUE), [], q));
  });
  it('unrelated or unknown requests match nothing', () => {
    ['what is the weather today', 'tell me a joke', 'toothache', 'I want a pizza', 'asdf qwerty'].forEach((q) => assert.deepEqual(rank([q], CATALOGUE), [], q));
  });
  it('a request for a protocol that does not exist is NOT answered with a similar-sounding one (stays below "weak")', () => {
    ['I want the Knee Replacement protocol', 'I want the Back Surgery protocol', 'Shoulder Pain protocol'].forEach((q) => {
      const t = top(q);
      assert.ok(!t || t.score < THRESHOLDS.WEAK, `${q}: ${t && t.score}`);
    });
  });
  it('descriptions and categories are only weak hints: they can never make a protocol a strong match on their own', () => {
    const cat = [entry({ slug: 'p', name: 'Alpha', displayName: 'Alpha', shortDescription: 'Helps with tension in the shoulders', description: 'daily routine for desk workers', categoryName: 'Wellbeing' })];
    ['shoulders tension', 'desk workers routine', 'wellbeing'].forEach((q) => { const t = top(q, cat); assert.ok(!t || t.score < THRESHOLDS.WEAK, `${q}: ${t && t.score}`); });
  });
  it('agreement between fields ranks above a single weak signal', () => {
    const both = entry({ slug: 'both', name: 'Neck Tension', displayName: 'Neck Tension', conditions: [{ name: 'Neck tension', synonyms: [] }], searchTerms: ['stiff neck'] });
    const one = entry({ slug: 'one', name: 'Neck Care', displayName: 'Neck Care', conditions: [], searchTerms: [] });
    assert.equal(top('neck tension', [one, both]).slug, 'both');
  });
  it('extra search phrases (a provider may suggest some) are scored too; a protocol keeps its BEST score over all of them', () => {
    const plain = top('my lower spine feels locked');
    assert.ok(!plain || plain.score < THRESHOLDS.STRONG);
    const boosted = rank(['my lower spine feels locked', 'lumbago'], CATALOGUE)[0];
    assert.equal(boosted.slug, 'back-pain');
    assert.ok(boosted.score >= THRESHOLDS.STRONG);
  });
  it('is insensitive to case, accents, punctuation and spacing', () => {
    const reference = top('lower back stiffness').score;
    ['LOWER BACK STIFFNESS', 'lower-back   stiffness!!', 'lówer bäck stiffness', '  Lower, back; stiffness  '].forEach((q) => assert.equal(top(q).score, reference, q));
  });
});

describe('[DETERMINISTIC] ambiguity, ordering and result hygiene', () => {
  const twoBack = [
    entry({ slug: 'neck-relief', name: 'Neck Tension Relief', displayName: 'Neck Tension Relief', conditions: [{ name: 'Neck tension', synonyms: [] }] }),
    entry({ slug: 'neck-desk', name: 'Neck Tension for Desk Workers', displayName: 'Neck Tension for Desk Workers', conditions: [{ name: 'Neck tension', synonyms: [] }] }),
  ];
  it('two equally good protocols are both strong and within the ambiguity margin', () => {
    const [a, b] = rank(['neck tension'], twoBack);
    assert.ok(a.score >= THRESHOLDS.STRONG && b.score >= THRESHOLDS.AMBIGUITY_FLOOR);
    assert.ok(a.score - b.score < THRESHOLDS.AMBIGUITY_MARGIN);
  });
  it('extra words that fit only one of them separate them', () => {
    const [a, b] = rank(['neck tension desk workers'], twoBack);
    assert.equal(a.slug, 'neck-desk');
    assert.ok(a.score - b.score >= THRESHOLDS.AMBIGUITY_MARGIN || b.score < THRESHOLDS.AMBIGUITY_FLOOR);
  });
  it('the order is deterministic: identical calls identical, ties broken by name then slug (never random)', () => {
    const a = rank(['neck tension'], twoBack); const b = rank(['neck tension'], twoBack); const c = rank(['neck tension'], [...twoBack].reverse());
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((r) => r.slug), c.map((r) => r.slug), 'input order does not matter');
    const ties = [entry({ slug: 'b', name: 'Same', displayName: 'Same', searchTerms: ['alpha beta'] }), entry({ slug: 'a', name: 'Same', displayName: 'Same', searchTerms: ['alpha beta'] })];
    assert.deepEqual(rank(['alpha beta'], ties).map((r) => r.slug), ['a', 'b']);
  });
  it('only protocols in the catalogue can ever come back, and the result has just { slug, score, field }', () => {
    const results = rank(['I want the Back Pain protocol'], CATALOGUE, 10);
    results.forEach((r) => { assert.ok(CATALOGUE.some((p) => p.slug === r.slug)); assert.deepEqual(Object.keys(r).sort(), ['field', 'score', 'slug']); });
    assert.deepEqual(rank(['Back Pain'], []), [], 'an empty catalogue yields nothing — a protocol is never invented');
  });
  it('respects the result limit; empty / stop-word-only queries return nothing', () => {
    assert.equal(rank(['pain back knee migraine'], CATALOGUE, 1).length, 1);
    assert.deepEqual(rank([], CATALOGUE), []);
    assert.deepEqual(rank(['', '   ', 'the and of'], CATALOGUE), []);
  });
  it('tolerates incomplete catalogue entries (missing optional fields) without throwing', () => {
    const sparse = [{ slug: 's', name: 'Sparse', conditions: [{ name: 'Thing' }], searchTerms: [null, 5, 'okay term'] }, { slug: 'n' }];
    assert.doesNotThrow(() => rank(['okay term'], sparse));
    assert.equal(rank(['okay term'], sparse)[0].slug, 's');
  });
  it('the thresholds are ordered sensibly (weak < ambiguity floor < strong)', () => {
    assert.ok(THRESHOLDS.WEAK < THRESHOLDS.AMBIGUITY_FLOOR && THRESHOLDS.AMBIGUITY_FLOOR < THRESHOLDS.STRONG);
    assert.ok(THRESHOLDS.AMBIGUITY_MARGIN > 0);
  });
});
