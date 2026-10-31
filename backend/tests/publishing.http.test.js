/**
 * [DETERMINISTIC SOFTWARE TESTS — HTTP level] the admin and public publishing APIs, on the real server + real PostgreSQL.
 * They prove the SERVER's behaviour; they do not exercise any browser UI.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { HTTP_SKIP, bootstrap, dot } = require('./helpers/httpHarness');

const A = '/api/admin';
const P = '/api/public/protocols';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

describe('[DETERMINISTIC · HTTP] publishing APIs', { skip: HTTP_SKIP }, () => {
  let h;
  before(async () => { h = await bootstrap(); });
  after(async () => { if (h) await h.stop(); });

  /** Creates a publishable protocol through the admin API + the builder save endpoint (the real workflow). */
  async function newProtocol(name, extra = {}) {
    const r = await h.admin.post(`${A}/protocols`, { name, ...extra });
    assert.equal(r.status, 201, r.text);
    const p = r.json;
    const save = await h.admin.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects: [dot({ id: `o-${p.slug}` })] }] });
    assert.equal(save.status, 200, save.text);
    return p;
  }
  const counts = async () => ({
    categories: (await h.row('SELECT COUNT(*) c FROM categories')).c,
    conditions: (await h.row('SELECT COUNT(*) c FROM conditions')).c,
    protocols: (await h.row('SELECT COUNT(*) c FROM protocols')).c,
    versions: (await h.row('SELECT COUNT(*) c FROM protocol_versions')).c,
    terms: (await h.row('SELECT COUNT(*) c FROM protocol_search_terms')).c,
  });

  // ---------------------------------------------------------------- authorization
  describe('admin authorization', () => {
    // every admin endpoint, reads and writes; ids are dummies because the auth check happens first
    const ENDPOINTS = [
      ['GET', '/categories'], ['POST', '/categories'], ['GET', '/categories/x'], ['PUT', '/categories/x'], ['POST', '/categories/x/activate'], ['POST', '/categories/x/deactivate'],
      ['GET', '/conditions'], ['POST', '/conditions'], ['GET', '/conditions/x'], ['PUT', '/conditions/x'], ['POST', '/conditions/x/activate'], ['POST', '/conditions/x/deactivate'],
      ['GET', '/conditions/x/protocols'], ['POST', '/conditions/x/protocols'], ['DELETE', '/conditions/x/protocols/y'],
      ['GET', '/protocols'], ['POST', '/protocols'], ['GET', '/protocols/x'], ['PUT', '/protocols/x'], ['POST', '/protocols/x/status'], ['POST', '/protocols/x/publish'],
      ['POST', '/protocols/x/archive'], ['POST', '/protocols/x/duplicate'], ['GET', '/protocols/x/versions'], ['GET', '/protocols/x/versions/1'], ['POST', '/protocols/x/versions/1/restore'],
      ['GET', '/protocols/x/search-terms'], ['POST', '/protocols/x/search-terms'], ['DELETE', '/protocols/x/search-terms/y'],
    ];

    it(`every one of the ${ENDPOINTS.length} admin endpoints: anonymous -> 401, doctor -> 403, patient -> 403, and nothing is changed`, async () => {
      const before = (await counts());
      for (const [method, path] of ENDPOINTS) {
        const body = method === 'GET' || method === 'DELETE' ? undefined : { name: 'Intruder', status: 'draft', protocolId: 'x', term: 'x' };
        const denied = [['anonymous', h.anon, 401], ['doctor', h.doctor, 403], ['patient', h.patient, 403]];
        for (const [who, client, expected] of denied) {
          const r = await client.request(method, A + path, body);
          assert.equal(r.status, expected, `${who} ${method} ${path} -> ${r.status}`);
        }
      }
      assert.deepEqual((await counts()), before, 'the refused requests changed nothing');
    });

    it('an admin passes the authorization gate on all of them (the endpoints are reachable, not accidentally locked)', async () => {
      for (const [method, path] of ENDPOINTS) {
        const r = await h.admin.request(method, A + path, method === 'GET' || method === 'DELETE' ? undefined : {});
        assert.ok(![401, 403].includes(r.status), `admin ${method} ${path} -> ${r.status}`);
      }
    });

    it('a doctor can still use the existing builder API but cannot reach anything under /api/admin', async () => {
      assert.equal((await h.doctor.get('/api/protocols')).status, 200);
      assert.equal((await h.doctor.get(`${A}/protocols`)).status, 403);
    });

    it('a doctor can publish their own protocol, but cannot archive or restore it through admin-only endpoints', async () => {
  const mine = (
    await h.doctor.post('/api/protocols', {
      name: 'Doctor Publish Test',
      protocolType: 'hand',
    })
  ).json;

  const save = await h.doctor.post(`/api/protocols/${mine.id}/save`, {
    canvases: [
      {
        id: mine.canvases[0].id,
        objects: [dot({ id: `doctor-publish-${mine.slug}` })],
      },
    ],
  });

  assert.equal(save.status, 200, save.text);

  const published = await h.doctor.post(
    `/api/protocols/${mine.id}/publish`,
    {}
  );

  assert.equal(published.status, 201, published.text);
  assert.equal(published.json.protocol.status, 'published');
  assert.ok(published.json.versionId);

  assert.equal(
    (await h.doctor.post(`/api/protocols/${mine.id}/archive`, {})).status,
    404
  );

  assert.equal(
    (await h.doctor.post(`/api/protocols/${mine.id}/versions/1/restore`, {}))
      .status,
    404
  );

  assert.equal(
    (await h.anon.get(`${P}/${mine.slug}`)).status,
    200
  );
});
  });

  // ------------------------------------------------------------------ admin flow
  describe('admin API flow', () => {
    it('categories: create, duplicate-slug refusal, update, deactivate/activate, list', async () => {
      const c = await h.admin.post(`${A}/categories`, { name: 'Head & Neck', description: 'd' });
      assert.equal(c.status, 201);
      assert.equal(c.json.slug, 'head-and-neck');
      assert.equal((await h.admin.post(`${A}/categories`, { name: 'Other', slug: 'head-and-neck' })).status, 409);
      assert.equal((await h.admin.post(`${A}/categories`, { name: 'Other', slug: 'Bad Slug' })).status, 400);
      assert.equal((await h.admin.post(`${A}/categories`, {})).status, 400);
      assert.equal((await h.admin.put(`${A}/categories/${c.json.id}`, { name: 'Head, Neck' })).json.slug, 'head-and-neck');
      assert.equal((await h.admin.post(`${A}/categories/${c.json.id}/deactivate`)).json.isActive, false);
      assert.equal((await h.admin.post(`${A}/categories/${c.json.id}/activate`)).json.isActive, true);
      assert.ok((await h.admin.get(`${A}/categories`)).json.some((x) => x.id === c.json.id));
      assert.equal((await h.admin.get(`${A}/categories/nope`)).status, 404);
    });

    it('conditions: create, update, list, attach/detach protocols (duplicate attach is refused)', async () => {
      const cond = (await h.admin.post(`${A}/conditions`, { name: 'Migraine' })).json;
      assert.equal(cond.slug, 'migraine');
      const p = await newProtocol('Attach Test');
      const attach = () => h.admin.post(`${A}/conditions/${cond.id}/protocols`, { protocolId: p.id });
      assert.equal((await attach()).status, 201);
      assert.equal((await attach()).status, 409);
      assert.equal((await h.admin.post(`${A}/conditions/${cond.id}/protocols`, {})).status, 400);
      assert.equal((await h.admin.post(`${A}/conditions/${cond.id}/protocols`, { protocolId: 'ghost' })).status, 404);
      assert.deepEqual((await h.admin.get(`${A}/conditions/${cond.id}/protocols`)).json.map((x) => x.id), [p.id]);
      assert.deepEqual((await h.admin.get(`${A}/protocols/${p.id}`)).json.conditions.map((c) => c.slug), ['migraine']);
      assert.equal((await h.admin.delete(`${A}/conditions/${cond.id}/protocols/${p.id}`)).status, 200);
      assert.equal((await h.admin.delete(`${A}/conditions/${cond.id}/protocols/${p.id}`)).status, 404);
      assert.equal((await h.admin.put(`${A}/conditions/${cond.id}`, { name: 'Chronic Migraine' })).json.slug, 'migraine');
    });

    it('conditions: required fields, and an explicit duplicate slug is refused (a repeated NAME instead gets its own auto-suffixed slug, same as categories)', async () => {
      assert.equal((await h.admin.post(`${A}/conditions`, {})).status, 400);
      assert.equal((await h.admin.post(`${A}/conditions`, { name: '   ' })).status, 400);
      const before = (await counts());
      const first = await h.admin.post(`${A}/conditions`, { name: 'Tension Headache' });
      assert.equal(first.status, 201);

      // the same NAME again is allowed — it is not what has to be unique — and gets a distinct, auto-suffixed slug
      const second = await h.admin.post(`${A}/conditions`, { name: 'Tension Headache' });
      assert.equal(second.status, 201, second.text);
      assert.notEqual(second.json.slug, first.json.slug);

      // an EXPLICIT slug that collides IS refused
      const explicitSlugClash = await h.admin.post(`${A}/conditions`, { name: 'Something else', slug: first.json.slug });
      assert.equal(explicitSlugClash.status, 409);
      assert.equal((await counts()).conditions, before.conditions + 2, 'exactly the two distinctly-slugged conditions were created');
    });

    it('conditions: search terms / synonyms can be set on create, replaced on update, and are validated', async () => {
      const created = await h.admin.post(`${A}/conditions`, { name: 'Sciatica', synonyms: [' Lower back nerve pain ', 'sciatic nerve pain', 'Sciatic Nerve Pain', ''] });
      assert.equal(created.status, 201, created.text);
      // trimmed, empty dropped, case-insensitively deduped
      assert.deepEqual(created.json.synonyms, ['Lower back nerve pain', 'sciatic nerve pain']);

      const updated = await h.admin.put(`${A}/conditions/${created.json.id}`, { synonyms: ['Nerve pain'] });
      assert.equal(updated.status, 200);
      assert.deepEqual(updated.json.synonyms, ['Nerve pain'], 'update REPLACES the synonym list, it does not merge into it');

      // leaving synonyms out of an update never clears it
      assert.deepEqual((await h.admin.put(`${A}/conditions/${created.json.id}`, { description: 'x' })).json.synonyms, ['Nerve pain']);

      assert.equal((await h.admin.post(`${A}/conditions`, { name: 'Bad synonyms', synonyms: 'not-an-array' })).status, 400);
      assert.equal((await h.admin.post(`${A}/conditions`, { name: 'Bad synonyms 2', synonyms: [123] })).status, 400);
      assert.equal((await h.admin.post(`${A}/conditions`, { name: 'Bad synonyms 3', synonyms: ['x'.repeat(81)] })).status, 400);
      assert.equal((await h.admin.post(`${A}/conditions`, { name: 'Bad synonyms 4', synonyms: Array.from({ length: 31 }, (_, i) => `term${i}`) })).status, 400);
    });

    it('a condition with no synonyms of its own reads back an empty list, never null or undefined', async () => {
      const created = await h.admin.post(`${A}/conditions`, { name: 'Plain Condition' });
      assert.deepEqual(created.json.synonyms, []);
      assert.deepEqual((await h.admin.get(`${A}/conditions/${created.json.id}`)).json.synonyms, []);
      assert.deepEqual((await h.admin.get(`${A}/conditions`)).json.find((c) => c.id === created.json.id).synonyms, []);
    });

    it('archiving (deactivating) a condition that is linked to a protocol does NOT delete it or the link, and reactivating restores it — exactly like categories', async () => {
      const cond = (await h.admin.post(`${A}/conditions`, { name: 'Archive Me' })).json;
      const p = await newProtocol('Linked to archived condition');
      assert.equal((await h.admin.post(`${A}/conditions/${cond.id}/protocols`, { protocolId: p.id })).status, 201);

      const deactivated = await h.admin.post(`${A}/conditions/${cond.id}/deactivate`);
      assert.equal(deactivated.status, 200);
      assert.equal(deactivated.json.isActive, false);
      // the condition itself, and its link to the protocol, both still exist
      assert.equal((await h.admin.get(`${A}/conditions/${cond.id}`)).status, 200);
      assert.deepEqual((await h.admin.get(`${A}/conditions/${cond.id}/protocols`)).json.map((x) => x.id), [p.id]);
      assert.deepEqual((await h.admin.get(`${A}/protocols/${p.id}`)).json.conditions.map((c) => c.id), [cond.id]);
      assert.equal((await h.row('SELECT COUNT(*) c FROM condition_protocols WHERE condition_id = $1', cond.id)).c, 1);

      const reactivated = await h.admin.post(`${A}/conditions/${cond.id}/activate`);
      assert.equal(reactivated.json.isActive, true);
      assert.deepEqual((await h.admin.get(`${A}/conditions/${cond.id}/protocols`)).json.map((x) => x.id), [p.id], 'still linked after reactivating');
    });

    it('editing a condition\'s description/synonyms never disturbs which protocols it is linked to', async () => {
      const cond = (await h.admin.post(`${A}/conditions`, { name: 'Edit Preserves Links' })).json;
      const a = await newProtocol('Protocol A for edit test');
      const b = await newProtocol('Protocol B for edit test');
      await h.admin.post(`${A}/conditions/${cond.id}/protocols`, { protocolId: a.id });
      await h.admin.post(`${A}/conditions/${cond.id}/protocols`, { protocolId: b.id });
      await h.admin.put(`${A}/conditions/${cond.id}`, { description: 'Updated description', synonyms: ['a new synonym'] });
      const linked = (await h.admin.get(`${A}/conditions/${cond.id}/protocols`)).json.map((x) => x.id).sort();
      assert.deepEqual(linked, [a.id, b.id].sort());
    });

    it('protocols: create as draft, list with filters, update metadata, search terms', async () => {
      const p = await newProtocol('Flow Protocol', { displayName: 'Flow', shortDescription: 'short', searchTerms: ['flow term'] });
      assert.equal(p.status, 'draft');
      assert.equal(p.published, null);
      const list = (await h.admin.get(`${A}/protocols?status=draft&q=flow`)).json;
      assert.ok(list.items.some((i) => i.id === p.id));
      assert.ok(list.items.every((i) => i.status === 'draft'));
      assert.equal((await h.admin.get(`${A}/protocols?status=nonsense`)).status, 400);

      const upd = await h.admin.put(`${A}/protocols/${p.id}`, { displayName: 'Flow 2', shortDescription: 'short 2' });
      assert.deepEqual([upd.status, upd.json.displayName, upd.json.slug], [200, 'Flow 2', 'flow-protocol']);
      assert.equal((await h.admin.put(`${A}/protocols/${p.id}`, { name: '' })).status, 400);

      const t = await h.admin.post(`${A}/protocols/${p.id}/search-terms`, { term: 'head pain', kind: 'synonym' });
      assert.equal(t.status, 201);
      assert.equal((await h.admin.post(`${A}/protocols/${p.id}/search-terms`, { term: 'HEAD  pain' })).status, 409);
      assert.deepEqual((await h.admin.get(`${A}/protocols/${p.id}/search-terms`)).json.map((x) => x.term), ['flow term', 'head pain']);
      assert.equal((await h.admin.delete(`${A}/protocols/${p.id}/search-terms/${t.json.id}`)).status, 200);
      assert.equal((await h.admin.delete(`${A}/protocols/${p.id}/search-terms/${t.json.id}`)).status, 404);
    });

    it('lifecycle over HTTP: status endpoint, publish (422 when invalid, 201 when valid), archive, and the refused moves', async () => {
      const empty = (await h.admin.post(`${A}/protocols`, { name: 'Lifecycle Empty' })).json;
      const bad = await h.admin.post(`${A}/protocols/${empty.id}/publish`, {});
      assert.equal(bad.status, 422);
      assert.equal(bad.json.code, 'VALIDATION_FAILED');
      assert.ok(bad.json.details.some((d) => d.code === 'NO_OBJECTS'));
      assert.equal((await h.anon.get(`${P}/${empty.slug}`)).status, 404, 'a refused publish leaves it private');

      const p = await newProtocol('Lifecycle Full');
      assert.equal((await h.admin.post(`${A}/protocols/${p.id}/status`, { status: 'in_review' })).json.status, 'in_review');
      assert.equal((await h.admin.post(`${A}/protocols/${p.id}/status`, { status: 'published' })).status, 400);
      assert.equal((await h.admin.post(`${A}/protocols/${p.id}/status`, {})).status, 400);
      const pub = await h.admin.post(`${A}/protocols/${p.id}/publish`, { note: 'go' });
      assert.equal(pub.status, 201);
      assert.equal(pub.json.protocol.status, 'published');
      assert.equal(pub.json.protocol.published.versionId, pub.json.versionId);
      assert.equal((await h.admin.post(`${A}/protocols/${p.id}/status`, { status: 'draft' })).status, 409);
      assert.equal((await h.anon.get(`${P}/${p.slug}`)).status, 200);
      assert.equal((await h.admin.post(`${A}/protocols/${p.id}/archive`)).json.status, 'archived');
      assert.equal((await h.anon.get(`${P}/${p.slug}`)).status, 404);
      assert.equal((await h.admin.post(`${A}/protocols/${p.id}/publish`, {})).status, 409, 'archived protocols cannot be published');
    });

    it('version history, single version with integrity, restore (into a draft) and duplicate over HTTP', async () => {
      const p = await newProtocol('History Protocol', { shortDescription: 'original' });
      const pub = (await h.admin.post(`${A}/protocols/${p.id}/publish`, {})).json;
      await h.admin.put(`${A}/protocols/${p.id}`, { shortDescription: 'edited later' });

      const versions = (await h.admin.get(`${A}/protocols/${p.id}/versions`)).json;
      assert.deepEqual(versions.map((v) => v.kind), ['checkpoint', 'published', 'checkpoint', 'checkpoint']);
      assert.ok(versions.every((v) => !('snapshot' in v)), 'the list does not carry snapshots');
      const one = (await h.admin.get(`${A}/protocols/${p.id}/versions/${pub.version}`)).json;
      assert.equal(one.integrity.valid, true);
      assert.equal(one.snapshot.protocol.shortDescription, 'original');
      assert.equal((await h.admin.get(`${A}/protocols/${p.id}/versions/999`)).status, 404);
      assert.equal((await h.admin.get(`${A}/protocols/${p.id}/versions/abc`)).status, 400);

      const frozen = await h.row('SELECT * FROM protocol_versions WHERE id = $1', pub.versionId);
      const restored = await h.admin.post(`${A}/protocols/${p.id}/versions/${pub.version}/restore`);
      assert.equal(restored.status, 200);
      assert.equal(restored.json.protocol.shortDescription, 'original');
      assert.equal(restored.json.restoredFromVersion, pub.version);
      assert.deepEqual(await h.row('SELECT * FROM protocol_versions WHERE id = $1', pub.versionId), frozen, 'the historical version is untouched');
      assert.equal(restored.json.protocol.status, 'published');
      // the published version's OWN content was restored, so the draft now equals what is published: nothing is pending
      assert.equal(restored.json.protocol.hasUnpublishedChanges, false);

      const dup = await h.admin.post(`${A}/protocols/${p.id}/duplicate`);
      assert.equal(dup.status, 201);
      assert.deepEqual([dup.json.status, dup.json.published, dup.json.slug], ['draft', null, 'history-protocol-copy']);
      assert.notEqual(dup.json.id, p.id);
    });
  });

  // ------------------------------------------------------------------- public API
  describe('public API contract and security', () => {
    let pub; // a published protocol with rich metadata
    let ids; // every internal id that must never appear publicly
    before(async () => {
      const cat = (await h.admin.post(`${A}/categories`, { name: 'Public Cat' })).json;
      const cond = (await h.admin.post(`${A}/conditions`, { name: 'Public Condition', categoryId: cat.id })).json;
      const r = await h.admin.post(`${A}/protocols`, {
        name: 'Headache Relief Protocol', displayName: 'Headache Relief', shortDescription: 'For headaches', description: 'Detailed text',
        categoryId: cat.id, conditionIds: [cond.id], searchTerms: ['migraine', 'severe headache', { term: 'one-sided headache', kind: 'phrase' }],
        metadata: { public: { audience: 'adults' }, internal: { note: 'TOP-SECRET-INTERNAL-NOTE' } },
      });
      pub = r.json;
      await h.admin.post(`/api/protocols/${pub.id}/save`, { canvases: [
        { id: pub.canvases[0].id, objects: [
          dot({ id: 'pub-dot', x: 0.4578, y: 0.4983, finger: 'pinky', landmarkReference: { start: 5, end: 6, t: 0.3 }, metadata: { sizePreset: 'medium', scale: 0.8 } }),
          dot({ id: 'pub-ring', type: 'ring', width: 0.08, height: 0.08, thickness: 4, opacity: 0.8, color: '#1a73e8' }),
        ] },
        { id: pub.canvases[3].id, objects: [dot({ id: 'pub-back', type: 'rectangle', width: 0.16, height: 0.1, rotation: 15 })] },
      ] });
      const published = await h.admin.post(`${A}/protocols/${pub.id}/publish`, { note: 'INTERNAL PUBLISH NOTE' });
      assert.equal(published.status, 201, published.text);
      const full = (await h.admin.get(`${A}/protocols/${pub.id}`)).json;
      ids = [full.id, full.ownerId, published.json.versionId, ...full.canvases.map((c) => c.id), 'admin@example.com', 'doctor@example.com', 'patient@example.com', 'pat-1', 'doc-1'];
    });

    it('GET /api/public/protocols/:slug returns the published version — and needs no login', async () => {
      const r = await h.anon.get(`${P}/headache-relief-protocol`);
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json).sort(), ['category', 'conditions', 'description', 'displayName', 'links', 'metadata', 'name', 'protocolType', 'searchTerms', 'shortDescription', 'slug', 'version', 'views']);
      assert.deepEqual(
        { slug: r.json.slug, name: r.json.name, displayName: r.json.displayName, shortDescription: r.json.shortDescription, description: r.json.description, protocolType: r.json.protocolType },
        { slug: 'headache-relief-protocol', name: 'Headache Relief Protocol', displayName: 'Headache Relief', shortDescription: 'For headaches', description: 'Detailed text', protocolType: 'hand' }
      );
      assert.deepEqual(r.json.category, { slug: 'public-cat', name: 'Public Cat', description: '' });
      assert.deepEqual(r.json.conditions.map((c) => c.slug), ['public-condition']);
      assert.deepEqual(r.json.searchTerms, ['migraine', 'one-sided headache', 'severe headache']);
      assert.deepEqual(r.json.metadata, { audience: 'adults' }, 'only metadata.public is exposed');
      assert.equal(r.json.version.number, (await h.row('SELECT v.version FROM protocols p JOIN protocol_versions v ON v.id = p.published_version_id WHERE p.id = $1', pub.id)).version);
      assert.match(r.json.version.publishedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.deepEqual(r.json.views.map((v) => [v.viewKey, v.label, v.handSide, v.objectCount]), [['left_front', 'Left Front', 'left', 2], ['right_front', 'Right Front', 'right', 0], ['left_back', 'Left Back', 'left', 0], ['right_back', 'Right Back', 'right', 1]]);
      assert.equal(r.json.links.render, '/api/public/protocols/headache-relief-protocol/render');
    });

    it('GET .../render returns the structured, renderable data: four views, canvas metadata, objects with every property', async () => {
      const r = await h.anon.get(`${P}/headache-relief-protocol/render`);
      assert.equal(r.status, 200);
      assert.equal(r.json.contract, 'protocol-render/1');
      assert.deepEqual(Object.keys(r.json).sort(), ['canvases', 'contract', 'protocol']);
      assert.equal(r.json.protocol.slug, 'headache-relief-protocol');
      assert.equal(r.json.canvases.length, 4);
      const [front] = r.json.canvases;
      assert.deepEqual(Object.keys(front).sort(), ['background', 'canvasType', 'handSide', 'height', 'label', 'objects', 'sortOrder', 'viewKey', 'width']);
      assert.deepEqual([front.viewKey, front.canvasType, front.label, front.handSide, front.width, front.height], ['left_front', 'hand', 'Left Front', 'left', 1586, 1982]);
      assert.deepEqual(front.background, { assetKey: 'left_front', url: '/static/hands/left_front.png' });
      assert.deepEqual(r.json.canvases.map((c) => c.viewKey), ['left_front', 'right_front', 'left_back', 'right_back']);

      const OBJECT_KEYS = ['color', 'finger', 'height', 'id', 'landmarkReference', 'metadata', 'opacity', 'points', 'rotation', 'thickness', 'type', 'width', 'x', 'y', 'zIndex'];
      front.objects.forEach((o) => assert.deepEqual(Object.keys(o).sort(), OBJECT_KEYS));
      const d = front.objects.find((o) => o.id === 'pub-dot');
      assert.deepEqual([d.type, d.x, d.y, d.width, d.color], ['dot', 0.4578, 0.4983, 0.03, '#e5484d'], 'normalized coordinates exactly as saved');
      assert.equal(d.finger, 'little', 'the legacy finger name is presented in its canonical form');
      assert.deepEqual(d.landmarkReference, { start: 5, end: 6, t: 0.3 }, 'AR landmark data is carried');
      assert.deepEqual(d.metadata, { sizePreset: 'medium', scale: 0.8 }, 'size/scale/future fields travel in metadata');
      const ring = front.objects.find((o) => o.id === 'pub-ring');
      assert.deepEqual([ring.type, ring.thickness, ring.opacity, ring.color], ['ring', 4, 0.8, '#1a73e8']);
      assert.deepEqual(r.json.canvases[3].objects.map((o) => [o.type, o.width, o.height, o.rotation]), [['rectangle', 0.16, 0.1, 15]]);
    });

    it('never exposes internal ids, owners, patients, status, versions, checksums or non-public metadata', async () => {
      for (const path of [`${P}/headache-relief-protocol`, `${P}/headache-relief-protocol/render`, P]) {
        const r = await h.anon.get(path);
        assert.equal(r.status, 200);
        for (const secret of ids) assert.ok(!r.text.includes(secret), `${path} leaks ${secret}`);
        for (const secret of ['TOP-SECRET-INTERNAL-NOTE', 'INTERNAL PUBLISH NOTE']) assert.ok(!r.text.includes(secret), `${path} leaks ${secret}`);
        assert.ok(!/"(status|publishedVersionId|doctorId|ownerId|patient|checksum|createdBy|currentVersion|versions|hasUnpublishedChanges|lifecycle)"/i.test(r.text), `${path} exposes an internal field`);
      }
      // the only uuids allowed are none at all: object ids in this test are readable strings
      assert.equal((await h.anon.get(`${P}/headache-relief-protocol/render`)).text.match(UUID_RE), null);
    });

    it('GET /api/public/categories lists only categories that have a PUBLISHED protocol, and needs no login', async () => {
      const draftOnlyCat = (await h.admin.post(`${A}/categories`, { name: 'Draft Only Category' })).json;
      await h.admin.post(`${A}/protocols`, { name: 'Never published', categoryId: draftOnlyCat.id });

      const r = await h.anon.get('/api/public/categories');
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.json));
      assert.deepEqual(r.json.find((c) => c.slug === 'public-cat'), { slug: 'public-cat', name: 'Public Cat' }, 'the category of our published protocol is present');
      assert.equal(r.json.some((c) => c.slug === draftOnlyCat.slug), false, 'a category with only a draft protocol is not listed');
      assert.deepEqual(Object.keys(r.json[0]).sort(), ['name', 'slug']);
    });

    it('draft, in-review, archived and unknown protocols all get the SAME 404 (nothing can be probed); an admin session sees nothing extra publicly', async () => {
      const draft = await newProtocol('Secret Draft Protocol');
      const review = await newProtocol('Secret Review Protocol'); await h.admin.post(`${A}/protocols/${review.id}/status`, { status: 'in_review' });
      const arch = await newProtocol('Secret Archived Protocol'); await h.admin.post(`${A}/protocols/${arch.id}/publish`, {}); await h.admin.post(`${A}/protocols/${arch.id}/archive`);
      const unknown = await h.anon.get(`${P}/no-such-protocol`);
      assert.equal(unknown.status, 404);
      for (const slug of [draft.slug, review.slug, arch.slug]) {
        for (const suffix of ['', '/render']) {
          for (const client of [h.anon, h.admin, h.doctor, h.patient]) {
            const r = await client.get(`${P}/${slug}${suffix}`);
            assert.equal(r.status, 404, `${slug}${suffix}`);
            assert.equal(r.text, unknown.text.replace('no-such-protocol', slug), 'identical body to an unknown slug');
          }
        }
      }
      const list = (await h.anon.get(`${P}?limit=100`)).json;
      for (const slug of [draft.slug, review.slug, arch.slug]) assert.ok(!list.items.some((i) => i.slug === slug), `${slug} must not be listed`);
    });

    it('exposes no version history and no mutation endpoints on the public side', async () => {
      const base = `${P}/headache-relief-protocol`;
      for (const path of [`${base}/versions`, `${base}/versions/1`, `${base}/history`, '/api/public/versions', `${base}/publish`, '/api/public/admin/protocols']) {
        assert.equal((await h.anon.get(path)).status, 404, path);
      }
      for (const method of ['POST', 'PUT', 'DELETE']) {
        for (const path of [P, base, `${base}/render`, `${base}/publish`]) {
          const r = await h.admin.request(method, path, method === 'DELETE' ? undefined : { name: 'x' });
          assert.equal(r.status, 404, `${method} ${path} must not exist`);
        }
      }
      assert.equal((await h.row('SELECT COUNT(*) c FROM protocols WHERE name = $1', 'x')).c, 0);
    });

    it('hostile slugs get a clean 404, never a 500 or data', async () => {
      for (const slug of ['..%2f..%2fetc%2fpasswd', '%00', "'; DROP TABLE protocols;--", '<script>alert(1)</script>', 'A'.repeat(500), 'UPPERCASE', '%E0%A4%A']) {
        const r = await h.anon.get(`${P}/${slug}`);
        assert.ok([400, 404].includes(r.status), `${slug} -> ${r.status}`);
      }
      assert.ok((await h.row('SELECT COUNT(*) c FROM protocols')).c > 0, 'the table still exists');
    });

    it('the browser list: only published, useful summary fields, search via terms, filters, pagination, tolerant of bad parameters', async () => {
      const all = (await h.anon.get(`${P}?limit=100`)).json;
      const item = all.items.find((i) => i.slug === 'headache-relief-protocol');
      assert.deepEqual(Object.keys(item).sort(), ['category', 'conditions', 'displayName', 'name', 'shortDescription', 'slug', 'version']);
      assert.deepEqual(Object.keys(all).sort(), ['items', 'limit', 'offset', 'total']);

      assert.ok((await h.anon.get(`${P}?q=severe%20headache`)).json.items.some((i) => i.slug === 'headache-relief-protocol'));
      assert.ok((await h.anon.get(`${P}?q=MIGRAINE`)).json.items.some((i) => i.slug === 'headache-relief-protocol'));
      assert.equal((await h.anon.get(`${P}?q=zzzzqqqq`)).json.total, 0);
      assert.deepEqual((await h.anon.get(`${P}?category=public-cat`)).json.items.map((i) => i.slug), ['headache-relief-protocol']);
      assert.deepEqual((await h.anon.get(`${P}?condition=public-condition`)).json.items.map((i) => i.slug), ['headache-relief-protocol']);
      assert.equal((await h.anon.get(`${P}?category=does-not-exist`)).json.total, 0);
      const page = (await h.anon.get(`${P}?limit=1&offset=0`)).json;
      assert.deepEqual([page.items.length, page.limit], [1, 1]);
      for (const bad of ['?limit=abc', '?limit=-5', '?offset=zzz', '?q=' + 'x'.repeat(5000), '?category=%00']) assert.equal((await h.anon.get(P + bad)).status, 200, bad);
    });

    it('editing the DRAFT after publishing does not change the public responses by a single byte; publishing again does', async () => {
      const grab = async () => (await Promise.all([`${P}/headache-relief-protocol`, `${P}/headache-relief-protocol/render`, `${P}?q=migraine`].map((u) => h.anon.get(u)))).map((r) => r.text).join('\n----\n');
      const before = await grab();

      // edits through every path available: builder save, admin metadata, terms, conditions, category
      const cur = (await h.admin.get(`${A}/protocols/${pub.id}`)).json;
      await h.admin.post(`/api/protocols/${pub.id}/save`, { canvases: [{ id: cur.canvases[0].id, objects: [dot({ id: 'draft-only', x: 0.9, color: '#00ff00' })] }] });
      await h.admin.put(`${A}/protocols/${pub.id}`, { name: 'DRAFT-ONLY NAME', displayName: 'DRAFT-ONLY', shortDescription: 'DRAFT-ONLY TEXT', metadata: { public: { audience: 'DRAFT-ONLY' } } });
      await h.admin.post(`${A}/protocols/${pub.id}/search-terms`, { term: 'draft-only term' });
      const cond2 = (await h.admin.post(`${A}/conditions`, { name: 'Draft Only Condition' })).json;
      await h.admin.post(`${A}/conditions/${cond2.id}/protocols`, { protocolId: pub.id });

      assert.equal(await grab(), before);
      assert.ok(!before.includes('DRAFT-ONLY') && !before.toLowerCase().includes('draft-only'));
      assert.equal((await h.anon.get(`${P}?q=draft-only`)).json.total, 0, 'draft-only terms are not searchable');
      const now = (await h.admin.get(`${A}/protocols/${pub.id}`)).json;
      assert.deepEqual([now.status, now.hasUnpublishedChanges], ['published', true]);

      assert.equal((await h.admin.post(`${A}/protocols/${pub.id}/publish`, {})).status, 201);
      const after = await grab();
      assert.notEqual(after, before);
      assert.ok(after.includes('DRAFT-ONLY TEXT'));
    });

    // Placed last in this describe block deliberately: it publishes a SECOND protocol into "public-cat",
    // which would otherwise throw off the exact single-item assertions earlier tests here make for that category.
    it('a category with two published protocols appears exactly once', async () => {
      const catId = (await h.admin.get(`${A}/protocols/${pub.id}`)).json.categoryId;
      const second = await newProtocol('Second Headache Protocol', { categoryId: catId });
      const published = await h.admin.post(`${A}/protocols/${second.id}/publish`, {});
      assert.equal(published.status, 201, published.text);
      const r = await h.anon.get('/api/public/categories');
      assert.equal(r.json.filter((c) => c.slug === 'public-cat').length, 1);
    });
  });

  // ------------------------------------------------------------------------ flags
  describe('feature flags gate the new APIs (the backend enforces them)', () => {
    async function withFlag(key, fn) {
      const { createFeatureFlagService } = require('../src/services/featureFlags'); // eslint-disable-line global-require
      const flags = createFeatureFlagService(h.db);
      await flags.setFlag(key, false);
      try { await fn(); } finally { await flags.setFlag(key, true); }
    }
    it('WEBSITE off or PROTOCOL_BROWSER off -> the public API answers 404', async () => {
      const slug = 'headache-relief-protocol';
      assert.equal((await h.anon.get(`${P}/${slug}`)).status, 200);
      for (const flag of ['WEBSITE', 'PROTOCOL_BROWSER']) {
        await withFlag(flag, async () => {
          for (const path of [P, `${P}/${slug}`, `${P}/${slug}/render`]) assert.equal((await h.anon.get(path)).status, 404, `${flag} off: ${path}`);
        });
      }
      assert.equal((await h.anon.get(`${P}/${slug}`)).status, 200, 'and it comes back when the flag is on again');
    });
    it('ADMIN off -> the admin API answers 404 for admins, while anonymous callers still get 401 (flags cannot be probed)', async () => {
      await withFlag('ADMIN', async () => {
        assert.equal((await h.admin.get(`${A}/protocols`)).status, 404);
        assert.equal((await h.admin.get(`${A}/categories`)).status, 404);
        assert.equal((await h.anon.get(`${A}/protocols`)).status, 401);
        assert.equal((await h.admin.get('/api/protocols')).status, 200, 'the existing builder API is governed by PROTOCOL_STUDIO, not ADMIN');
      });
      assert.equal((await h.admin.get(`${A}/protocols`)).status, 200);
    });
  });

  // -------------------------------------------------------- existing (legacy) API
  describe('existing builder and patient APIs keep working with the new lifecycle', () => {
    it('legacy create returns a draft with a slug and the extended fields; legacy save records a complete schema-2 checkpoint', async () => {
      const c = await h.doctor.post('/api/protocols', { name: 'Legacy Create', description: 'd', protocolType: 'hand' });
      assert.equal(c.status, 201);
      assert.deepEqual([c.json.status, c.json.slug, c.json.publishedVersionId, c.json.currentVersion], ['draft', 'legacy-create', null, 1]);
      const save = await h.doctor.post(`/api/protocols/${c.json.id}/save`, { canvases: [{ id: c.json.canvases[0].id, objects: [dot({ id: 'legacy-o', finger: 'pinky' })] }] });
      assert.equal(save.status, 200);
      assert.equal(save.json.currentVersion, 2);
      assert.equal(save.json.canvases[0].objects[0].finger, 'little');
      const v = (await h.admin.get(`${A}/protocols/${c.json.id}/versions/2`)).json;
      assert.equal(v.schemaVersion, 2);
      assert.equal(v.integrity.valid, true);
      assert.equal(v.snapshot.protocol.slug, 'legacy-create');
      assert.equal(v.snapshot.canvases[0].objects[0].id, 'legacy-o');
      assert.deepEqual([v.createdBy, v.kind], ['doc-1', 'checkpoint']);
    });

    it('legacy status changes follow the lifecycle: draft/active/archived still work; "published" is refused; a published protocol cannot be moved back', async () => {
      const p = (await h.doctor.post('/api/protocols', { name: 'Legacy Status', protocolType: 'hand' })).json;
      assert.equal((await h.doctor.put(`/api/protocols/${p.id}`, { status: 'active' })).json.status, 'active');
      assert.equal((await h.doctor.put(`/api/protocols/${p.id}`, { status: 'draft' })).json.status, 'draft');
      assert.equal((await h.doctor.put(`/api/protocols/${p.id}`, { status: 'archived' })).json.status, 'archived');
      assert.equal((await h.doctor.put(`/api/protocols/${p.id}`, { status: 'draft' })).json.status, 'draft');
      assert.equal((await h.doctor.put(`/api/protocols/${p.id}`, { status: 'published' })).status, 400);
      assert.equal((await h.doctor.put(`/api/protocols/${p.id}`, { status: 'whatever' })).json.status, 'draft', 'unrecognised values are ignored, as before');
      assert.equal((await h.doctor.put(`/api/protocols/${p.id}`, { name: 'Legacy Renamed' })).json.name, 'Legacy Renamed');

      const live = await newProtocol('Legacy Published');
      await h.admin.post(`${A}/protocols/${live.id}/publish`, {});
      assert.equal((await h.admin.put(`/api/protocols/${live.id}`, { status: 'draft' })).status, 409, 'the builder dropdown cannot silently unpublish');
      assert.equal((await h.anon.get(`${P}/${live.slug}`)).status, 200);
      assert.equal((await h.admin.put(`/api/protocols/${live.id}`, { status: 'archived' })).json.status, 'archived');
      assert.equal((await h.anon.get(`${P}/${live.slug}`)).status, 404);
    });

    it('legacy delete: a never-published protocol is deleted; a published/archived-after-published one is refused with 409', async () => {
      const d = (await h.doctor.post('/api/protocols', { name: 'Legacy Delete', protocolType: 'hand' })).json;
      assert.equal((await h.doctor.delete(`/api/protocols/${d.id}`)).status, 200);
      const p = await newProtocol('Legacy Undeletable');
      await h.admin.post(`${A}/protocols/${p.id}/publish`, {});
      const versionsBefore = (await counts()).versions;
      assert.equal((await h.admin.delete(`/api/protocols/${p.id}`)).status, 409);
      await h.admin.post(`${A}/protocols/${p.id}/archive`);
      assert.equal((await h.admin.delete(`/api/protocols/${p.id}`)).status, 409);
      assert.equal((await counts()).versions, versionsBefore, 'history untouched');
    });

    it('legacy duplicate uses the same behaviour: new ids, new slug, draft, no published pointer', async () => {
      const p = await newProtocol('Legacy Dup Source');
      await h.admin.post(`${A}/protocols/${p.id}/publish`, {});
      const d = await h.admin.post(`/api/protocols/${p.id}/duplicate`);
      assert.equal(d.status, 201);
      assert.deepEqual([d.json.status, d.json.slug, d.json.publishedVersionId, d.json.currentVersion], ['draft', 'legacy-dup-source-copy', null, 1]);
      const srcIds = new Set((await h.rows('SELECT o.id FROM objects o JOIN canvases c ON c.id = o.canvas_id WHERE c.protocol_id = $1', p.id)).map((r) => r.id));
      d.json.canvases.flatMap((c) => c.objects).forEach((o) => assert.ok(!srcIds.has(o.id)));
    });

    it('patient responses are unchanged: no slug, publishing or metadata fields leak into what a patient receives', async () => {
      const doc = (await h.doctor.post('/api/protocols', { name: 'For Patient', protocolType: 'hand' })).json;
      await h.doctor.put(`/api/protocols/${doc.id}`, { status: 'active' });
      const assigned = await h.doctor.post(`/api/protocols/${doc.id}/assign`, { patientEmail: 'patient@example.com' });
      assert.equal(assigned.status, 200, assigned.text);
      const detail = await h.patient.get(`/api/patient/protocols/${doc.id}`);
      assert.equal(detail.status, 200);
      for (const key of ['slug', 'displayName', 'shortDescription', 'categoryId', 'metadata', 'publishedVersionId', 'publishedAt']) assert.ok(!(key in detail.json), `patient response gained "${key}"`);
      assert.equal(detail.json.canvases.length, 4);
      const list = (await h.patient.get('/api/patient/protocols')).json;
      assert.ok(list.every((p) => !('slug' in p) && !('publishedVersionId' in p)));
      assert.equal((await h.patient.get(`${A}/protocols`)).status, 403);
    });

    it('an unexpected server error never leaks its internal message', async () => {
      const r = await h.admin.put(`${A}/protocols/x`, { metadata: 'not-an-object' });
      assert.ok(r.status < 500, 'validation problems are 4xx');
      assert.ok(!/SQLITE|stack|at Object\./i.test(r.text));
    });
  });
});
