/**
 * [DETERMINISTIC SOFTWARE TESTS — HTTP level, real server.js + real PostgreSQL]
 * AI Stage 2, Task 1: the admin-controlled AI_ASSESSMENT switch (/api/admin/ai) and what the public sees as it changes.
 *
 * Covers: OFF by default; an administrator can see, enable and disable it; doctors, patients and anonymous visitors
 * cannot; it changes exactly one flag through the EXISTING feature-flag service; the public side reacts at once and
 * reveals nothing about the flag beyond "available or not"; and the assistant works end to end once switched on.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { HTTP_SKIP, bootstrap, dot } = require('./helpers/httpHarness');

const ADMIN_AI = '/api/admin/ai';
const ASK = '/api/public/ai/protocol-assistant';
const PUBLIC_STATUS = '/api/public/ai/status';

describe('[DETERMINISTIC · HTTP] admin control of the AI Protocol Assistant switch', { skip: HTTP_SKIP }, () => {
  let h;
  const flagRows = () => h.rows('SELECT key, enabled, updated_by FROM feature_flags ORDER BY key COLLATE "C"');
  const aiRow = () => h.row("SELECT enabled, updated_by FROM feature_flags WHERE key = 'AI_ASSESSMENT'");
  // Same service `npm run flags` uses, on the same database the server is running against.
  const setFlag = async (key, enabled) => {
    const { createFeatureFlagService } = require('../src/services/featureFlags'); // eslint-disable-line global-require
    await createFeatureFlagService(h.db).setFlag(key, enabled);
  };
  const tableNames = async () => (await h.rows("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).map((r) => r.name);
  const schemaVersion = async () => (await h.row('SELECT MAX(version) AS v FROM app_schema_migrations')).v;
  const ask = (message) => h.anon.post(ASK, { message });

  before(async () => {
    h = await bootstrap();
    const p = (await h.doctor.post('/api/protocols', { name: 'Back Pain', protocolType: 'hand' })).json;
    await h.doctor.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects: [dot({ id: 'obj-back' })] }] });
    assert.equal((await h.doctor.post(`/api/protocols/${p.id}/publish`, {})).status, 201);
  });
  after(async () => { if (h) await h.stop(); });

  it('is OFF in a fresh database, and the admin sees that', async () => {
    assert.equal((await aiRow()).enabled, 0);
    const r = await h.admin.get(ADMIN_AI);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { key: 'AI_ASSESSMENT', enabled: false, available: false, blockedBy: [] });
    assert.deepEqual((await h.anon.get(PUBLIC_STATUS)).json, { enabled: false });
    assert.deepEqual((await ask('Back Pain')).json, { status: 'disabled' });
  });

  describe('only an administrator can see or change it', () => {
    const actors = [['an anonymous visitor', 'anon', 401], ['a patient', 'patient', 403], ['a doctor', 'doctor', 403]];
    for (const [label, key, expected] of actors) {
      it(`${label} is refused (${expected}) on every route, and nothing changes`, async () => {
        const before_ = JSON.stringify((await flagRows()));
        for (const [method, url] of [['GET', ADMIN_AI], ['POST', `${ADMIN_AI}/enable`], ['POST', `${ADMIN_AI}/disable`], ['PUT', ADMIN_AI], ['DELETE', ADMIN_AI]]) {
          const r = await h[key].request(method, url, method === 'GET' || method === 'DELETE' ? undefined : {});
          assert.equal(r.status, expected, `${label} ${method} ${url}`);
        }
        assert.equal(JSON.stringify((await flagRows())), before_);
        assert.equal((await aiRow()).enabled, 0);
      });
    }
    it('a doctor who tries to enable it does not turn the public assistant on', async () => {
      await h.doctor.post(`${ADMIN_AI}/enable`, {});
      assert.deepEqual((await ask('Back Pain')).json, { status: 'disabled' });
    });
    it('nothing on the PUBLIC side can change it: the public AI routes only read', async () => {
      for (const [method, url, body] of [['POST', '/api/public/ai/status', {}], ['PUT', '/api/public/ai/status', { enabled: true }], ['POST', '/api/public/ai/enable', {}], ['POST', '/api/public/ai/flags', { AI_ASSESSMENT: true }], ['POST', ASK, { message: 'x', enable: true, flag: 'AI_ASSESSMENT', AI_ASSESSMENT: true }]]) {
        await h.anon.request(method, url, body);
      }
      assert.equal((await aiRow()).enabled, 0);
    });
    it('the admin routes need the ADMIN area to be switched on', async () => {
      await setFlag('ADMIN', false);
      try {
        assert.equal((await h.admin.get(ADMIN_AI)).status, 404);
        assert.equal((await h.admin.post(`${ADMIN_AI}/enable`, {})).status, 404);
        assert.equal((await aiRow()).enabled, 0);
      } finally { await setFlag('ADMIN', true); }
    });
  });

  describe('an administrator can enable and disable it', () => {
    it('enable: the switch turns on, the public status and the assistant follow immediately, and it is recorded who did it', async () => {
      const r = await h.admin.post(`${ADMIN_AI}/enable`, {});
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { key: 'AI_ASSESSMENT', enabled: true, available: true, blockedBy: [] });
      assert.equal((await aiRow()).enabled, 1);
      assert.equal((await aiRow()).updated_by, (await h.row("SELECT id FROM users WHERE email = 'admin@example.com'")).id);
      assert.deepEqual((await h.anon.get(PUBLIC_STATUS)).json, { enabled: true });
      const a = await ask('I want the Back Pain protocol');
      assert.equal(a.status, 200);
      assert.equal(a.json.status, 'match');
      assert.equal(a.json.protocol.slug, 'back-pain');
      assert.equal((await h.admin.get(ADMIN_AI)).json.enabled, true);
    });
    it('enabling twice is harmless', async () => {
      assert.equal((await h.admin.post(`${ADMIN_AI}/enable`, {})).json.enabled, true);
      assert.equal((await aiRow()).enabled, 1);
    });
    it('disable: the switch turns off and the public assistant is unavailable at once', async () => {
      const r = await h.admin.post(`${ADMIN_AI}/disable`, {});
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { key: 'AI_ASSESSMENT', enabled: false, available: false, blockedBy: [] });
      assert.equal((await aiRow()).enabled, 0);
      assert.deepEqual((await h.anon.get(PUBLIC_STATUS)).json, { enabled: false });
      assert.deepEqual((await ask('I want the Back Pain protocol')).json, { status: 'disabled' });
    });
    it('it can be switched on and off repeatedly', async () => {
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await h.admin.post(`${ADMIN_AI}/enable`, {})).json.enabled, true);
        assert.equal((await ask('Back Pain')).json.status, 'match');
        assert.equal((await h.admin.post(`${ADMIN_AI}/disable`, {})).json.enabled, false);
        assert.equal((await ask('Back Pain')).json.status, 'disabled');
      }
    });
    it('it changes exactly one flag and uses the existing flag table: no other flag moves, and no new table appears', async () => {
      const tablesBefore = await tableNames();
      const versionBefore = await schemaVersion();
      const before_ = (await flagRows()).filter((r) => r.key !== 'AI_ASSESSMENT');
      await h.admin.post(`${ADMIN_AI}/enable`, {});
      await h.admin.post(`${ADMIN_AI}/disable`, {});
      assert.deepEqual((await flagRows()).filter((r) => r.key !== 'AI_ASSESSMENT'), before_);
      assert.deepEqual(await tableNames(), tablesBefore);
      assert.equal(await schemaVersion(), versionBefore, 'no database migration');
    });
    it('it cannot be used to flip any other flag, whatever the request body says', async () => {
      const before_ = (await flagRows()).filter((r) => r.key !== 'AI_ASSESSMENT');
      for (const key of ['PAYMENTS', 'CAMERA', 'PATIENT_ACCOUNTS']) {
        assert.equal((await h.admin.post(`${ADMIN_AI}/enable`, { key, flag: key, [key]: true })).status, 200, key);
      }
      assert.equal((await h.admin.post(`${ADMIN_AI}/disable`, { key: 'WEBSITE', flag: 'DOWNLOAD' })).status, 200);
      assert.deepEqual((await flagRows()).filter((r) => r.key !== 'AI_ASSESSMENT'), before_);
    });
    it('the admin response lists no other flags', async () => {
      const r = await h.admin.get(ADMIN_AI);
      assert.deepEqual(Object.keys(r.json).sort(), ['available', 'blockedBy', 'enabled', 'key']);
      assert.doesNotMatch(r.text, /PAYMENTS|CAMERA|"AR"|PATIENT_/);
    });
    it('responses are not cacheable', async () => {
      const res = await fetch(`${h.base}${ADMIN_AI}`, { headers: { Cookie: h.admin.cookie } });
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });
  });

  describe('the public side', () => {
    it('shows only a yes/no status and, when asked while off, only { status: "disabled" } — no flag names, no reasons', async () => {
      await h.admin.post(`${ADMIN_AI}/disable`, {});
      for (const r of [await h.anon.get(PUBLIC_STATUS), await ask('x'), await h.anon.post(ASK, {})]) {
        assert.equal(r.status, 200);
        assert.doesNotMatch(r.text, /AI_ASSESSMENT|flag|feature|WEBSITE|PROTOCOL_BROWSER|admin|requires/i);
      }
      assert.deepEqual((await h.anon.get(PUBLIC_STATUS)).json, { enabled: false });
    });
    it('while the website or protocol browser is off, the AI switch can be ON yet the assistant stays unavailable — and the admin is told why', async () => {
      await h.admin.post(`${ADMIN_AI}/enable`, {});
      await setFlag('PROTOCOL_BROWSER', false);
      try {
        const a = (await h.admin.get(ADMIN_AI)).json;
        assert.deepEqual(a, { key: 'AI_ASSESSMENT', enabled: true, available: false, blockedBy: ['PROTOCOL_BROWSER'] });
        assert.deepEqual((await ask('Back Pain')).json, { status: 'disabled' });
        assert.deepEqual((await h.anon.get(PUBLIC_STATUS)).json, { enabled: false });
      } finally { await setFlag('PROTOCOL_BROWSER', true); }
      assert.equal((await ask('Back Pain')).json.status, 'match');
      await h.admin.post(`${ADMIN_AI}/disable`, {});
    });
    it('the switch survives a server restart (it lives in the database, not in memory)', async () => {
      await h.admin.post(`${ADMIN_AI}/enable`, {});
      const { startServer, Client } = require('./helpers/httpHarness'); // eslint-disable-line global-require
      const s = await startServer(h.t.env);
      try {
        assert.deepEqual(await (await fetch(`${s.base}${PUBLIC_STATUS}`)).json(), { enabled: true });
        assert.ok(Client);
      } finally { await s.stop(); }
      await h.admin.post(`${ADMIN_AI}/disable`, {});
      assert.equal((await aiRow()).enabled, 0);
    });
  });

  describe('the rest of the system is undisturbed', () => {
    it('login, the doctor dashboard data, the Studio list and the public protocol pages behave the same with the switch on or off', async () => {
      const read = async () => JSON.stringify([
        (await h.doctor.get('/api/auth/me')).json.role, (await h.doctor.get('/api/protocols')).status, (await h.anon.get('/api/public/protocols')).json,
        (await h.anon.get('/api/public/protocols/back-pain')).json, (await h.anon.get('/api/public/protocols/back-pain/render')).status,
      ]);
      await h.admin.post(`${ADMIN_AI}/disable`, {});
      const off = await read();
      await h.admin.post(`${ADMIN_AI}/enable`, {});
      const on = await read();
      await h.admin.post(`${ADMIN_AI}/disable`, {});
      assert.equal(on, off);
    });
    it('the existing command-line tool still reads and changes the same flag', async () => {
      const { createFeatureFlagService } = require('../src/services/featureFlags'); // eslint-disable-line global-require
      await createFeatureFlagService(h.db).setFlag('AI_ASSESSMENT', true);
      assert.equal((await h.admin.get(ADMIN_AI)).json.enabled, true);
      await createFeatureFlagService(h.db).setFlag('AI_ASSESSMENT', false);
      assert.equal((await h.admin.get(ADMIN_AI)).json.enabled, false);
    });
  });
});
