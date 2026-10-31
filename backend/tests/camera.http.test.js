/**
 * [DETERMINISTIC SOFTWARE TESTS — HTTP level, real server.js + real PostgreSQL]
 * Public Camera (live AR): the availability switch and the data the camera page reads.
 *
 * Covers: OFF by default; only an administrator can switch it (CAMERA + AR together, in dependency order); the public
 * status reveals only one boolean; an anonymous visitor — no login, no patient assignment — can load any PUBLISHED
 * protocol's render data for the camera, and each protocol returns its OWN markings; drafts and unpublished edits
 * stay private; doctors can still edit and publish. Camera frames are never part of any API.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { HTTP_SKIP, bootstrap, dot } = require('./helpers/httpHarness');

const ADMIN_CAMERA = '/api/admin/camera';
const PUBLIC_STATUS = '/api/public/camera/status';
const render = (slug) => `/api/public/protocols/${slug}/render`;

describe('[DETERMINISTIC · HTTP] public Camera / AR', { skip: HTTP_SKIP }, () => {
  let h;
  let backPain;
  let anxiety;
  const flag = async (key) => (await h.row('SELECT enabled FROM feature_flags WHERE key = $1', key)).enabled;
  const setFlag = async (key, enabled) => {
    const { createFeatureFlagService } = require('../src/services/featureFlags'); // eslint-disable-line global-require
    await createFeatureFlagService(h.db).setFlag(key, enabled);
  };

  async function publishWith(name, objectsByView) {
    const p = (await h.doctor.post('/api/protocols', { name, protocolType: 'hand' })).json;
    const canvases = p.canvases.map((c) => ({ id: c.id, objects: objectsByView[c.viewKey] || [] }));
    assert.equal((await h.doctor.post(`/api/protocols/${p.id}/save`, { canvases })).status, 200);
    assert.equal((await h.doctor.post(`/api/protocols/${p.id}/publish`, {})).status, 201);
    return p;
  }

  before(async () => {
    h = await bootstrap();
    backPain = await publishWith('Back Pain', {
      left_front: [
        dot({ id: 'bp-red-ring', type: 'ring', x: 0.55, y: 0.3, width: 0.08, height: 0.08, color: '#ff0000', thickness: 4, zIndex: 1 }),
        dot({ id: 'bp-blue-dot', x: 0.4, y: 0.6, color: '#0000ff', zIndex: 2 }),
      ],
      right_back: [dot({ id: 'bp-green-dot', x: 0.5, y: 0.5, color: '#00aa00', zIndex: 1 })],
    });
    anxiety = await publishWith('Anxiety', { left_front: [dot({ id: 'ax-yellow-dot', x: 0.3, y: 0.7, color: '#ffcc00', zIndex: 1 })] });
  });
  after(async () => { if (h) await h.stop(); });

  it('is OFF by default: the public status says so and reveals nothing else', async () => {
    assert.equal(await flag('CAMERA'), 0);
    assert.equal(await flag('AR'), 0);
    const r = await h.anon.get(PUBLIC_STATUS);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { enabled: false });
    assert.deepEqual((await h.admin.get(ADMIN_CAMERA)).json, { key: 'CAMERA', enabled: false, available: false, blockedBy: [] });
  });

  for (const [label, key, expected] of [['an anonymous visitor', 'anon', 401], ['a patient', 'patient', 403], ['a doctor', 'doctor', 403]]) {
    it(`${label} cannot read or change the switch (${expected})`, async () => {
      for (const [method, url] of [['GET', ADMIN_CAMERA], ['POST', `${ADMIN_CAMERA}/enable`], ['POST', `${ADMIN_CAMERA}/disable`]]) {
        assert.equal((await h[key].request(method, url, method === 'GET' ? undefined : {})).status, expected, `${method} ${url}`);
      }
      assert.equal(await flag('CAMERA'), 0);
      assert.equal(await flag('AR'), 0);
    });
  }

  it('nothing on the public side can switch it on', async () => {
    for (const [method, url] of [['POST', PUBLIC_STATUS], ['PUT', PUBLIC_STATUS], ['POST', '/api/public/camera/enable']]) {
      await h.anon.request(method, url, { enabled: true, CAMERA: true, AR: true });
    }
    assert.deepEqual((await h.anon.get(PUBLIC_STATUS)).json, { enabled: false });
  });

  it('an administrator enables it: CAMERA and AR turn on together and the public status follows at once', async () => {
    const r = await h.admin.post(`${ADMIN_CAMERA}/enable`, {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { key: 'CAMERA', enabled: true, available: true, blockedBy: [] });
    assert.equal(await flag('CAMERA'), 1);
    assert.equal(await flag('AR'), 1);
    assert.deepEqual((await h.anon.get(PUBLIC_STATUS)).json, { enabled: true });
  });

  it('the public status also needs the public website: with WEBSITE off it reports disabled', async () => {
    await setFlag('WEBSITE', false);
    try {
      assert.deepEqual((await h.anon.get(PUBLIC_STATUS)).json, { enabled: false });
      assert.deepEqual((await h.admin.get(ADMIN_CAMERA)).json.blockedBy, ['WEBSITE']);
    } finally { await setFlag('WEBSITE', true); }
  });

  it('an anonymous visitor (no login, no assignment) loads a published protocol for the camera', async () => {
    const r = await h.anon.get(render(backPain.slug));
    assert.equal(r.status, 200);
    const lf = r.json.canvases.find((c) => c.viewKey === 'left_front');
    assert.equal(lf.canvasType, 'hand');
    assert.ok(lf.width > 0 && lf.height > 0);
    assert.deepEqual(lf.objects.map((o) => [o.id, o.type, o.color]), [['bp-red-ring', 'ring', '#ff0000'], ['bp-blue-dot', 'dot', '#0000ff']]);
    assert.deepEqual(r.json.canvases.find((c) => c.viewKey === 'right_back').objects.map((o) => o.id), ['bp-green-dot']);
    assert.equal(JSON.stringify(r.json).includes('doctor@example.com'), false, 'no owner/doctor data in the public render');
  });

  it('each protocol returns its OWN markings (Anxiety never carries Back Pain\'s)', async () => {
    const ax = (await h.anon.get(render(anxiety.slug))).json;
    const ids = ax.canvases.flatMap((c) => c.objects.map((o) => o.id));
    assert.deepEqual(ids, ['ax-yellow-dot']);
  });

  it('an unpublished draft is private: its render is 404 even with the camera on', async () => {
    const draft = (await h.doctor.post('/api/protocols', { name: 'Draft Headache', protocolType: 'hand' })).json;
    await h.doctor.post(`/api/protocols/${draft.id}/save`, { canvases: [{ id: draft.canvases[0].id, objects: [dot({ id: 'draft-dot' })] }] });
    assert.equal((await h.anon.get(render(draft.slug))).status, 404);
    assert.equal((await h.anon.get(`/api/protocols/${draft.id}`)).status, 401, 'the private protocol API still needs a login');
  });

  it('an unpublished EDIT to a published protocol stays private until the doctor publishes again', async () => {
    const lf = backPain.canvases.find((c) => c.viewKey === 'left_front');
    await h.doctor.post(`/api/protocols/${backPain.id}/save`, { canvases: [{ id: lf.id, objects: [dot({ id: 'bp-unpublished-edit' })] }] });
    let ids = (await h.anon.get(render(backPain.slug))).json.canvases.flatMap((c) => c.objects.map((o) => o.id));
    assert.equal(ids.includes('bp-unpublished-edit'), false);
    assert.ok(ids.includes('bp-blue-dot'));
    // the doctor can still publish (existing workflow), and only then does the public / camera copy change
    assert.equal((await h.doctor.post(`/api/protocols/${backPain.id}/publish`, {})).status, 201);
    ids = (await h.anon.get(render(backPain.slug))).json.canvases.flatMap((c) => c.objects.map((o) => o.id));
    assert.ok(ids.includes('bp-unpublished-edit'));
  });

  it('an administrator disables it: AR then CAMERA turn off, the public status follows', async () => {
    const r = await h.admin.post(`${ADMIN_CAMERA}/disable`, {});
    assert.deepEqual(r.json, { key: 'CAMERA', enabled: false, available: false, blockedBy: [] });
    assert.equal(await flag('CAMERA'), 0);
    assert.equal(await flag('AR'), 0);
    assert.deepEqual((await h.anon.get(PUBLIC_STATUS)).json, { enabled: false });
    // the website and the download source keep working with the camera off
    assert.equal((await h.anon.get(render(backPain.slug))).status, 200);
  });

  it('the admin switch needs the ADMIN area', async () => {
    await setFlag('ADMIN', false);
    try {
      assert.equal((await h.admin.get(ADMIN_CAMERA)).status, 404);
      assert.equal((await h.admin.post(`${ADMIN_CAMERA}/enable`, {})).status, 404);
      assert.equal(await flag('CAMERA'), 0);
    } finally { await setFlag('ADMIN', true); }
  });
});
