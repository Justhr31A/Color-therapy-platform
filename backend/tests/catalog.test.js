/** [DETERMINISTIC SOFTWARE TESTS] categories, conditions, condition<->protocol links and search terms (service level, real database). */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { missingReason } = require('./helpers/testDb');

const SKIP = missingReason('pg', 'uuid');
const env = () => require('./helpers/publishingEnv').makeEnv(); // eslint-disable-line global-require
const fails = (fn, { status, code }) => assert.rejects(fn, (e) => e.status === status && (code === undefined || e.code === code), `expected HTTP ${status} ${code || ''}`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('[DETERMINISTIC] category CRUD', { skip: SKIP }, () => {
  it('creates a category with a stable UUID, a slug derived from the name, and active by default', async () => {
    const e = await env();
    try {
      const c = (await e.catalog.createCategory({ name: 'Head & Neck', description: 'Everything above the shoulders' }));
      assert.match(c.id, UUID_RE);
      assert.equal(c.slug, 'head-and-neck');
      assert.equal(c.isActive, true);
      assert.equal(c.description, 'Everything above the shoulders');
      assert.ok(c.createdAt && c.updatedAt);
      assert.deepEqual((await e.catalog.getCategory(c.id)), c);
    } finally { await e.cleanup(); }
  });

  it('two categories with the same name get different slugs automatically; an EXPLICIT duplicate slug is refused (409), never silently changed', async () => {
    const e = await env();
    try {
      const a = (await e.catalog.createCategory({ name: 'Sleep' }));
      const b = (await e.catalog.createCategory({ name: 'Sleep' }));
      assert.deepEqual([a.slug, b.slug], ['sleep', 'sleep-2']);
      await fails(async () => (await e.catalog.createCategory({ name: 'Other', slug: 'sleep' })), { status: 409, code: 'SLUG_TAKEN' });
      await fails(async () => (await e.catalog.createCategory({ name: 'Other', slug: 'Bad Slug' })), { status: 400, code: 'INVALID_SLUG' });
      assert.equal((await e.catalog.listCategories()).length, 2, 'the refused requests created nothing');
    } finally { await e.cleanup(); }
  });

  it('validates input: name required and bounded, description bounded, sortOrder a whole number', async () => {
    const e = await env();
    try {
      for (const bad of [{}, { name: '   ' }, { name: 5 }, { name: 'x'.repeat(121) }, { name: 'ok', description: 'x'.repeat(5001) }, { name: 'ok', sortOrder: 1.5 }]) {
        await fails(async () => (await e.catalog.createCategory(bad)), { status: 400, code: 'INVALID_INPUT' });
      }
    } finally { await e.cleanup(); }
  });

  it('update: renaming does NOT change the slug; an explicit slug does; a taken slug is 409; the id never changes', async () => {
    const e = await env();
    try {
      const a = (await e.catalog.createCategory({ name: 'Sleep' }));
      const b = (await e.catalog.createCategory({ name: 'Stress' }));
      const renamed = (await e.catalog.updateCategory(a.id, { name: 'Sleep & Rest', description: 'd', sortOrder: 4 }));
      assert.equal(renamed.slug, 'sleep', 'slug is stable across renames');
      assert.equal(renamed.name, 'Sleep & Rest'); assert.equal(renamed.sortOrder, 4); assert.equal(renamed.id, a.id);
      assert.equal((await e.catalog.updateCategory(a.id, { slug: 'rest' })).slug, 'rest');
      await fails(async () => (await e.catalog.updateCategory(a.id, { slug: 'stress' })), { status: 409, code: 'SLUG_TAKEN' });
      assert.equal((await e.catalog.getCategory(a.id)).slug, 'rest', 'a refused change leaves the slug alone');
      assert.equal((await e.catalog.updateCategory(b.id, { slug: 'stress' })).slug, 'stress', 'setting a slug to its current value is fine');
    } finally { await e.cleanup(); }
  });

  it('activate / deactivate, list (including inactive, with usage counts), and 404 for an unknown id', async () => {
    const e = await env();
    try {
      const c = (await e.catalog.createCategory({ name: 'Sleep' }));
      assert.equal((await e.catalog.setCategoryActive(c.id, false)).isActive, false);
      assert.equal((await e.catalog.listCategories()).find((x) => x.id === c.id).isActive, false, 'admins still see inactive categories');
      assert.equal((await e.catalog.setCategoryActive(c.id, true)).isActive, true);
      const id = (await e.protocols.create({ name: 'P', categoryId: c.id }, e.actor));
      (await e.catalog.createCondition({ name: 'Insomnia', categoryId: c.id }));
      const listed = (await e.catalog.listCategories())[0];
      assert.deepEqual([listed.protocolCount, listed.conditionCount], [1, 1]);
      assert.ok(id);
      await fails(async () => (await e.catalog.getCategory('nope')), { status: 404 });
      await fails(async () => (await e.catalog.updateCategory('nope', { name: 'x' })), { status: 404 });
      await fails(async () => (await e.catalog.setCategoryActive('nope', true)), { status: 404 });
    } finally { await e.cleanup(); }
  });

  it('an inactive category cannot be newly assigned to a protocol (409)', async () => {
    const e = await env();
    try {
      const c = (await e.catalog.createCategory({ name: 'Old', isActive: false }));
      await fails(async () => (await e.protocols.create({ name: 'P', categoryId: c.id }, e.actor)), { status: 409, code: 'CATEGORY_INACTIVE' });
      await fails(async () => (await e.protocols.create({ name: 'P', categoryId: 'no-such-category' }, e.actor)), { status: 400, code: 'CATEGORY_NOT_FOUND' });
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] condition CRUD', { skip: SKIP }, () => {
  it('creates a condition (UUID, derived slug, optional category) and lists it', async () => {
    const e = await env();
    try {
      const cat = (await e.catalog.createCategory({ name: 'Head' }));
      const c = (await e.catalog.createCondition({ name: 'Migraine', description: 'Recurring headache', categoryId: cat.id }));
      assert.match(c.id, UUID_RE);
      assert.equal(c.slug, 'migraine'); assert.equal(c.categoryId, cat.id); assert.equal(c.isActive, true);
      const plain = (await e.catalog.createCondition({ name: 'Fatigue' }));
      assert.equal(plain.categoryId, null);
      assert.deepEqual((await e.catalog.listConditions()).map((x) => x.slug), ['fatigue', 'migraine']);
      assert.deepEqual((await e.catalog.listConditions({ categoryId: cat.id })).map((x) => x.slug), ['migraine']);
    } finally { await e.cleanup(); }
  });

  it('slug rules match categories: auto-suffix on same name, explicit duplicates refused, rename keeps the slug', async () => {
    const e = await env();
    try {
      const a = (await e.catalog.createCondition({ name: 'Migraine' }));
      const b = (await e.catalog.createCondition({ name: 'Migraine' }));
      assert.deepEqual([a.slug, b.slug], ['migraine', 'migraine-2']);
      await fails(async () => (await e.catalog.createCondition({ name: 'X', slug: 'migraine' })), { status: 409, code: 'SLUG_TAKEN' });
      assert.equal((await e.catalog.updateCondition(a.id, { name: 'Chronic Migraine' })).slug, 'migraine');
      await fails(async () => (await e.catalog.updateCondition(a.id, { slug: 'migraine-2' })), { status: 409, code: 'SLUG_TAKEN' });
    } finally { await e.cleanup(); }
  });

  it('validates the category reference, supports moving/clearing it, and activate/deactivate', async () => {
    const e = await env();
    try {
      await fails(async () => (await e.catalog.createCondition({ name: 'X', categoryId: 'ghost' })), { status: 400, code: 'CATEGORY_NOT_FOUND' });
      await fails(async () => (await e.catalog.createCondition({ name: '' })), { status: 400, code: 'INVALID_INPUT' });
      const cat = (await e.catalog.createCategory({ name: 'Head' }));
      const c = (await e.catalog.createCondition({ name: 'Migraine' }));
      assert.equal((await e.catalog.updateCondition(c.id, { categoryId: cat.id })).categoryId, cat.id);
      assert.equal((await e.catalog.updateCondition(c.id, { categoryId: null })).categoryId, null);
      await fails(async () => (await e.catalog.updateCondition(c.id, { categoryId: 'ghost' })), { status: 400, code: 'CATEGORY_NOT_FOUND' });
      assert.equal((await e.catalog.setConditionActive(c.id, false)).isActive, false);
      assert.equal((await e.catalog.setConditionActive(c.id, true)).isActive, true);
      await fails(async () => (await e.catalog.getCondition('nope')), { status: 404 });
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] condition <-> protocol relationship', { skip: SKIP }, () => {
  it('a protocol can have several conditions and a condition several protocols', async () => {
    const e = await env();
    try {
      const m = (await e.catalog.createCondition({ name: 'Migraine' }));
      const t = (await e.catalog.createCondition({ name: 'Tension Headache' }));
      const p1 = (await e.protocols.create({ name: 'P1' }, e.actor));
      const p2 = (await e.protocols.create({ name: 'P2' }, e.actor));
      (await e.protocols.attachCondition(m.id, p1, e.actor)); (await e.protocols.attachCondition(t.id, p1, e.actor)); (await e.protocols.attachCondition(m.id, p2, e.actor));
      assert.deepEqual((await e.protocols.getFull(p1)).conditions.map((c) => c.slug), ['migraine', 'tension-headache']);
      assert.deepEqual((await e.catalog.listProtocolsForCondition(m.id)).map((p) => p.id).sort(), [p1, p2].sort());
      assert.deepEqual((await e.catalog.listProtocolsForCondition(t.id)).map((p) => p.id), [p1]);
      assert.equal((await e.catalog.listConditions()).find((c) => c.id === m.id).protocolCount, 2);
    } finally { await e.cleanup(); }
  });

  it('attaching twice is refused (409) and leaves exactly one link; detaching removes only that link', async () => {
    const e = await env();
    try {
      const m = (await e.catalog.createCondition({ name: 'Migraine' }));
      const p = (await e.protocols.create({ name: 'P' }, e.actor));
      (await e.protocols.attachCondition(m.id, p, e.actor));
      await fails(async () => (await e.protocols.attachCondition(m.id, p, e.actor)), { status: 409, code: 'ALREADY_ATTACHED' });
      assert.equal((await e.row('SELECT COUNT(*) c FROM condition_protocols')).c, 1);
      (await e.protocols.detachCondition(m.id, p, e.actor));
      assert.equal((await e.row('SELECT COUNT(*) c FROM condition_protocols')).c, 0);
      await fails(async () => (await e.protocols.detachCondition(m.id, p, e.actor)), { status: 404 });
    } finally { await e.cleanup(); }
  });

  it('refuses unknown or inactive conditions and unknown protocols, changing nothing', async () => {
    const e = await env();
    try {
      const m = (await e.catalog.createCondition({ name: 'Migraine' }));
      const p = (await e.protocols.create({ name: 'P' }, e.actor));
      await fails(async () => (await e.protocols.attachCondition('ghost', p, e.actor)), { status: 404 });
      await fails(async () => (await e.protocols.attachCondition(m.id, 'ghost', e.actor)), { status: 404 });
      (await e.catalog.setConditionActive(m.id, false));
      await fails(async () => (await e.protocols.attachCondition(m.id, p, e.actor)), { status: 409, code: 'CONDITION_INACTIVE' });
      assert.equal((await e.row('SELECT COUNT(*) c FROM condition_protocols')).c, 0);
    } finally { await e.cleanup(); }
  });

  it('conditions can be given when a protocol is created, and are validated', async () => {
    const e = await env();
    try {
      const m = (await e.catalog.createCondition({ name: 'Migraine' }));
      const id = (await e.protocols.create({ name: 'P', conditionIds: [m.id, m.id] }, e.actor)); // a repeated id is collapsed
      assert.equal((await e.protocols.getFull(id)).conditions.length, 1);
      await fails(async () => (await e.protocols.create({ name: 'Q', conditionIds: ['ghost'] }, e.actor)), { status: 400, code: 'CONDITION_NOT_FOUND' });
      assert.equal((await e.row("SELECT COUNT(*) c FROM protocols WHERE name = 'Q'")).c, 0, 'the failed create left no half-made protocol behind');
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] protocol search terms', { skip: SKIP }, () => {
  it('a protocol can have many terms/synonyms/phrases, listed alphabetically', async () => {
    const e = await env();
    try {
      const p = (await e.protocols.create({ name: 'Headache Relief' }, e.actor));
      for (const term of ['migraine', 'headache', 'severe headache', 'one-sided headache']) (await e.protocols.addTerm(p, { term }, e.actor));
      (await e.protocols.addTerm(p, { term: 'head pain', kind: 'synonym' }, e.actor));
      (await e.protocols.addTerm(p, { term: 'my head hurts on one side', kind: 'phrase' }, e.actor));
      const terms = (await e.protocols.listTerms(p));
      assert.deepEqual(terms.map((t) => t.term), ['head pain', 'headache', 'migraine', 'my head hurts on one side', 'one-sided headache', 'severe headache']);
      assert.deepEqual(terms.map((t) => t.kind).sort(), ['keyword', 'keyword', 'keyword', 'keyword', 'phrase', 'synonym']);
      assert.ok(terms.every((t) => typeof t.id === 'string' && t.createdAt));
    } finally { await e.cleanup(); }
  });

  it('is unique per protocol, ignoring case and extra spaces; the same term may exist on another protocol', async () => {
    const e = await env();
    try {
      const a = (await e.protocols.create({ name: 'A' }, e.actor));
      const b = (await e.protocols.create({ name: 'B' }, e.actor));
      (await e.protocols.addTerm(a, { term: 'Severe Headache' }, e.actor));
      for (const dup of ['severe headache', '  SEVERE   HEADACHE ', 'Severe Headache']) await fails(async () => (await e.protocols.addTerm(a, { term: dup }, e.actor)), { status: 409, code: 'TERM_EXISTS' });
      assert.equal((await e.protocols.listTerms(a)).length, 1);
      (await e.protocols.addTerm(b, { term: 'severe headache' }, e.actor));
      assert.equal((await e.protocols.listTerms(b)).length, 1);
    } finally { await e.cleanup(); }
  });

  it('validates terms: required, bounded, known kind', async () => {
    const e = await env();
    try {
      const p = (await e.protocols.create({ name: 'P' }, e.actor));
      for (const bad of [{}, { term: '   ' }, { term: 42 }, { term: 'x'.repeat(121) }, { term: 'ok', kind: 'nonsense' }, null]) {
        await fails(async () => (await e.protocols.addTerm(p, bad, e.actor)), { status: 400, code: 'INVALID_INPUT' });
      }
      assert.equal((await e.protocols.listTerms(p)).length, 0);
    } finally { await e.cleanup(); }
  });

  it('removes a term by id; an unknown id (or another protocol\'s term) is 404', async () => {
    const e = await env();
    try {
      const a = (await e.protocols.create({ name: 'A' }, e.actor));
      const b = (await e.protocols.create({ name: 'B' }, e.actor));
      const t = (await e.protocols.addTerm(a, { term: 'migraine' }, e.actor));
      await fails(async () => (await e.protocols.removeTerm(b, t.id, e.actor)), { status: 404 });
      assert.equal((await e.protocols.listTerms(a)).length, 1, "another protocol's request cannot remove it");
      (await e.protocols.removeTerm(a, t.id, e.actor));
      assert.equal((await e.protocols.listTerms(a)).length, 0);
      await fails(async () => (await e.protocols.removeTerm(a, t.id, e.actor)), { status: 404 });
    } finally { await e.cleanup(); }
  });

  it('terms are stored independently of the protocol title: renaming the protocol leaves them untouched', async () => {
    const e = await env();
    try {
      const p = (await e.protocols.create({ name: 'Headache Relief', searchTerms: ['migraine', { term: 'head pain', kind: 'synonym' }] }, e.actor));
      (await e.protocols.updateMetadata(p, { name: 'Completely Different Title', displayName: 'Another Name' }, e.actor));
      assert.deepEqual((await e.protocols.listTerms(p)).map((t) => t.term), ['head pain', 'migraine']);
    } finally { await e.cleanup(); }
  });

  it('terms are searchable: they find the protocol even though the title never mentions them (and only once it is published)', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable('Chromatic Balance', { searchTerms: ['migraine', 'severe headache', 'one-sided headache'] }));
      assert.equal((await e.publicSvc.list({ q: 'migraine' })).total, 0, 'drafts are not searchable by the public');
      (await e.protocols.publish(id, e.actor));
      for (const q of ['migraine', 'Severe Headache', 'one-sided headache', 'headache']) assert.deepEqual((await e.publicSvc.list({ q })).items.map((i) => i.slug), ['chromatic-balance'], q);
      assert.equal((await e.publicSvc.list({ q: 'toothache' })).total, 0);
    } finally { await e.cleanup(); }
  });

  it('terms can be supplied at creation (strings or {term,kind}), with duplicates collapsed', async () => {
    const e = await env();
    try {
      const p = (await e.protocols.create({ name: 'P', searchTerms: ['Migraine', 'migraine', { term: 'head pain', kind: 'synonym' }] }, e.actor));
      assert.deepEqual((await e.protocols.listTerms(p)).map((t) => [t.term, t.kind]), [['head pain', 'synonym'], ['Migraine', 'keyword']]);
    } finally { await e.cleanup(); }
  });
});
