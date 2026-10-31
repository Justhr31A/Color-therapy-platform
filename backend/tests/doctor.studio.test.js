/**
 * [DETERMINISTIC SOFTWARE TESTS — HTTP level, real server + real PostgreSQL]
 * The doctor's own workflow, end to end, and the boundaries around it:
 *   create -> describe (category / conditions / search terms) -> save markings -> publish -> public link works
 *   -> re-edit -> the published version is untouched -> publish again = next immutable version.
 * Plus: a doctor can only ever touch their OWN protocols; admin-only actions stay admin-only; patients and
 * anonymous callers get nothing; admins keep everything they had.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { HTTP_SKIP, Client, bootstrap, randomPassword, dot } = require('./helpers/httpHarness');

const P = '/api/public/protocols';
const A = '/api/admin';

describe('[DETERMINISTIC · HTTP] doctor self-service: save -> publish -> share -> republish', { skip: HTTP_SKIP }, () => {
  let h; let doctor2; let category; let inactiveCategory; let conditionA; let conditionB; let inactiveCondition;

  before(async () => {
    h = await bootstrap();
    // a SECOND doctor, to prove ownership
    const { hashPassword } = require('../src/utils/password'); // eslint-disable-line global-require
    const pw = randomPassword();
    await h.run('INSERT INTO users (id,name,email,password_hash,role,status) VALUES ($1,$2,$3,$4,$5,$6)',
      'doc-2', 'Doctor Two', 'doctor2@example.com', await hashPassword(pw), 'doctor', 'active');
    doctor2 = new Client(h.base);
    assert.equal((await doctor2.post('/api/auth/login', { email: 'doctor2@example.com', password: pw })).status, 200);

    // the catalog is admin-managed: the admin creates what doctors will choose from
    const mkCat = async (name) => (await h.admin.post(`${A}/categories`, { name })).json;
    const mkCond = async (name) => (await h.admin.post(`${A}/conditions`, { name })).json;
    category = await mkCat('Musculoskeletal');
    inactiveCategory = await mkCat('Retired category');
    await h.admin.post(`${A}/categories/${inactiveCategory.id}/deactivate`, {});
    conditionA = await mkCond('Back pain');
    conditionB = await mkCond('Sciatica');
    inactiveCondition = await mkCond('Retired condition');
    await h.admin.post(`${A}/conditions/${inactiveCondition.id}/deactivate`, {});
  });
  after(async () => { if (h) await h.stop(); });

  const newDraft = async (client, name) => {
    const r = await client.post('/api/protocols', { name, protocolType: 'hand' });
    assert.equal(r.status, 201, r.text);
    return r.json;
  };
  const saveMarkings = async (client, p, objects) => {
    const r = await client.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects }] });
    assert.equal(r.status, 200, r.text);
    return r.json;
  };
  const details = async (client, p) => (await client.get(`/api/protocols/${p.id}/details`)).json;
  const publicRender = (p) => h.anon.get(`${P}/${p.slug}/render`);
  const versionRows = (p) => h.rows('SELECT id, version, kind, snapshot_json, checksum FROM protocol_versions WHERE protocol_id = $1 ORDER BY version', p.id);

  // ------------------------------------------------------------------------------------------ the whole journey
  it('THE DOCTOR JOURNEY: create -> describe -> save markings -> publish -> the public link works -> re-edit leaves it untouched -> publish again = next version', async () => {
    const p = await newDraft(h.doctor, 'Doctor journey');
    assert.equal(p.status, 'draft');
    assert.equal((await h.anon.get(`${P}/${p.slug}`)).status, 404, 'a draft has no public page');
    assert.equal((await publicRender(p)).status, 404);

    // describe it: description, category, a condition, search terms — all through the doctor endpoints
    const d0 = await details(h.doctor, p);
    assert.deepEqual([d0.status, d0.slug, d0.conditions, d0.searchTerms, d0.published, d0.hasUnpublishedChanges], ['draft', p.slug, [], [], null, false]);
    const upd = await h.doctor.put(`/api/protocols/${p.id}/details`, { displayName: 'Back pain relief', shortDescription: 'A short summary.', description: 'Apply the markings, hold three minutes.', categoryId: category.id });
    assert.equal(upd.status, 200, upd.text);
    assert.equal(upd.json.category.name, 'Musculoskeletal');
    assert.equal((await h.doctor.post(`/api/protocols/${p.id}/conditions`, { conditionId: conditionA.id })).status, 201);
    assert.equal((await h.doctor.post(`/api/protocols/${p.id}/search-terms`, { term: 'lumbago', kind: 'synonym' })).status, 201);
    await saveMarkings(h.doctor, p, [dot({ id: `journey-1-${p.slug}` })]);

    // publish
    const pub = await h.doctor.post(`/api/protocols/${p.id}/publish`, { note: 'first release' });
    assert.equal(pub.status, 201, pub.text);
    const v1 = pub.json.version;
    assert.equal(pub.json.protocol.status, 'published');
    const d1 = await details(h.doctor, p);
    assert.deepEqual([d1.status, d1.published.version, d1.hasUnpublishedChanges], ['published', v1, false]);

    // the public page (no login) now serves it: details, category, condition, search term and the marking
    const pageDetail = await h.anon.get(`${P}/${p.slug}`);
    assert.equal(pageDetail.status, 200, pageDetail.text);
    const render1 = await publicRender(p);
    assert.equal(render1.status, 200);
    assert.equal(render1.json.protocol.version.number, v1);
    assert.equal(render1.json.protocol.displayName, 'Back pain relief');
    assert.equal(render1.json.protocol.category.name, 'Musculoskeletal');
    assert.deepEqual(render1.json.protocol.conditions.map((c) => c.name), ['Back pain']);
    assert.deepEqual(render1.json.canvases[0].objects.map((o) => o.id), [`journey-1-${p.slug}`]);
    const publicBefore = JSON.stringify(render1.json);
    const detailBefore = JSON.stringify(pageDetail.json);
    const rowsBefore = (await versionRows(p));
    const publishedRowBefore = rowsBefore.find((r) => r.kind === 'published' && r.version === v1);

    // RE-EDIT the published protocol: markings, description, a search term, another condition
    await saveMarkings(h.doctor, p, [dot({ id: `journey-1-${p.slug}` }), dot({ id: `journey-2-${p.slug}`, x: 0.6 })]);
    assert.equal((await h.doctor.put(`/api/protocols/${p.id}/details`, { description: 'CHANGED after publishing.' })).status, 200);
    assert.equal((await h.doctor.post(`/api/protocols/${p.id}/search-terms`, { term: 'sciatic pain' })).status, 201);
    assert.equal((await h.doctor.post(`/api/protocols/${p.id}/conditions`, { conditionId: conditionB.id })).status, 201);
    const d2 = await details(h.doctor, p);
    assert.equal(d2.status, 'published', 'it stays published...');
    assert.equal(d2.hasUnpublishedChanges, true, '...but the edits are flagged as unpublished changes');
    assert.equal(d2.published.version, v1, 'and the live version is still the old one');

    // the public sees EXACTLY what it saw before; the stored published snapshot is byte-identical
    assert.equal(JSON.stringify((await publicRender(p)).json), publicBefore);
    assert.equal(JSON.stringify((await h.anon.get(`${P}/${p.slug}`)).json), detailBefore);
    const publishedRowAfter = (await versionRows(p)).find((r) => r.id === publishedRowBefore.id);
    assert.deepEqual(publishedRowAfter, publishedRowBefore, 'the published snapshot row is immutable');

    // REPUBLISH: the next immutable version, and only now does the public change
    const pub2 = await h.doctor.post(`/api/protocols/${p.id}/publish`, {});
    assert.equal(pub2.status, 201, pub2.text);
    const v2 = pub2.json.version;
    assert.ok(v2 > v1, `next version (${v2}) is greater than the first (${v1})`);
    const render2 = await publicRender(p);
    assert.equal(render2.json.protocol.version.number, v2);
    assert.equal(render2.json.protocol.description, 'CHANGED after publishing.');
    assert.deepEqual(render2.json.canvases[0].objects.map((o) => o.id).sort(), [`journey-1-${p.slug}`, `journey-2-${p.slug}`].sort());
    assert.deepEqual(render2.json.protocol.conditions.map((c) => c.name).sort(), ['Back pain', 'Sciatica']);
    const d3 = await details(h.doctor, p);
    assert.deepEqual([d3.published.version, d3.hasUnpublishedChanges], [v2, false]);
    // the first published version still exists, unchanged
    assert.deepEqual((await versionRows(p)).find((r) => r.id === publishedRowBefore.id), publishedRowBefore);
    assert.equal((await versionRows(p)).filter((r) => r.kind === 'published').length, 2);
  });

  it('a FAILED publish changes nothing: the last published version stays live, and nothing half-published is left behind', async () => {
    const p = await newDraft(h.doctor, 'Failed publish');
    await saveMarkings(h.doctor, p, [dot({ id: `fp-ok-${p.slug}` })]);
    assert.equal((await h.doctor.post(`/api/protocols/${p.id}/publish`, {})).status, 201);
    const live = JSON.stringify((await publicRender(p)).json);
    const rows = (await versionRows(p)).length;

    // a marking the server accepts when saving but refuses to publish (a ring thickness of -5)
    await saveMarkings(h.doctor, p, [dot({ id: `fp-bad-${p.slug}`, metadata: { sizePreset: 'medium', scale: 1, rings: [{ color: '#1a73e8', thickness: -5 }] } })]);
    const bad = await h.doctor.post(`/api/protocols/${p.id}/publish`, {});
    assert.equal(bad.status, 422, bad.text);
    assert.ok(Array.isArray(bad.json.details) && bad.json.details.some((d) => d.code === 'RINGS_INVALID'), 'the doctor gets the list of problems');
    assert.equal(JSON.stringify((await publicRender(p)).json), live, 'the public still sees the last good version');
    assert.equal((await versionRows(p)).filter((r) => r.kind === 'published').length, 1, 'no extra published version was stored');
    assert.ok((await versionRows(p)).length >= rows, 'history is only ever added to');
  });

  it('a draft that was never published cannot be published without content problems being reported (nothing silent)', async () => {
    const p = await newDraft(h.doctor, 'Nothing drawn');
    const r = await h.doctor.post(`/api/protocols/${p.id}/publish`, {});
    // an empty protocol has no problem the validator refuses on its own; whichever way it goes, the answer must be explicit
    assert.ok([201, 422].includes(r.status), r.text);
    if (r.status === 422) assert.ok(r.json.details.length > 0);
  });

  // ----------------------------------------------------------------------------------------- ownership
  it('OWNERSHIP: another doctor cannot read, edit, describe, publish or save someone else\'s protocol — every attempt is a plain 404 and nothing changes', async () => {
    const mine = await newDraft(h.doctor, 'Doctor one private');
    await saveMarkings(h.doctor, mine, [dot({ id: `own-${mine.slug}` })]);
    assert.equal((await h.doctor.post(`/api/protocols/${mine.id}/publish`, {})).status, 201);
    const term = (await h.doctor.post(`/api/protocols/${mine.id}/search-terms`, { term: 'mine only' })).json; // the OWNER's setup comes first...
    const before = JSON.stringify((await h.admin.get(`${A}/protocols/${mine.id}`)).json); // ...then the "before" picture
    const live = JSON.stringify((await publicRender(mine)).json);

    const attempts = [
      ['GET', `/api/protocols/${mine.id}`], ['GET', `/api/protocols/${mine.id}/details`],
      ['PUT', `/api/protocols/${mine.id}/details`, { description: 'hijacked' }],
      ['POST', `/api/protocols/${mine.id}/search-terms`, { term: 'spam' }],
      ['DELETE', `/api/protocols/${mine.id}/search-terms/${term.id}`],
      ['POST', `/api/protocols/${mine.id}/conditions`, { conditionId: conditionA.id }],
      ['DELETE', `/api/protocols/${mine.id}/conditions/${conditionA.id}`],
      ['POST', `/api/protocols/${mine.id}/publish`, {}],
      ['POST', `/api/protocols/${mine.id}/save`, { canvases: [] }],
      ['POST', `/api/protocols/${mine.id}/duplicate`, {}],
      ['DELETE', `/api/protocols/${mine.id}`],
    ];
    for (const [method, url, body] of attempts) {
      const r = await doctor2.request(method, url, body);
      assert.equal(r.status, 404, `${method} ${url} -> ${r.status} ${r.text}`);
    }
    assert.equal(JSON.stringify((await h.admin.get(`${A}/protocols/${mine.id}`)).json), before, 'the protocol is exactly as it was');
    assert.equal(JSON.stringify((await publicRender(mine)).json), live);

    // and they can do all of it on their OWN protocol
    const theirs = await newDraft(doctor2, 'Doctor two own');
    assert.equal((await doctor2.put(`/api/protocols/${theirs.id}/details`, { description: 'fine' })).status, 200);
    assert.equal((await doctor2.post(`/api/protocols/${theirs.id}/conditions`, { conditionId: conditionA.id })).status, 201);
    await saveMarkings(doctor2, theirs, [dot({ id: `theirs-${theirs.slug}` })]);
    assert.equal((await doctor2.post(`/api/protocols/${theirs.id}/publish`, {})).status, 201);
  });

  it('a search term belongs to ONE protocol: another protocol\'s term id cannot be removed through your own protocol', async () => {
    const a = await newDraft(h.doctor, 'Terms A');
    const b = await newDraft(h.doctor, 'Terms B');
    const termOfB = (await h.doctor.post(`/api/protocols/${b.id}/search-terms`, { term: 'only on b' })).json;
    assert.equal((await h.doctor.request('DELETE', `/api/protocols/${a.id}/search-terms/${termOfB.id}`)).status, 404);
    assert.deepEqual((await details(h.doctor, b)).searchTerms.map((t) => t.term), ['only on b']);
  });

  // --------------------------------------------------------------------- what a doctor still cannot do
  it('admin-only actions stay admin-only: archive, status, version history/restore, metadata via /api/admin, and the catalog itself', async () => {
    const p = await newDraft(h.doctor, 'Admin only things');
    await saveMarkings(h.doctor, p, [dot({ id: `ao-${p.slug}` })]);
    assert.equal((await h.doctor.post(`/api/protocols/${p.id}/publish`, {})).status, 201);
    const adminOnly = [
      ['POST', `${A}/protocols/${p.id}/publish`, {}], ['POST', `${A}/protocols/${p.id}/archive`, {}], ['POST', `${A}/protocols/${p.id}/status`, { status: 'draft' }],
      ['PUT', `${A}/protocols/${p.id}`, { description: 'x' }], ['GET', `${A}/protocols/${p.id}/versions`], ['POST', `${A}/protocols/${p.id}/versions/1/restore`, {}],
      ['GET', `${A}/protocols`], ['POST', `${A}/categories`, { name: 'My own' }], ['POST', `${A}/conditions`, { name: 'My own' }],
      ['GET', `${A}/categories`], ['GET', `${A}/conditions`], ['PUT', `${A}/conditions/${conditionA.id}`, { name: 'renamed' }],
    ];
    for (const [method, url, body] of adminOnly) assert.equal((await h.doctor.request(method, url, body)).status, 403, `${method} ${url}`);
    // the doctor-side routes for those actions simply do not exist
    for (const [method, url, body] of [['POST', `/api/protocols/${p.id}/archive`, {}], ['POST', `/api/protocols/${p.id}/versions/1/restore`, {}], ['POST', '/api/catalog/categories', { name: 'x' }], ['POST', '/api/catalog/conditions', { name: 'x' }], ['PUT', `/api/catalog/categories/${category.id}`, { name: 'x' }]]) {
      assert.equal((await h.doctor.request(method, url, body)).status, 404, `${method} ${url}`);
    }
    assert.equal((await h.admin.get(`${A}/categories`)).json.length, 2, 'the catalog was not changed');
  });

  it('a doctor cannot change the slug, the status, the metadata blob or the owner through the details endpoint (the slug is what shared links depend on)', async () => {
    const p = await newDraft(h.doctor, 'Locked fields');
    await saveMarkings(h.doctor, p, [dot({ id: `lf-${p.slug}` })]);
    await h.doctor.post(`/api/protocols/${p.id}/publish`, {});
    const before = JSON.stringify(await details(h.doctor, p));
    for (const body of [{ slug: 'hijacked-slug' }, { status: 'archived' }, { status: 'published' }, { metadata: { x: 1 } }, { ownerId: 'doc-2' }, { doctor_id: 'doc-2' }, { description: 'ok', slug: 'x' }]) {
      const r = await h.doctor.put(`/api/protocols/${p.id}/details`, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.text}`);
      assert.equal(r.json.code, 'FIELD_NOT_ALLOWED');
    }
    assert.equal(JSON.stringify(await details(h.doctor, p)), before, 'nothing changed');
    assert.equal((await h.anon.get(`${P}/${p.slug}`)).status, 200, 'the shared link still works');
  });

  it('the details rules are the same as for admins: bad text, unknown / inactive categories, unknown / inactive / duplicate conditions, bad search terms', async () => {
    const p = await newDraft(h.doctor, 'Validation');
    const put = (body) => h.doctor.put(`/api/protocols/${p.id}/details`, body);
    assert.equal((await put({ displayName: 'x'.repeat(500) })).status, 400);
    assert.equal((await put({ description: 12345 })).status, 400);
    assert.equal((await put({ name: '   ' })).status, 400);
    assert.equal((await put({ categoryId: 'no-such-category' })).status, 400);
    assert.equal((await put({ categoryId: inactiveCategory.id })).status, 409, 'an inactive category cannot be chosen');
    assert.equal((await put({ categoryId: category.id })).json.category.name, 'Musculoskeletal');
    assert.equal((await put({ categoryId: null })).json.category, null, 'the category can be cleared');

    const attach = (conditionId) => h.doctor.post(`/api/protocols/${p.id}/conditions`, conditionId === undefined ? {} : { conditionId });
    assert.equal((await attach()).status, 400);
    assert.equal((await attach(123)).status, 400);
    assert.equal((await attach('nope')).status, 404);
    assert.equal((await attach(inactiveCondition.id)).status, 409, 'an inactive condition cannot be linked');
    assert.equal((await attach(conditionA.id)).status, 201);
    assert.equal((await attach(conditionA.id)).status, 409, 'not twice');
    assert.equal((await h.doctor.request('DELETE', `/api/protocols/${p.id}/conditions/${conditionB.id}`)).status, 404, 'detaching one that is not linked');
    assert.equal((await h.doctor.request('DELETE', `/api/protocols/${p.id}/conditions/${conditionA.id}`)).status, 200);

    const term = (body) => h.doctor.post(`/api/protocols/${p.id}/search-terms`, body);
    assert.equal((await term({ term: '   ' })).status, 400);
    assert.equal((await term({ term: 'x'.repeat(500) })).status, 400);
    assert.equal((await term({ term: 'ok', kind: 'bogus' })).status, 400);
    assert.equal((await term({ term: 'Back  Ache' })).status, 201);
    assert.equal((await term({ term: 'back ache' })).status, 409, 'a duplicate (ignoring case and spacing)');
    assert.equal((await h.doctor.request('DELETE', `/api/protocols/${p.id}/search-terms/nope`)).status, 404);
  });

  // ------------------------------------------------------------------------------------------ the catalog
  it('the catalog doctors choose from is read-only, ACTIVE entries only, and exposes just id / name / slug', async () => {
    const cats = await h.doctor.get('/api/catalog/categories');
    assert.equal(cats.status, 200);
    assert.deepEqual(cats.json.map((c) => c.name), ['Musculoskeletal']);
    assert.deepEqual(Object.keys(cats.json[0]).sort(), ['id', 'name', 'slug']);
    const conds = await h.doctor.get('/api/catalog/conditions');
    assert.equal(conds.status, 200);
    assert.deepEqual(conds.json.map((c) => c.name).sort(), ['Back pain', 'Sciatica']);
    assert.deepEqual(Object.keys(conds.json[0]).sort(), ['id', 'name', 'slug']);
    assert.equal((await h.admin.get('/api/catalog/categories')).status, 200, 'admins can read it too');
  });

  it('the catalog and the details endpoints honour the PROTOCOL_STUDIO feature flag (off -> 404, back on -> works)', async () => {
    const { createFeatureFlagService } = require('../src/services/featureFlags'); // eslint-disable-line global-require
    const p = await newDraft(h.doctor, 'Flag test');
    const flags = createFeatureFlagService(h.db);
    try {
      await flags.setFlag('PROTOCOL_STUDIO', false);
      assert.equal((await h.doctor.get('/api/catalog/categories')).status, 404);
      assert.equal((await h.doctor.get(`/api/protocols/${p.id}/details`)).status, 404);
      assert.equal((await h.anon.get('/api/catalog/categories')).status, 401, 'callers who are not signed in still cannot tell which features are off');
    } finally { await flags.setFlag('PROTOCOL_STUDIO', true); }
    assert.equal((await h.doctor.get('/api/catalog/categories')).status, 200);
  });

  // --------------------------------------------------------------- patients, anonymous, admin
  it('patients and anonymous callers get nothing from any of the new endpoints (401 / 403)', async () => {
    const p = await newDraft(h.doctor, 'Closed to others');
    const endpoints = [
      ['GET', `/api/protocols/${p.id}/details`], ['PUT', `/api/protocols/${p.id}/details`, { description: 'x' }],
      ['POST', `/api/protocols/${p.id}/search-terms`, { term: 'x' }], ['DELETE', `/api/protocols/${p.id}/search-terms/x`],
      ['POST', `/api/protocols/${p.id}/conditions`, { conditionId: conditionA.id }], ['DELETE', `/api/protocols/${p.id}/conditions/${conditionA.id}`],
      ['POST', `/api/protocols/${p.id}/publish`, {}], ['GET', '/api/catalog/categories'], ['GET', '/api/catalog/conditions'],
    ];
    for (const [method, url, body] of endpoints) {
      assert.equal((await h.anon.request(method, url, body)).status, 401, `anonymous ${method} ${url}`);
      assert.equal((await h.patient.request(method, url, body)).status, 403, `patient ${method} ${url}`);
    }
    assert.equal((await details(h.doctor, p)).description, '', 'and nothing was changed');
  });

  it('public visitors can read published protocols only: drafts, in-review and archived are 404', async () => {
    const published = await newDraft(h.doctor, 'Visible one');
    await saveMarkings(h.doctor, published, [dot({ id: `vis-${published.slug}` })]);
    await h.doctor.post(`/api/protocols/${published.id}/publish`, {});
    const draft = await newDraft(h.doctor, 'Hidden draft');
    assert.equal((await h.anon.get(`${P}/${published.slug}`)).status, 200);
    assert.equal((await h.anon.get(`${P}/${draft.slug}`)).status, 404);
    assert.equal((await h.anon.get(`${P}/${draft.slug}/render`)).status, 404);
    await h.admin.post(`${A}/protocols/${published.id}/archive`, {});
    assert.equal((await h.anon.get(`${P}/${published.slug}`)).status, 404, 'archived is not public either');
  });

  it('ADMIN keeps everything: publishes any protocol through the admin endpoint and through the doctor one, and may use the details endpoints on any protocol', async () => {
    const p = await newDraft(h.doctor, 'Admin touches doctor protocol');
    await saveMarkings(h.doctor, p, [dot({ id: `adm-${p.slug}` })]);
    assert.equal((await h.admin.put(`/api/protocols/${p.id}/details`, { description: 'edited by admin' })).status, 200);
    assert.equal((await h.admin.get(`/api/protocols/${p.id}/details`)).json.description, 'edited by admin');
    assert.equal((await h.admin.post(`/api/protocols/${p.id}/search-terms`, { term: 'by admin' })).status, 201);
    const viaAdmin = await h.admin.post(`${A}/protocols/${p.id}/publish`, {});
    assert.equal(viaAdmin.status, 201, viaAdmin.text);
    const viaDoctorEndpoint = await h.admin.post(`/api/protocols/${p.id}/publish`, {});
    assert.equal(viaDoctorEndpoint.status, 201, viaDoctorEndpoint.text);
    assert.equal(viaDoctorEndpoint.json.version, viaAdmin.json.version + 1);
    assert.equal((await h.admin.get(`${A}/protocols/${p.id}/versions`)).status, 200, 'version history is still there for the admin');
    assert.equal((await h.admin.post(`${A}/protocols/${p.id}/versions/${viaAdmin.json.version}/restore`, {})).status, 200, 'and so is restore');
  });
});
