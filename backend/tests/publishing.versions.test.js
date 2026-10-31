/** [DETERMINISTIC SOFTWARE TESTS] version history, restore, duplicate, delete guard and public visibility (service level, real database). */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { missingReason } = require('./helpers/testDb');

const SKIP = missingReason('pg', 'uuid');
const env = () => require('./helpers/publishingEnv').makeEnv(); // eslint-disable-line global-require
const fails = (fn, { status, code }) => assert.rejects(fn, (e) => e.status === status && (code === undefined || e.code === code), `expected HTTP ${status} ${code || ''}`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allObjects = (full) => full.canvases.flatMap((c) => c.objects);

describe('[DETERMINISTIC] version history', { skip: SKIP }, () => {
  it('lists every checkpoint newest-first with kind, schema version and who made it; a version can be fetched in full with an integrity check', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable());          // v1 create, v2 save
      (await e.protocols.publish(id, e.actor, { note: 'go live' })); // v3 published
      (await e.setObjects(id, 0, [e.dot({ x: 0.2 })])); // v4
      const list = (await e.protocols.listVersions(id));
      assert.deepEqual(list.map((v) => [v.version, v.kind]), [[4, 'checkpoint'], [3, 'published'], [2, 'checkpoint'], [1, 'checkpoint']]);
      assert.ok(list.every((v) => v.schemaVersion === 2 && v.createdBy === 'admin-1' && /^[0-9a-f]{64}$/.test(v.checksum)));
      assert.deepEqual(list.filter((v) => v.isCurrentlyPublished).map((v) => v.version), [3]);
      assert.equal(list[1].note, 'go live');

      const full = (await e.protocols.getVersion(id, 3));
      assert.equal(full.integrity.valid, true);
      assert.equal(full.snapshot.canvases[0].objects.length, 1);
      assert.equal(full.snapshot.canvases[0].objects[0].x, 0.45, 'v3 holds the position from before the later edit');
      assert.equal((await e.protocols.getVersion(id, 4)).snapshot.canvases[0].objects[0].x, 0.2);
      await fails(async () => (await e.protocols.getVersion(id, 99)), { status: 404 });
      await fails(async () => (await e.protocols.listVersions('ghost')), { status: 404 });
    } finally { await e.cleanup(); }
  });

  it('every content change records a checkpoint (save, metadata, search term, condition link); status changes do not', async () => {
    const e = await env();
    try {
      const cond = (await e.catalog.createCondition({ name: 'Migraine' }));
      const id = (await e.protocols.create({ name: 'P' }, e.actor));
      const count = async () => (await e.protocols.listVersions(id)).length;
      assert.equal(await count(), 1);
      (await e.protocols.updateMetadata(id, { shortDescription: 'x' }, e.actor)); assert.equal(await count(), 2);
      const t = (await e.protocols.addTerm(id, { term: 'migraine' }, e.actor)); assert.equal(await count(), 3);
      (await e.protocols.removeTerm(id, t.id, e.actor)); assert.equal(await count(), 4);
      (await e.protocols.attachCondition(cond.id, id, e.actor)); assert.equal(await count(), 5);
      (await e.protocols.detachCondition(cond.id, id, e.actor)); assert.equal(await count(), 6);
      (await e.setObjects(id, 0, [e.dot()])); assert.equal(await count(), 7);
      (await e.protocols.changeStatus(id, 'in_review')); (await e.protocols.changeStatus(id, 'draft'));
      assert.equal(await count(), 7, 'workflow moves are not content');
      assert.deepEqual((await e.protocols.listVersions(id)).map((v) => v.version), [7, 6, 5, 4, 3, 2, 1], 'numbers are consecutive with no gaps');
    } finally { await e.cleanup(); }
  });

  it('old (pre-existing, schema 1) snapshots remain readable and are labelled as such', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'P' }, e.actor));
      // simulate a snapshot written by the previous version of the app
      await e.run("INSERT INTO protocol_versions (id,protocol_id,version,snapshot_json,checksum) VALUES ('old1',$1,0,$2,$3)",
        id, '{"protocol":{"id":"x","name":"Old","description":"d","protocolType":"hand"},"canvases":[{"viewKey":"left_front","objects":[]}]}', 'not-computed');
      const v = (await e.protocols.getVersion(id, 0));
      assert.equal(v.schemaVersion, 1);
      assert.equal(v.snapshot.schemaVersion, 1);
      assert.equal(v.snapshot.protocol.name, 'Old');
      assert.equal(v.integrity.valid, false, 'a wrong checksum is reported, not hidden');
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] restoring a previous version into the draft', { skip: SKIP }, () => {
  async function scenario(e) {
    const cat = (await e.catalog.createCategory({ name: 'Head' }));
    const cond = (await e.catalog.createCondition({ name: 'Migraine' }));
    const id = (await e.makePublishable('Original Name', { displayName: 'Original Display', shortDescription: 'original short', categoryId: cat.id, conditionIds: [cond.id], searchTerms: ['original term'] }));
    (await e.setObjects(id, 0, [e.dot({ id: 'keep-1', x: 0.11 }), e.dot({ id: 'keep-2', x: 0.22 })]));
    const target = (await e.protocols.getFull(id)).currentVersion; // the state we will want back
    // change everything afterwards
    (await e.protocols.updateMetadata(id, { name: 'Changed Name', displayName: 'Changed', shortDescription: 'changed short' }, e.actor));
    (await e.protocols.removeTerm(id, (await e.protocols.listTerms(id))[0].id, e.actor));
    (await e.protocols.addTerm(id, { term: 'changed term' }, e.actor));
    (await e.protocols.detachCondition(cond.id, id, e.actor));
    (await e.setObjects(id, 0, [e.dot({ id: 'new-1', x: 0.9 })]));
    (await e.setObjects(id, 3, [e.dot({ id: 'new-2' })]));
    return { id, target, cat, cond };
  }

  it('the working copy becomes the old snapshot: objects, metadata, category, conditions and search terms', async () => {
    const e = await env();
    try {
      const { id, target, cond } = await scenario(e);
      const result = (await e.protocols.restoreVersion(id, target, e.actor));
      assert.equal(result.restoredFromVersion, target);
      assert.deepEqual(result.warnings, []);
      const p = (await e.protocols.getFull(id));
      assert.deepEqual([p.name, p.displayName, p.shortDescription], ['Original Name', 'Original Display', 'original short']);
      assert.deepEqual(p.canvases[0].objects.map((o) => [o.id, o.x]), [['keep-1', 0.11], ['keep-2', 0.22]]);
      assert.equal(p.canvases[3].objects.length, 0, 'a view that was empty in that version is empty again');
      assert.deepEqual(p.searchTerms.map((t) => t.term), ['original term']);
      assert.deepEqual(p.conditions.map((c) => c.id), [cond.id]);
      assert.equal(p.category.slug, 'head');
    } finally { await e.cleanup(); }
  });

  it('the historical version is NOT modified or deleted — its whole row is byte-identical afterwards', async () => {
    const e = await env();
    try {
      const { id, target } = await scenario(e);
      const before = (await e.rows('SELECT * FROM protocol_versions WHERE protocol_id = $1 ORDER BY version', id));
      (await e.protocols.restoreVersion(id, target, e.actor));
      const after = (await e.rows('SELECT * FROM protocol_versions WHERE protocol_id = $1 AND version <= $2 ORDER BY version', id, before[before.length - 1].version));
      assert.deepEqual(after, before, 'every earlier version row is unchanged');
      assert.equal((await e.protocols.getVersion(id, target)).integrity.valid, true);
    } finally { await e.cleanup(); }
  });

  it('restoring records a NEW checkpoint (with provenance) instead of rewriting history', async () => {
    const e = await env();
    try {
      const { id, target } = await scenario(e);
      const countBefore = (await e.protocols.listVersions(id)).length;
      const { newVersion } = (await e.protocols.restoreVersion(id, target, e.actor));
      const list = (await e.protocols.listVersions(id));
      assert.equal(list.length, countBefore + 1);
      assert.equal(list[0].version, newVersion);
      assert.deepEqual([list[0].kind, list[0].restoredFromVersion], ['checkpoint', target]);
      assert.equal((await e.protocols.getFull(id)).currentVersion, newVersion);
      assert.equal((await e.protocols.getVersion(id, newVersion)).snapshot.lifecycle.restoredFromVersion, target);
    } finally { await e.cleanup(); }
  });

  it('a PUBLISHED protocol stays published and its public data does not move; it just gains "unpublished changes"', async () => {
    const e = await env();
    try {
      const { id, target } = await scenario(e);
      (await e.protocols.publish(id, e.actor));
      const publicBefore = JSON.stringify([(await e.publicSvc.getDetail('original-name')), (await e.publicSvc.getRender('original-name'))]);
      const publishedRow = (await e.row('SELECT published_version_id, status FROM protocols WHERE id = $1', id));
      (await e.protocols.restoreVersion(id, target, e.actor));
      assert.deepEqual((await e.row('SELECT published_version_id, status FROM protocols WHERE id = $1', id)), publishedRow);
      assert.equal(JSON.stringify([(await e.publicSvc.getDetail('original-name')), (await e.publicSvc.getRender('original-name'))]), publicBefore);
      assert.equal((await e.protocols.getFull(id)).hasUnpublishedChanges, true);
    } finally { await e.cleanup(); }
  });

  it('restoring can bring back an OLD PUBLISHED version as a draft, which can then be re-published', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable('Cycle'));
      const v1 = (await e.protocols.publish(id, e.actor));
      (await e.setObjects(id, 0, [e.dot({ x: 0.9 })]));
      (await e.protocols.publish(id, e.actor));
      (await e.protocols.restoreVersion(id, v1.version, e.actor));
      assert.equal((await e.protocols.getFull(id)).canvases[0].objects[0].x, 0.45);
      assert.equal((await e.publicSvc.getRender('cycle')).canvases[0].objects[0].x, 0.9, 'the public still shows the newer publish');
      (await e.protocols.publish(id, e.actor));
      assert.equal((await e.publicSvc.getRender('cycle')).canvases[0].objects[0].x, 0.45);
    } finally { await e.cleanup(); }
  });

  it('never restores slug, status or the published pointer; a protocol in review goes back to draft', async () => {
    const e = await env();
    try {
      const { id, target } = await scenario(e);
      (await e.protocols.updateMetadata(id, { slug: 'a-new-slug' }, e.actor));
      (await e.protocols.changeStatus(id, 'in_review'));
      (await e.protocols.restoreVersion(id, target, e.actor));
      const p = (await e.protocols.getFull(id));
      assert.equal(p.slug, 'a-new-slug');
      assert.equal(p.status, 'draft');
      assert.equal(p.published, null);
    } finally { await e.cleanup(); }
  });

  it('warns (and clears) when the category or a condition it referenced is gone/inactive, instead of failing', async () => {
    const e = await env();
    try {
      const { id, target, cat, cond } = await scenario(e);
      (await e.catalog.setCategoryActive(cat.id, false)); (await e.catalog.setConditionActive(cond.id, false));
      const { warnings } = (await e.protocols.restoreVersion(id, target, e.actor));
      assert.equal(warnings.length, 2);
      const p = (await e.protocols.getFull(id));
      assert.equal(p.category, null);
      assert.deepEqual(p.conditions, []);
    } finally { await e.cleanup(); }
  });

  it('refuses unknown versions (404) and archived protocols (409), and a refused restore changes nothing', async () => {
    const e = await env();
    try {
      const { id, target } = await scenario(e);
      const snapshotBefore = JSON.stringify((await e.protocols.getFull(id)));
      await fails(async () => (await e.protocols.restoreVersion(id, 999, e.actor)), { status: 404 });
      (await e.protocols.archive(id));
      await fails(async () => (await e.protocols.restoreVersion(id, target, e.actor)), { status: 409, code: 'INVALID_TRANSITION' });
      (await e.protocols.changeStatus(id, 'draft'));
      const after = (await e.protocols.getFull(id));
      assert.equal(JSON.stringify({ ...after, status: 'x', updatedAt: 'x' }), JSON.stringify({ ...JSON.parse(snapshotBefore), status: 'x', updatedAt: 'x' }));
    } finally { await e.cleanup(); }
  });

  it('refuses a version whose stored data fails its integrity check', async () => {
    const e = await env();
    try {
      const { id, target } = await scenario(e);
      // corrupt a version behind the application's back (triggers must be dropped to do it — this is deliberate tampering)
      await e.run('DROP TRIGGER protocol_versions_no_update ON protocol_versions');
      await e.run("UPDATE protocol_versions SET snapshot_json = snapshot_json || ' ' WHERE protocol_id = $1 AND version = $2", id, target);
      await fails(async () => (await e.protocols.restoreVersion(id, target, e.actor)), { status: 500, code: 'INTEGRITY_ERROR' });
    } finally { await e.cleanup(); }
  });

  it('can restore a pre-existing schema-1 version: objects come back, and the result says metadata was not part of it', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable('Legacy Restore'));
      const c0 = (await e.protocols.getFull(id)).canvases[0];
      const old = { protocol: { id, name: 'Old Name', description: 'd', protocolType: 'hand' }, canvases: [{ viewKey: c0.viewKey, objects: [e.dot({ id: 'legacy-obj', x: 0.33 })] }] };
      await e.run("INSERT INTO protocol_versions (id,protocol_id,version,snapshot_json,checksum) VALUES ('legacy-v',$1,0,$2,$3)",
        id, JSON.stringify(old), require('crypto').createHash('sha256').update(JSON.stringify(old)).digest('hex')); // eslint-disable-line global-require
      const result = (await e.protocols.restoreVersion(id, 0, e.actor));
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0], /predates full snapshots/);
      const p = (await e.protocols.getFull(id));
      assert.deepEqual(p.canvases[0].objects.map((o) => [o.id, o.x]), [['legacy-obj', 0.33]]);
      assert.equal(p.name, 'Legacy Restore', 'metadata is left as it was');
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] duplicating a protocol', { skip: SKIP }, () => {
  async function source(e) {
    const cat = (await e.catalog.createCategory({ name: 'Head' }));
    const cond = (await e.catalog.createCondition({ name: 'Migraine' }));
    const id = (await e.makePublishable('Headache Relief', { displayName: 'Relief', shortDescription: 'short', description: 'long', categoryId: cat.id, conditionIds: [cond.id], searchTerms: ['migraine', { term: 'head pain', kind: 'synonym' }], metadata: { public: { tags: ['a', 'b'] }, internal: { n: 1 } } }));
    (await e.setObjects(id, 0, [e.dot({ id: 's1', x: 0.31, finger: 'index', landmarkReference: { start: 5, end: 6, t: 0.2 }, metadata: { nested: { deep: [1, 2] } } }), e.dot({ id: 's2', type: 'freeline', width: null, height: null, points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] })]));
    (await e.setObjects(id, 3, [e.dot({ id: 's3', type: 'rectangle', width: 0.16, height: 0.1, rotation: 15 })]));
    return { id, cat, cond };
  }

  it('creates a completely NEW protocol: new id, new stable slug, draft, no published pointer, version 1, no patient', async () => {
    const e = await env();
    try {
      const { id } = await source(e);
      (await e.protocols.publish(id, e.actor)); // duplicating a PUBLISHED protocol must not copy the pointer
      const copyId = (await e.protocols.duplicate(id, e.actor));
      const c = (await e.protocols.getFull(copyId));
      assert.match(c.id, UUID_RE);
      assert.notEqual(c.id, id);
      assert.equal(c.slug, 'headache-relief-copy');
      assert.notEqual(c.slug, (await e.protocols.getFull(id)).slug);
      assert.equal(c.status, 'draft');
      assert.equal(c.published, null);
      assert.equal((await e.row('SELECT published_version_id, published_at, patient_id FROM protocols WHERE id = $1', copyId)).published_version_id, null);
      assert.equal((await e.row('SELECT patient_id FROM protocols WHERE id = $1', copyId)).patient_id, null);
      assert.equal(c.currentVersion, 1);
      assert.deepEqual((await e.protocols.listVersions(copyId)).map((v) => v.version), [1]);
      assert.equal((await e.publicSvc.getDetail(c.slug)), null, 'the copy is not public until it is published itself');
      assert.equal(c.name, 'Headache Relief (Copy)');
      assert.equal(c.displayName, 'Relief (Copy)');
    } finally { await e.cleanup(); }
  });

  it('duplicating twice gives two different slugs', async () => {
    const e = await env();
    try {
      const { id } = await source(e);
      const slugs = [(await e.protocols.duplicate(id, e.actor)), (await e.protocols.duplicate(id, e.actor)), (await e.protocols.duplicate(id, e.actor))];
      for (let i = 0; i < slugs.length; i += 1) slugs[i] = (await e.protocols.getFull(slugs[i])).slug;
      assert.deepEqual(slugs, ['headache-relief-copy', 'headache-relief-copy-2', 'headache-relief-copy-3']);
    } finally { await e.cleanup(); }
  });

  it('copies canvases and objects with NEW ids everywhere, never sharing an id with the source, and preserves the geometry exactly', async () => {
    const e = await env();
    try {
      const { id } = await source(e);
      const src = (await e.protocols.getFull(id));
      const copy = (await e.protocols.getFull((await e.protocols.duplicate(id, e.actor))));

      const srcCanvasIds = src.canvases.map((c) => c.id); const copyCanvasIds = copy.canvases.map((c) => c.id);
      assert.equal(copyCanvasIds.length, 4);
      assert.ok(copyCanvasIds.every((cid) => UUID_RE.test(cid) && !srcCanvasIds.includes(cid)), 'canvas ids are new');

      const srcObjIds = new Set(allObjects(src).map((o) => o.id));
      const copyObjs = allObjects(copy);
      assert.equal(copyObjs.length, allObjects(src).length);
      assert.equal(new Set(copyObjs.map((o) => o.id)).size, copyObjs.length, 'ids are unique within the copy');
      assert.ok(copyObjs.every((o) => UUID_RE.test(o.id) && !srcObjIds.has(o.id)), 'no object id is shared with the source');
      assert.equal((await e.row('SELECT COUNT(*) c FROM objects')).c, allObjects(src).length * 2, 'source objects were not moved or removed');

      // geometry and every other property identical, view by view
      const strip = ({ id: _i, ...rest }) => rest; // eslint-disable-line no-unused-vars
      copy.canvases.forEach((c, i) => {
        assert.deepEqual([c.viewKey, c.width, c.height, c.sortOrder], [src.canvases[i].viewKey, src.canvases[i].width, src.canvases[i].height, src.canvases[i].sortOrder]);
        assert.deepEqual(c.objects.map(strip), src.canvases[i].objects.map(strip));
      });
    } finally { await e.cleanup(); }
  });

  it('deep-copies metadata, conditions and search terms; the copy is independent of the source', async () => {
    const e = await env();
    try {
      const { id, cond, cat } = await source(e);
      const copyId = (await e.protocols.duplicate(id, e.actor));
      const src = (await e.protocols.getFull(id)); const copy = (await e.protocols.getFull(copyId));
      assert.deepEqual(copy.metadata, src.metadata);
      assert.deepEqual([copy.shortDescription, copy.description, copy.categoryId], ['short', 'long', cat.id]);
      assert.deepEqual(copy.conditions.map((c) => c.id), [cond.id]);
      assert.deepEqual(copy.searchTerms.map((t) => [t.term, t.kind]), src.searchTerms.map((t) => [t.term, t.kind]));
      assert.ok(copy.searchTerms.every((t) => !src.searchTerms.some((s) => s.id === t.id)), 'search-term rows are new');

      // change the copy in every way; the source must not move
      const srcBefore = JSON.stringify((await e.protocols.getFull(id)));
      (await e.protocols.updateMetadata(copyId, { metadata: { public: { tags: ['changed'] } }, shortDescription: 'x' }, e.actor));
      (await e.protocols.addTerm(copyId, { term: 'only on copy' }, e.actor));
      (await e.protocols.detachCondition(cond.id, copyId, e.actor));
      (await e.setObjects(copyId, 0, [e.dot({ x: 0.99 })]));
      assert.equal(JSON.stringify((await e.protocols.getFull(id))), srcBefore);
    } finally { await e.cleanup(); }
  });

  it('duplicating leaves the source (and its published version) untouched, and 404s for an unknown protocol', async () => {
    const e = await env();
    try {
      const { id } = await source(e);
      const pub = (await e.protocols.publish(id, e.actor));
      const before = JSON.stringify([(await e.protocols.getFull(id)), (await e.rows('SELECT * FROM protocol_versions WHERE protocol_id = $1', id))]);
      (await e.protocols.duplicate(id, e.actor));
      assert.equal(JSON.stringify([(await e.protocols.getFull(id)), (await e.rows('SELECT * FROM protocol_versions WHERE protocol_id = $1', id))]), before);
      assert.equal((await e.protocols.getFull(id)).published.versionId, pub.versionId);
      await fails(async () => (await e.protocols.duplicate('ghost', e.actor)), { status: 404 });
    } finally { await e.cleanup(); }
  });

  it('a duplicate of a protocol that has a patient assigned does not inherit the patient', async () => {
    const e = await env();
    try {
      const { id } = await source(e);
      await e.run("INSERT INTO users (id,name,email,password_hash,role,status) VALUES ('pat','P','pat@example.com',NULL,'patient','pending')");
      await e.run("UPDATE protocols SET patient_id = 'pat' WHERE id = $1", id);
      const copyId = (await e.protocols.duplicate(id, e.actor));
      assert.equal((await e.row('SELECT patient_id FROM protocols WHERE id = $1', copyId)).patient_id, null);
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] deleting protocols', { skip: SKIP }, () => {
  it('a never-published protocol can be deleted (with its history); a published one cannot — archive it instead', async () => {
    const e = await env();
    try {
      const draft = (await e.makePublishable('Draft One'));
      (await e.protocols.remove(draft));
      assert.equal((await e.row('SELECT COUNT(*) c FROM protocols WHERE id = $1', draft)).c, 0);
      assert.equal((await e.row('SELECT COUNT(*) c FROM protocol_versions WHERE protocol_id = $1', draft)).c, 0);

      const pub = (await e.makePublishable('Published One'));
      (await e.protocols.publish(pub, e.actor));
      await fails(async () => (await e.protocols.remove(pub)), { status: 409, code: 'PUBLISHED_PROTOCOL' });
      (await e.protocols.archive(pub));
      await fails(async () => (await e.protocols.remove(pub)), { status: 409, code: 'PUBLISHED_PROTOCOL' }); // archived-after-published is still protected
      assert.ok((await e.row('SELECT id FROM protocols WHERE id = $1', pub)));
      assert.ok((await e.row('SELECT COUNT(*) c FROM protocol_versions WHERE protocol_id = $1', pub)).c >= 3, 'history kept');
      await fails(async () => (await e.protocols.remove('ghost')), { status: 404 });
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] public visibility', { skip: SKIP }, () => {
  it('draft, in-review, archived and unknown protocols are all invisible; only a published one is served', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable('Headache Relief Protocol'));
      const slug = 'headache-relief-protocol';
      const hidden = async () => [(await e.publicSvc.getDetail(slug)), (await e.publicSvc.getRender(slug))];

      assert.deepEqual((await hidden()), [null, null], 'draft');
      (await e.protocols.changeStatus(id, 'in_review'));
      assert.deepEqual((await hidden()), [null, null], 'in review');
      (await e.protocols.publish(id, e.actor));
      assert.ok((await hidden()).every(Boolean), 'published');
      (await e.protocols.archive(id));
      assert.deepEqual((await hidden()), [null, null], 'archived — even though it was published and still has its published version');
      (await e.protocols.changeStatus(id, 'draft'));
      assert.deepEqual((await hidden()), [null, null], 'back to draft: still not public until published again');
      (await e.protocols.publish(id, e.actor));
      assert.ok((await hidden()).every(Boolean), 're-published');

      for (const bad of ['no-such-protocol', '', 'UPPER', '../etc/passwd', 'a b', null, undefined]) assert.equal((await e.publicSvc.getDetail(bad)), null, String(bad));
    } finally { await e.cleanup(); }
  });

  it('the browser list contains only published protocols, never archived or draft ones', async () => {
    const e = await env();
    try {
      const a = (await e.makePublishable('Alpha')); const b = (await e.makePublishable('Beta')); (await e.makePublishable('Gamma-draft'));
      (await e.protocols.publish(a, e.actor)); (await e.protocols.publish(b, e.actor));
      assert.deepEqual((await e.publicSvc.list({})).items.map((i) => i.slug), ['alpha', 'beta']);
      (await e.protocols.archive(b));
      assert.deepEqual((await e.publicSvc.list({})).items.map((i) => i.slug), ['alpha']);
      assert.equal((await e.publicSvc.list({})).total, 1);
    } finally { await e.cleanup(); }
  });

  it('list filters by category and condition slug (active ones only), paginates, and ranks search hits', async () => {
    const e = await env();
    try {
      const head = (await e.catalog.createCategory({ name: 'Head' })); const gut = (await e.catalog.createCategory({ name: 'Gut' }));
      const mig = (await e.catalog.createCondition({ name: 'Migraine' }));
      const p1 = (await e.makePublishable('Chroma One', { categoryId: head.id, conditionIds: [mig.id], searchTerms: ['migraine'] }));
      const p2 = (await e.makePublishable('Chroma Two', { categoryId: gut.id, shortDescription: 'mentions migraine only in passing' }));
      const p3 = (await e.makePublishable('Migraine Special', { categoryId: gut.id }));
      for (const p of [p1, p2, p3]) await e.protocols.publish(p, e.actor);

      assert.deepEqual((await e.publicSvc.list({ category: 'head' })).items.map((i) => i.slug), ['chroma-one']);
      assert.deepEqual((await e.publicSvc.list({ category: 'gut' })).items.map((i) => i.slug), ['chroma-two', 'migraine-special']);
      assert.deepEqual((await e.publicSvc.list({ condition: 'migraine' })).items.map((i) => i.slug), ['chroma-one']);
      assert.equal((await e.publicSvc.list({ category: 'nope' })).total, 0);
      (await e.catalog.setCategoryActive(head.id, false));
      assert.equal((await e.publicSvc.list({ category: 'head' })).total, 0, 'an inactive category matches nothing');

      // ranking: exact search term > name match > description mention
      assert.deepEqual((await e.publicSvc.list({ q: 'migraine' })).items.map((i) => i.slug), ['chroma-one', 'migraine-special', 'chroma-two']);

      const page = (await e.publicSvc.list({ limit: 2, offset: 1 }));
      assert.deepEqual([page.total, page.limit, page.offset, page.items.length], [3, 2, 1, 2]);
      assert.equal((await e.publicSvc.list({ limit: 9999 })).limit, 100, 'the page size is capped');
    } finally { await e.cleanup(); }
  });

  it('refuses to serve a published version whose data no longer matches its checksum', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable('Tamper Test'));
      (await e.protocols.publish(id, e.actor));
      await e.run('DROP TRIGGER protocol_versions_no_update ON protocol_versions');
      await e.run("UPDATE protocol_versions SET snapshot_json = replace(snapshot_json, '0.45', '0.46') WHERE kind = 'published'");
      const original = console.error; console.error = () => {};
      try { await assert.rejects(async () => (await e.publicSvc.getRender('tamper-test')), (err) => err.status === 500); } finally { console.error = original; }
    } finally { await e.cleanup(); }
  });
});
