/** [DETERMINISTIC SOFTWARE TESTS] lifecycle rules, snapshot format and publish validation (pure — no database). */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { STATUSES, checkStatusChange, canPublishFrom, isPubliclyVisible } = require('../src/protocol/lifecycle');
const {
  SNAPSHOT_SCHEMA_VERSION, canonicalStringify, sha256Hex, buildSnapshot, contentFingerprint, normalizeSnapshot, verifyChecksum,
} = require('../src/protocol/snapshot');
const { validateForPublish, LIMITS } = require('../src/protocol/validation');

// ------------------------------------------------------------------ fixtures
const dot = (o = {}) => ({ id: 'o1', type: 'dot', x: 0.4, y: 0.5, width: 0.03, height: 0.03, rotation: 0, color: '#e5484d', thickness: 0, opacity: 1, points: null, finger: null, landmarkReference: null, metadata: {}, zIndex: 1, ...o });
const canvas = (viewKey, objects = [], extra = {}) => ({ id: `c-${viewKey}`, canvasType: 'hand', viewKey, backgroundAssetKey: viewKey, backgroundLabel: viewKey, isPlaceholderAsset: false, width: 1586, height: 1982, sortOrder: 0, objects, ...extra });
function working(overrides = {}) {
  return {
    protocol: { id: 'p1', slug: 'headache-relief', name: 'Headache Relief', display_name: 'Headache Relief', short_description: 'Short', description: 'Long', protocol_type: 'hand', metadata_json: '{"public":{"x":1},"internal":"secret"}', category_id: 'cat1' },
    category: { id: 'cat1', slug: 'head', name: 'Head', description: '', is_active: 1 },
    conditions: [{ id: 'cn1', slug: 'migraine', name: 'Migraine', description: '', is_active: 1 }],
    searchTerms: [{ term: 'Severe Headache', term_normalized: 'severe headache', kind: 'phrase' }, { term: 'migraine', term_normalized: 'migraine', kind: 'keyword' }],
    canvases: [canvas('left_front', [dot()]), canvas('right_front'), canvas('left_back'), canvas('right_back')],
    ...overrides,
  };
}
const snap = (w = working(), life = {}) => buildSnapshot(w, { status: 'draft', kind: 'checkpoint', versionNumber: 3, ...life });
const codes = (w, s = snap(w)) => validateForPublish(w, s).map((e) => e.code);

describe('[DETERMINISTIC] lifecycle rules', () => {
  it('the lifecycle has exactly draft, in_review, published, archived', () => {
    assert.deepEqual([...STATUSES], ['draft', 'in_review', 'published', 'archived']);
  });
  it('allows the normal workflow moves', () => {
    for (const [from, to] of [['draft', 'in_review'], ['in_review', 'draft'], ['draft', 'archived'], ['in_review', 'archived'], ['published', 'archived'], ['archived', 'draft']]) {
      assert.equal(checkStatusChange(from, to).ok, true, `${from} -> ${to}`);
    }
  });
  it("'published' can NEVER be reached by a plain status change — only the publish action does that", () => {
    for (const from of ['draft', 'in_review', 'archived', 'active', 'published']) {
      const r = checkStatusChange(from, 'published', { allowLegacy: true });
      assert.equal(r.ok, false); assert.equal(r.code, 'USE_PUBLISH');
    }
  });
  it('a published protocol cannot be pulled back to draft/review (that would silently unpublish); it can only be archived', () => {
    for (const to of ['draft', 'in_review']) {
      const r = checkStatusChange('published', to);
      assert.equal(r.ok, false); assert.equal(r.code, 'INVALID_TRANSITION');
    }
    assert.equal(checkStatusChange('published', 'archived').ok, true);
  });
  it('an archived protocol can only return to draft', () => {
    assert.equal(checkStatusChange('archived', 'in_review').ok, false);
    assert.equal(checkStatusChange('archived', 'draft').ok, true);
  });
  it("the legacy 'active' status works only when explicitly allowed (the old builder dropdown)", () => {
    assert.equal(checkStatusChange('draft', 'active').ok, false);
    assert.equal(checkStatusChange('draft', 'active', { allowLegacy: true }).ok, true);
    assert.equal(checkStatusChange('active', 'archived', { allowLegacy: true }).ok, true);
  });
  it('unknown statuses are rejected; publishing is allowed from everything except archived', () => {
    assert.equal(checkStatusChange('draft', 'banana').code, 'UNKNOWN_STATUS');
    for (const s of ['draft', 'in_review', 'active', 'published']) assert.equal(canPublishFrom(s), true, s);
    assert.equal(canPublishFrom('archived'), false);
  });
  it('a protocol is public only when it is published AND has a published version', () => {
    assert.equal(isPubliclyVisible({ status: 'published', published_version_id: 'v1' }), true);
    assert.equal(isPubliclyVisible({ status: 'published', published_version_id: null }), false);
    for (const status of ['draft', 'in_review', 'archived', 'active']) assert.equal(isPubliclyVisible({ status, published_version_id: 'v1' }), false, status);
    assert.equal(isPubliclyVisible(null), false);
  });
});

describe('[DETERMINISTIC] snapshot format', () => {
  it('a snapshot is complete: schema id, metadata, lifecycle, category, conditions, search terms, canvases, objects', () => {
    const s = snap(working(), { kind: 'published', status: 'published', versionNumber: 7 });
    assert.equal(s.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
    assert.equal(SNAPSHOT_SCHEMA_VERSION, 2);
    assert.deepEqual(Object.keys(s).sort(), ['canvases', 'lifecycle', 'protocol', 'schemaVersion']);
    assert.equal(s.protocol.name, 'Headache Relief');
    assert.equal(s.protocol.displayName, 'Headache Relief');
    assert.equal(s.protocol.shortDescription, 'Short');
    assert.equal(s.protocol.description, 'Long');
    assert.equal(s.protocol.slug, 'headache-relief');
    assert.deepEqual(s.protocol.category, { id: 'cat1', slug: 'head', name: 'Head', description: '' });
    assert.deepEqual(s.protocol.conditions.map((c) => c.slug), ['migraine']);
    assert.deepEqual(s.protocol.searchTerms, [{ term: 'migraine', kind: 'keyword' }, { term: 'Severe Headache', kind: 'phrase' }]);
    assert.deepEqual(s.protocol.metadata, { public: { x: 1 }, internal: 'secret' });
    assert.deepEqual({ status: s.lifecycle.status, kind: s.lifecycle.kind, versionNumber: s.lifecycle.versionNumber, restoredFromVersion: s.lifecycle.restoredFromVersion }, { status: 'published', kind: 'published', versionNumber: 7, restoredFromVersion: null });
    assert.equal(s.canvases.length, 4);
    assert.deepEqual(s.canvases[0].objects[0], dot(), 'every object property is carried, including AR-relevant ones');
    for (const k of ['finger', 'landmarkReference', 'metadata', 'points']) assert.ok(k in s.canvases[0].objects[0]);
  });
  it('carries no owner, doctor or patient information', () => {
    const text = canonicalStringify(snap());
    for (const forbidden of ['doctor', 'patient', 'owner', 'password', 'email']) assert.ok(!text.toLowerCase().includes(forbidden), forbidden);
  });
  it('stored text is deterministic (sorted keys): same content -> same bytes -> same checksum', () => {
    const a = canonicalStringify(snap(working(), { }));
    const shuffled = JSON.parse(a);
    const reordered = Object.fromEntries(Object.entries(shuffled).reverse());
    assert.equal(canonicalStringify(reordered), a);
    assert.equal(canonicalStringify({ b: 1, a: [{ z: 1, y: 2 }] }), '{"a":[{"y":2,"z":1}],"b":1}');
    assert.equal(sha256Hex(a), sha256Hex(canonicalStringify(reordered)));
  });
  it('refuses to serialize values JSON would silently corrupt or lose', () => {
    assert.throws(() => canonicalStringify({ a: NaN }), /non-finite/);
    assert.throws(() => canonicalStringify({ a: Infinity }), /non-finite/);
    assert.throws(() => canonicalStringify({ a: 10n }), /bigint/);
    assert.throws(() => canonicalStringify({ a: () => 1 }), /function/);
  });
  it('checksum verification detects any change to the stored text', () => {
    const text = canonicalStringify(snap());
    const sum = sha256Hex(text);
    assert.equal(verifyChecksum(text, sum), true);
    assert.equal(verifyChecksum(text.replace('0.4', '0.41'), sum), false);
    assert.equal(verifyChecksum(text, null), false, 'no checksum means not verified');
  });
  it('the content fingerprint ignores ids, slug and lifecycle but changes with any real content change', () => {
    const base = contentFingerprint(snap());
    const other = working();
    other.protocol.id = 'different-id'; other.protocol.slug = 'different-slug';
    other.canvases = other.canvases.map((c) => ({ ...c, id: `other-${c.id}` }));
    assert.equal(contentFingerprint(snap(other, { status: 'published', kind: 'published', versionNumber: 99 })), base);

    const edits = {
      'an object moved': (w) => { w.canvases[0].objects[0].x = 0.41; },
      'an object added': (w) => { w.canvases[1].objects.push(dot({ id: 'o2' })); },
      'description edited': (w) => { w.protocol.description = 'Longer'; },
      'a search term added': (w) => { w.searchTerms.push({ term: 'x', term_normalized: 'x', kind: 'keyword' }); },
      'a condition detached': (w) => { w.conditions = []; },
      'category cleared': (w) => { w.category = null; },
    };
    for (const [label, edit] of Object.entries(edits)) {
      const w = working(); edit(w);
      assert.notEqual(contentFingerprint(snap(w)), base, label);
    }
  });
  it('old (schema 1) snapshots stay readable through normalizeSnapshot without being altered', () => {
    const legacy = { protocol: { id: 'p', name: 'Calm', description: 'd', protocolType: 'hand', extra: 1 }, canvases: [{ viewKey: 'left_front', objects: [] }] };
    const before = JSON.stringify(legacy);
    const n = normalizeSnapshot(legacy);
    assert.equal(n.schemaVersion, 1);
    assert.deepEqual(n.protocol, { id: 'p', name: 'Calm', description: 'd', protocolType: 'hand' });
    assert.equal(n.canvases.length, 1);
    assert.equal(JSON.stringify(legacy), before);
    assert.equal(normalizeSnapshot(snap()).schemaVersion, 2);
  });
});

describe('[DETERMINISTIC] publish validation', () => {
  it('a complete, correct protocol has no errors', () => {
    assert.deepEqual(validateForPublish(working(), snap()), []);
  });

  it('metadata: name, slug and length limits', () => {
    let w = working(); w.protocol.name = '   ';
    assert.ok(codes(w).includes('NAME_REQUIRED'));
    w = working(); w.protocol.name = 'x'.repeat(LIMITS.NAME + 1);
    assert.ok(codes(w).includes('NAME_TOO_LONG'));
    w = working(); w.protocol.slug = 'Not A Slug';
    assert.ok(codes(w).includes('SLUG_INVALID'));
    w = working(); w.protocol.short_description = 'x'.repeat(LIMITS.SHORT_DESCRIPTION + 1);
    assert.ok(codes(w).includes('SHORT_DESCRIPTION_TOO_LONG'));
    w = working(); w.protocol.description = 'x'.repeat(LIMITS.DESCRIPTION + 1);
    assert.ok(codes(w).includes('DESCRIPTION_TOO_LONG'));
    w = working(); w.protocol.display_name = 'x'.repeat(LIMITS.DISPLAY_NAME + 1);
    assert.ok(codes(w).includes('DISPLAY_NAME_TOO_LONG'));
  });

  it('views: at least one, known, unique, real (non-placeholder) background, valid size', () => {
    let w = working({ canvases: [] });
    assert.ok(codes(w).includes('NO_CANVAS'));
    w = working(); w.canvases[1] = canvas('left_front', [dot({ id: 'o9' })]);
    assert.ok(codes(w).includes('VIEW_DUPLICATE'));
    w = working(); w.canvases[1] = canvas('third_hand');
    assert.ok(codes(w).includes('VIEW_UNKNOWN'));
    w = working(); w.canvases[1] = canvas('right_front', [], { isPlaceholderAsset: true });
    assert.ok(codes(w).includes('PLACEHOLDER_ASSET'));
    w = working(); w.canvases[1] = canvas('right_front', [], { width: 0 });
    assert.ok(codes(w).includes('CANVAS_SIZE_INVALID'));
  });

  it('there must be something to publish: at least one object', () => {
    const w = working({ canvases: [canvas('left_front'), canvas('right_front')] });
    assert.ok(codes(w).includes('NO_OBJECTS'));
  });

  it('objects: unknown type, missing/duplicate id', () => {
    let w = working(); w.canvases[0].objects = [dot({ type: 'hologram' })];
    assert.ok(codes(w).includes('OBJECT_TYPE_UNKNOWN'));
    w = working(); w.canvases[0].objects = [dot({ id: '' })];
    assert.ok(codes(w).includes('OBJECT_ID_MISSING'));
    w = working(); w.canvases[0].objects = [dot({ id: 'same' }), dot({ id: 'same', x: 0.6 })];
    assert.ok(codes(w).includes('OBJECT_ID_DUPLICATE'));
  });

  it('objects: normalized coordinates must be numbers within 0..1', () => {
    for (const [field, value] of [['x', -0.01], ['x', 1.01], ['y', 5], ['x', NaN], ['y', null], ['x', '0.5']]) {
      const w = working(); w.canvases[0].objects = [dot({ [field]: value })];
      const errs = validateForPublish(w, snap(w));
      assert.ok(errs.some((e) => e.code === 'COORDINATE_INVALID' && e.path.endsWith(`.${field}`)), `${field}=${value}`);
    }
    const edge = working(); edge.canvases[0].objects = [dot({ x: 0, y: 1 })];
    assert.deepEqual(codes(edge), [], '0 and 1 are valid');
  });

  it('objects: required size fields per type, colour, thickness, opacity, rotation', () => {
    const cases = [
      [dot({ width: null }), 'SIZE_INVALID'], [dot({ width: 0 }), 'SIZE_INVALID'], [dot({ width: 1.5 }), 'SIZE_INVALID'],
      [dot({ type: 'rectangle', width: 0.1, height: null }), 'SIZE_INVALID'],
      [dot({ color: 'red' }), 'COLOR_INVALID'], [dot({ color: 'url(javascript:alert(1))' }), 'COLOR_INVALID'], [dot({ color: null }), 'COLOR_INVALID'],
      // thickness must be a finite number >= 0. There is NO upper limit (a stroke thick enough to cover a hand is
      // legitimate), so what is rejected is only what is not a usable number: negative, non-numeric, null, NaN, Infinity.
      [dot({ thickness: -1 }), 'THICKNESS_INVALID'], [dot({ thickness: '5' }), 'THICKNESS_INVALID'], [dot({ thickness: null }), 'THICKNESS_INVALID'],
      [dot({ thickness: NaN }), 'THICKNESS_INVALID'], [dot({ thickness: Infinity }), 'THICKNESS_INVALID'],
      [dot({ opacity: 1.2 }), 'OPACITY_INVALID'], [dot({ opacity: -0.1 }), 'OPACITY_INVALID'],
      [dot({ rotation: 'x' }), 'ROTATION_INVALID'], [dot({ zIndex: NaN }), 'ZINDEX_INVALID'],
    ];
    for (const [obj, code] of cases) {
      const w = working(); w.canvases[0].objects = [obj];
      assert.ok(codes(w).includes(code), `${JSON.stringify(obj)} should report ${code}`);
    }
    for (const thickness of [0, 0.5, 4, 1000, 1001, 5000, 250000, 1e9]) {
      const w = working(); w.canvases[0].objects = [dot({ thickness })];
      assert.deepEqual(codes(w), [], `thickness ${thickness} is a legitimate value — there is no artificial maximum`);
    }
    for (const color of ['#fff', '#e5484d', '#e5484dff']) {
      const w = working(); w.canvases[0].objects = [dot({ color })];
      assert.deepEqual(codes(w), [], color);
    }
  });

  it('free lines need at least 2 in-range points', () => {
    const line = (points) => dot({ type: 'freeline', width: null, height: null, points });
    for (const points of [null, [{ x: 0.1, y: 0.1 }], [{ x: 0.1, y: 0.1 }, { x: 2, y: 0.1 }], [{ x: 0.1, y: 0.1 }, 'nope']]) {
      const w = working(); w.canvases[0].objects = [line(points)];
      assert.ok(codes(w).includes('POINTS_INVALID'), JSON.stringify(points));
    }
    const ok = working(); ok.canvases[0].objects = [line([{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.4 }])];
    assert.deepEqual(codes(ok), []);
  });

  it('finger, landmarkReference and object metadata are checked (legacy "pinky" is still accepted)', () => {
    let w = working(); w.canvases[0].objects = [dot({ finger: 'toe' })];
    assert.ok(codes(w).includes('FINGER_INVALID'));
    for (const finger of ['thumb', 'little', 'pinky', null]) { w = working(); w.canvases[0].objects = [dot({ finger })]; assert.deepEqual(codes(w), [], String(finger)); }
    w = working(); w.canvases[0].objects = [dot({ landmarkReference: [1, 2] })];
    assert.ok(codes(w).includes('LANDMARK_INVALID'));
    w = working(); w.canvases[0].objects = [dot({ metadata: 'text' })];
    assert.ok(codes(w).includes('METADATA_INVALID'));
  });

  it('references: an inactive category or condition blocks publishing; a vanished category is reported', () => {
    let w = working(); w.category.is_active = 0;
    assert.ok(codes(w).includes('CATEGORY_INACTIVE'));
    w = working(); w.category = null; // category_id still set but the row is gone
    assert.ok(codes(w).includes('CATEGORY_MISSING'));
    w = working(); w.conditions[0].is_active = 0;
    assert.ok(codes(w).includes('CONDITION_INACTIVE'));
    w = working(); w.protocol.category_id = null; w.category = null;
    assert.deepEqual(codes(w), [], 'a protocol without a category is fine');
  });

  it('the snapshot must be serializable and not absurdly large', () => {
    let w = working(); w.canvases[0].objects = [dot({ metadata: { n: 10n } })];
    assert.ok(codes(w).includes('SNAPSHOT_NOT_SERIALIZABLE'));
    w = working(); w.protocol.metadata_json = JSON.stringify({ big: 'x'.repeat(LIMITS.SNAPSHOT_BYTES) });
    assert.ok(codes(w).includes('SNAPSHOT_TOO_LARGE'));
  });

  it('reports EVERY problem at once, each with a code, a path and a readable message', () => {
    const w = working();
    w.protocol.name = '';
    w.canvases[0].objects = [dot({ type: 'hologram' }), dot({ id: 'b', x: 7, color: 'red' })];
    const errs = validateForPublish(w, snap(w));
    assert.ok(errs.length >= 4);
    for (const e of errs) {
      assert.equal(typeof e.code, 'string'); assert.equal(typeof e.path, 'string'); assert.ok(e.message.length > 10);
    }
    assert.ok(errs.some((e) => e.path.startsWith('canvases[0].objects[1]')), 'points at the offending object');
  });
});
