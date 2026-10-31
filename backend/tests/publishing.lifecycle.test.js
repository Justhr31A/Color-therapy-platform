/** [DETERMINISTIC SOFTWARE TESTS] protocol lifecycle, publishing, immutability (service level, real PostgreSQL database). */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { missingReason } = require('./helpers/testDb');

const SKIP = missingReason('pg', 'uuid');
const env = () => require('./helpers/publishingEnv').makeEnv(); // eslint-disable-line global-require
const fails = (fn, { status, code }) => assert.rejects(fn, (e) => e.status === status && (code === undefined || e.code === code), `expected HTTP ${status} ${code || ''}`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('[DETERMINISTIC] creating protocols and slugs', { skip: SKIP }, () => {
  it('a new protocol starts as a DRAFT, with a UUID, a slug, version 1 and no published version', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Headache Relief Protocol', displayName: 'Headache Relief', shortDescription: 's', description: 'd', metadata: { public: { note: 'x' } } }, e.actor));
      const p = (await e.protocols.getFull(id));
      assert.match(p.id, UUID_RE);
      assert.equal(p.status, 'draft');
      assert.equal(p.slug, 'headache-relief-protocol');
      assert.equal(p.currentVersion, 1);
      assert.equal(p.published, null);
      assert.equal(p.hasUnpublishedChanges, false);
      assert.deepEqual([p.displayName, p.shortDescription, p.description, p.protocolType], ['Headache Relief', 's', 'd', 'hand']);
      assert.deepEqual(p.metadata, { public: { note: 'x' } });
      assert.deepEqual(p.canvases.map((c) => c.viewKey), ['left_front', 'right_front', 'left_back', 'right_back']);
      assert.deepEqual((await e.protocols.listVersions(id)).map((v) => [v.version, v.kind]), [[1, 'checkpoint']]);
    } finally { await e.cleanup(); }
  });

  it('slugs stay unique: the same name twice gives -2, an explicit taken slug is 409, an invalid one 400', async () => {
    const e = await env();
    try {
      const a = (await e.protocols.create({ name: 'Calm' }, e.actor));
      const b = (await e.protocols.create({ name: 'Calm' }, e.actor));
      assert.deepEqual([(await e.protocols.getFull(a)).slug, (await e.protocols.getFull(b)).slug], ['calm', 'calm-2']);
      await fails(async () => (await e.protocols.create({ name: 'Other', slug: 'calm' }, e.actor)), { status: 409, code: 'SLUG_TAKEN' });
      await fails(async () => (await e.protocols.create({ name: 'Other', slug: 'NOT valid' }, e.actor)), { status: 400, code: 'INVALID_SLUG' });
      assert.equal((await e.row("SELECT COUNT(*) c FROM protocols WHERE name = 'Other'")).c, 0, 'refused creates leave nothing behind');
    } finally { await e.cleanup(); }
  });

  it('editing metadata never changes the slug — not even for a PUBLISHED protocol — unless a slug is explicitly requested', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable('Headache Relief Protocol'));
      (await e.protocols.publish(id, e.actor));
      (await e.protocols.updateMetadata(id, { name: 'Renamed Completely', displayName: 'New Display', description: 'new' }, e.actor));
      assert.equal((await e.protocols.getFull(id)).slug, 'headache-relief-protocol');
      assert.ok((await e.publicSvc.getDetail('headache-relief-protocol')), 'the public URL still works');

      (await e.protocols.updateMetadata(id, { slug: 'headache-relief' }, e.actor)); // explicit admin request
      assert.equal((await e.protocols.getFull(id)).slug, 'headache-relief');
      assert.equal((await e.publicSvc.getDetail('headache-relief-protocol')), null, 'the old address no longer resolves');
      assert.ok((await e.publicSvc.getDetail('headache-relief')));

      const other = (await e.protocols.create({ name: 'Other' }, e.actor));
      await fails(async () => (await e.protocols.updateMetadata(other, { slug: 'headache-relief' }, e.actor)), { status: 409, code: 'SLUG_TAKEN' });
      assert.equal((await e.protocols.getFull(other)).slug, 'other');
    } finally { await e.cleanup(); }
  });

  it('metadata updates are validated and a refused update changes nothing', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'P', shortDescription: 'keep' }, e.actor));
      const before = (await e.protocols.getFull(id));
      for (const bad of [{ name: '  ' }, { name: 'x'.repeat(121) }, { shortDescription: 'x'.repeat(301) }, { description: 5 }, { metadata: [1] }, { metadata: 'text' }, { categoryId: 'ghost' }]) {
        await assert.rejects(async () => (await e.protocols.updateMetadata(id, bad, e.actor)), (err) => err.status >= 400 && err.status < 500, JSON.stringify(bad));
      }
      const after = (await e.protocols.getFull(id));
      assert.deepEqual([after.name, after.shortDescription, after.currentVersion], [before.name, before.shortDescription, before.currentVersion]);
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] protocol lifecycle', { skip: SKIP }, () => {
  it('draft <-> in_review <-> archived moves work, and are visible in the protocol', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'P' }, e.actor));
      assert.equal((await e.protocols.changeStatus(id, 'in_review')).status, 'in_review');
      assert.equal((await e.protocols.changeStatus(id, 'draft')).status, 'draft');
      assert.equal((await e.protocols.changeStatus(id, 'archived')).status, 'archived');
      assert.equal((await e.protocols.changeStatus(id, 'draft')).status, 'draft');
    } finally { await e.cleanup(); }
  });

  it("'published' can only be reached through publish(); a status change to it is refused", async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable());
      await fails(async () => (await e.protocols.changeStatus(id, 'published')), { status: 400, code: 'USE_PUBLISH' });
      assert.equal((await e.protocols.getFull(id)).status, 'draft');
      assert.equal((await e.publicSvc.getDetail('headache-relief-protocol')), null);
    } finally { await e.cleanup(); }
  });

  it('a published protocol cannot be silently pulled back to draft/review; it can be archived', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable());
      (await e.protocols.publish(id, e.actor));
      await fails(async () => (await e.protocols.changeStatus(id, 'draft')), { status: 409, code: 'INVALID_TRANSITION' });
      await fails(async () => (await e.protocols.changeStatus(id, 'in_review')), { status: 409, code: 'INVALID_TRANSITION' });
      assert.ok((await e.publicSvc.getDetail('headache-relief-protocol')), 'still public after the refused changes');
      assert.equal((await e.protocols.archive(id)).status, 'archived');
    } finally { await e.cleanup(); }
  });

  it('unknown statuses are 400; the legacy "active" status is accepted only when explicitly allowed', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'P' }, e.actor));
      await fails(async () => (await e.protocols.changeStatus(id, 'banana')), { status: 400, code: 'UNKNOWN_STATUS' });
      await fails(async () => (await e.protocols.changeStatus(id, 'active')), { status: 400, code: 'UNKNOWN_STATUS' });
      assert.equal((await e.protocols.changeStatus(id, 'active', { allowLegacy: true })).status, 'active');
      await fails(async () => (await e.protocols.changeStatus('ghost', 'draft')), { status: 404 });
    } finally { await e.cleanup(); }
  });

  it('editing content while a protocol is in review sends it back to draft (what was reviewed has changed)', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable());
      (await e.protocols.changeStatus(id, 'in_review'));
      (await e.protocols.updateMetadata(id, { shortDescription: 'edited' }, e.actor));
      assert.equal((await e.protocols.getFull(id)).status, 'draft');
      (await e.protocols.changeStatus(id, 'in_review'));
      (await e.setObjects(id, 0, [e.dot({ x: 0.7 })]));
      assert.equal((await e.protocols.getFull(id)).status, 'draft');
    } finally { await e.cleanup(); }
  });

  it('an archived protocol cannot be published until it is moved back to draft', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable());
      (await e.protocols.archive(id));
      await fails(async () => (await e.protocols.publish(id, e.actor)), { status: 409, code: 'INVALID_TRANSITION' });
      (await e.protocols.changeStatus(id, 'draft'));
      (await e.protocols.publish(id, e.actor));
      assert.equal((await e.protocols.getFull(id)).status, 'published');
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] publishing', { skip: SKIP }, () => {
  it('publish creates an immutable version of kind "published", points protocols.published_version_id at it, and sets status published', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable());
      const before = (await e.protocols.getFull(id));
      const result = (await e.protocols.publish(id, e.actor, { note: 'first release' }));
      const p = (await e.protocols.getFull(id));
      assert.equal(p.status, 'published');
      assert.equal(p.published.versionId, result.versionId);
      assert.equal(p.published.version, result.version);
      assert.equal(result.version, before.currentVersion + 1);
      assert.equal(p.currentVersion, result.version);
      assert.ok(p.published.publishedAt);
      assert.equal(p.hasUnpublishedChanges, false);

      const v = (await e.row('SELECT * FROM protocol_versions WHERE id = $1', result.versionId));
      assert.deepEqual([v.kind, v.schema_version, v.protocol_id, v.created_by, v.note], ['published', 2, id, 'admin-1', 'first release']);
      assert.equal((await e.row('SELECT published_version_id FROM protocols WHERE id = $1', id)).published_version_id, result.versionId);
    } finally { await e.cleanup(); }
  });

  it('the published snapshot is COMPLETE: metadata, lifecycle, category, conditions, search terms, canvases, objects', async () => {
    const e = await env();
    try {
      const cat = (await e.catalog.createCategory({ name: 'Head' }));
      const cond = (await e.catalog.createCondition({ name: 'Migraine', categoryId: cat.id }));
      const id = (await e.makePublishable('Headache Relief', { displayName: 'Relief', shortDescription: 'short', description: 'long', categoryId: cat.id, conditionIds: [cond.id], searchTerms: ['migraine'], metadata: { public: { a: 1 } } }));
      (await e.setObjects(id, 1, [e.dot({ id: 'ar-1', finger: 'index', landmarkReference: { start: 5, end: 6, t: 0.4 }, metadata: { sizePreset: 'medium', scale: 0.8 } })]));
      const { version } = (await e.protocols.publish(id, e.actor));
      const snap = (await e.protocols.getVersion(id, version)).snapshot;

      assert.equal(snap.schemaVersion, 2);
      assert.equal(snap.protocol.displayName, 'Relief');
      assert.equal(snap.protocol.shortDescription, 'short');
      assert.equal(snap.protocol.description, 'long');
      assert.equal(snap.protocol.slug, 'headache-relief');
      assert.equal(snap.protocol.category.slug, 'head');
      assert.deepEqual(snap.protocol.conditions.map((c) => c.slug), ['migraine']);
      assert.deepEqual(snap.protocol.searchTerms, [{ term: 'migraine', kind: 'keyword' }]);
      assert.deepEqual(snap.protocol.metadata, { public: { a: 1 } });
      assert.deepEqual([snap.lifecycle.status, snap.lifecycle.kind, snap.lifecycle.versionNumber], ['published', 'published', version]);
      assert.equal(snap.canvases.length, 4);
      const withAr = snap.canvases[1].objects[0];
      assert.deepEqual([withAr.finger, withAr.landmarkReference, withAr.metadata], ['index', { start: 5, end: 6, t: 0.4 }, { sizePreset: 'medium', scale: 0.8 }], 'future AR / size fields are preserved verbatim');
      assert.deepEqual([withAr.x, withAr.y, withAr.width], [0.45, 0.5, 0.03], 'normalized coordinates preserved');
    } finally { await e.cleanup(); }
  });

  it('is transactional: if the LAST step fails, nothing is left behind (no version row, no pointer, no status change, counter unchanged)', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable());
      const before = { protocol: (await e.row('SELECT * FROM protocols WHERE id = $1', id)), versions: (await e.row('SELECT COUNT(*) c FROM protocol_versions WHERE protocol_id = $1', id)).c };
      // Make the final UPDATE (pointer + status) fail AFTER the version row has been inserted.
      await e.run(`CREATE FUNCTION sabotage_fn() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status = 'published' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER sabotage BEFORE UPDATE OF status ON protocols FOR EACH ROW EXECUTE FUNCTION sabotage_fn();`);
      await assert.rejects(async () => (await e.protocols.publish(id, e.actor)), /simulated failure/);
      await e.run('DROP TRIGGER sabotage ON protocols; DROP FUNCTION sabotage_fn();');

      assert.deepEqual((await e.row('SELECT * FROM protocols WHERE id = $1', id)), before.protocol, 'protocol row byte-identical');
      assert.equal((await e.row('SELECT COUNT(*) c FROM protocol_versions WHERE protocol_id = $1', id)).c, before.versions, 'the half-made version was rolled back');
      assert.equal((await e.publicSvc.getDetail('headache-relief-protocol')), null);
      // and publishing works normally once the fault is gone
      assert.equal((await e.protocols.publish(id, e.actor)).version, before.protocol.current_version + 1);
    } finally { await e.cleanup(); }
  });

  it('a failed RE-publish leaves the previous public version fully intact', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable());
      const first = (await e.protocols.publish(id, e.actor));
      const publicBefore = JSON.stringify((await e.publicSvc.getRender('headache-relief-protocol')));
      (await e.setObjects(id, 0, [e.dot({ x: 5 })])); // now invalid
      await fails(async () => (await e.protocols.publish(id, e.actor)), { status: 422, code: 'VALIDATION_FAILED' });
      assert.equal((await e.protocols.getFull(id)).published.versionId, first.versionId);
      assert.equal(JSON.stringify((await e.publicSvc.getRender('headache-relief-protocol'))), publicBefore);
    } finally { await e.cleanup(); }
  });

  it('an invalid protocol is REJECTED with every problem listed, and nothing is written', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Empty one' }, e.actor)); // no markings at all
      const versionsBefore = (await e.rows('SELECT id FROM protocol_versions')).length;
      let caught;
      try { (await e.protocols.publish(id, e.actor)); } catch (err) { caught = err; }
      assert.equal(caught.status, 422);
      assert.equal(caught.code, 'VALIDATION_FAILED');
      assert.ok(caught.details.some((d) => d.code === 'NO_OBJECTS'));
      assert.ok(caught.details.every((d) => d.code && d.path && d.message));
      assert.equal((await e.rows('SELECT id FROM protocol_versions')).length, versionsBefore, 'no version row created');
      const p = (await e.protocols.getFull(id));
      assert.deepEqual([p.status, p.published], ['draft', null]);
    } finally { await e.cleanup(); }
  });

  it('rejects bad object data stored in the draft: unknown type, out-of-range coordinates, bad colour — all reported together', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Bad data' }, e.actor));
      const c0 = (await e.protocols.getFull(id)).canvases[0].id;
      // draft saving is permissive by design; write the bad rows the way old/hand-edited data could exist
      await e.run("INSERT INTO objects (id,canvas_id,object_type,x,y,width,height,rotation,color,thickness,opacity,z_index) VALUES ('bad1',$1,'hologram',0.5,0.5,0.1,0.1,0,'#fff',1,1,1)", c0);
      await e.run("INSERT INTO objects (id,canvas_id,object_type,x,y,width,height,rotation,color,thickness,opacity,z_index) VALUES ('bad2',$1,'dot',1.7,0.5,0.03,0.03,0,'red',0,1,2)", c0);
      let details;
      try { (await e.protocols.publish(id, e.actor)); } catch (err) { details = err.details; }
      const codes = details.map((d) => d.code);
      for (const expected of ['OBJECT_TYPE_UNKNOWN', 'COORDINATE_INVALID', 'COLOR_INVALID']) assert.ok(codes.includes(expected), `${expected} in ${codes}`);
    } finally { await e.cleanup(); }
  });

  it('rejects publishing with an inactive category or condition, and reports them', async () => {
    const e = await env();
    try {
      const cat = (await e.catalog.createCategory({ name: 'Head' }));
      const cond = (await e.catalog.createCondition({ name: 'Migraine' }));
      const id = (await e.makePublishable('P', { categoryId: cat.id, conditionIds: [cond.id] }));
      (await e.catalog.setCategoryActive(cat.id, false)); (await e.catalog.setConditionActive(cond.id, false));
      let details;
      try { (await e.protocols.publish(id, e.actor)); } catch (err) { details = err.details.map((d) => d.code); }
      assert.deepEqual(details.sort(), ['CATEGORY_INACTIVE', 'CONDITION_INACTIVE']);
      (await e.catalog.setCategoryActive(cat.id, true)); (await e.catalog.setConditionActive(cond.id, true));
      assert.ok((await e.protocols.publish(id, e.actor)).versionId);
    } finally { await e.cleanup(); }
  });

  it('every publish adds a NEW version; earlier published versions are kept, untouched, and only the latest is pointed at', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable());
      const v1 = (await e.protocols.publish(id, e.actor));
      const rowV1 = (await e.row('SELECT * FROM protocol_versions WHERE id = $1', v1.versionId));
      (await e.setObjects(id, 0, [e.dot({ x: 0.9 })]));
      const v2 = (await e.protocols.publish(id, e.actor));
      assert.notEqual(v2.versionId, v1.versionId);
      assert.ok(v2.version > v1.version);
      assert.deepEqual((await e.row('SELECT * FROM protocol_versions WHERE id = $1', v1.versionId)), rowV1, 'the earlier published version is byte-identical');
      assert.equal((await e.protocols.getFull(id)).published.versionId, v2.versionId);
      const list = (await e.protocols.listVersions(id));
      assert.equal(list.filter((v) => v.isCurrentlyPublished).length, 1);
      assert.equal(list.filter((v) => v.kind === 'published').length, 2);
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] published versions are immutable and isolated from the draft', { skip: SKIP }, () => {
  it('the database refuses to change or delete any version row, and every checksum verifies', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable());
      const { version, versionId } = (await e.protocols.publish(id, e.actor));
      await assert.rejects(() => e.run('UPDATE protocol_versions SET snapshot_json = $1 WHERE id = $2', '{}', versionId), /immutable/i);
      await assert.rejects(() => e.run('DELETE FROM protocol_versions WHERE id = $1', versionId), /cannot be deleted/i);
      for (const v of (await e.protocols.listVersions(id))) assert.equal((await e.protocols.getVersion(id, v.version)).integrity.valid, true, `v${v.version}`);
      assert.ok(version);
    } finally { await e.cleanup(); }
  });

  it('draft edits leave the public response identical (details, render and list), and flag "unpublished changes"; re-publishing then changes it', async () => {
    const e = await env();
    try {
      const cat = (await e.catalog.createCategory({ name: 'Head' }));
      const cond = (await e.catalog.createCondition({ name: 'Migraine' }));
      const id = (await e.makePublishable('Headache Relief', { shortDescription: 'published text', categoryId: cat.id, searchTerms: ['migraine'] }));
      (await e.protocols.publish(id, e.actor));
      const slug = 'headache-relief';
      const pub = async () => JSON.stringify({ d: (await e.publicSvc.getDetail(slug)), r: (await e.publicSvc.getRender(slug)), l: (await e.publicSvc.list({})), q: (await e.publicSvc.list({ q: 'draft only term' })) });
      const before = await pub();
      assert.equal((await e.protocols.getFull(id)).hasUnpublishedChanges, false);

      (await e.setObjects(id, 0, [e.dot({ x: 0.9, color: '#00ff00' }), e.dot({ type: 'ring', width: 0.1 })]));
      (await e.setObjects(id, 2, [e.dot()]));
      (await e.protocols.updateMetadata(id, { name: 'DRAFT ONLY NAME', displayName: 'DRAFT ONLY', shortDescription: 'DRAFT ONLY TEXT', description: 'draft', metadata: { public: { leak: true } } }, e.actor));
      (await e.protocols.addTerm(id, { term: 'draft only term' }, e.actor));
      (await e.protocols.attachCondition(cond.id, id, e.actor));
      (await e.catalog.updateCategory(cat.id, { name: 'Renamed Category' }));

      assert.equal(await pub(), before, 'the public data did not move at all');
      assert.ok(!(await pub()).includes('DRAFT ONLY'), 'no draft text appears publicly');
      assert.equal((await e.protocols.getFull(id)).hasUnpublishedChanges, true);
      assert.equal((await e.protocols.getFull(id)).status, 'published', 'the protocol stays published while its draft diverges');

      (await e.protocols.publish(id, e.actor));
      assert.notEqual(await pub(), before);
      assert.ok((await e.publicSvc.getDetail(slug)).shortDescription === 'DRAFT ONLY TEXT');
      assert.equal((await e.protocols.getFull(id)).hasUnpublishedChanges, false);
    } finally { await e.cleanup(); }
  });

  it('the legacy builder save path also cannot touch a published version', async () => {
    const e = await env();
    try {
      const id = (await e.makePublishable());
      const { versionId } = (await e.protocols.publish(id, e.actor));
      const frozen = (await e.row('SELECT * FROM protocol_versions WHERE id = $1', versionId));
      const renderBefore = JSON.stringify((await e.publicSvc.getRender('headache-relief-protocol')));
      for (let i = 0; i < 3; i += 1) (await e.setObjects(id, 0, [e.dot({ x: 0.1 * (i + 1) })]));
      assert.deepEqual((await e.row('SELECT * FROM protocol_versions WHERE id = $1', versionId)), frozen);
      assert.equal(JSON.stringify((await e.publicSvc.getRender('headache-relief-protocol'))), renderBefore);
    } finally { await e.cleanup(); }
  });
});
