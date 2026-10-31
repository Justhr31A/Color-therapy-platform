/**
 * [DETERMINISTIC SOFTWARE TESTS — HTTP level]
 *
 * Starts the REAL backend (`node src/server.js`) as a child process against a
 * throw-away PostgreSQL database and talks to it over HTTP, exactly like the
 * frontend does. Uses the real packages (express, pg, bcryptjs, jsonwebtoken).
 * A missing npm package skips the file with a reason; a missing database
 * (TEST_DATABASE_URL) FAILS it — see helpers/pg.js.
 *
 * This proves the SERVER behaves. It does NOT exercise the browser UI (the
 * Konva builder, camera, or AR) — see docs/REAL_DEVICE_VALIDATION.md for what
 * only a person with a real screen/camera can validate.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { missingReason, openTempDb, seedLegacyDatabase } = require('./helpers/testDb');
const { openTestDatabase } = require('./helpers/pg');

let depsMissing = missingReason('pg');
if (!depsMissing) {
  for (const dep of ['express', 'bcryptjs', 'jsonwebtoken', 'cookie-parser', 'cors']) {
    try { require.resolve(dep); } catch (e) { depsMissing = `${dep} is not installed (run \`npm install\` in backend/)`; break; }
  }
}

const BACKEND_DIR = path.join(__dirname, '..');
// The newest PostgreSQL schema version the code knows.
const latestSchemaVersion = () => require('../src/db/postgres-migrate').listMigrationFiles().length; // eslint-disable-line global-require
const randomPassword = () => `test-only-${crypto.randomBytes(9).toString('hex')}`;

// ---------------------------------------------------------------- helpers
class Client {
  constructor(base) { this.base = base; this.cookie = null; }
  async request(method, url, body) {
    const res = await fetch(this.base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    const token = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('ctpp_token='));
    if (token) this.cookie = token.endsWith('=') ? null : token;
    let json = null;
    try { json = await res.json(); } catch (e) { /* no body */ }
    return { status: res.status, json, setCookies };
  }
  get(url) { return this.request('GET', url); }
  post(url, body) { return this.request('POST', url, body || {}); }
  put(url, body) { return this.request('PUT', url, body || {}); }
}

async function startServer(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const logs = [];
  const child = spawn(process.execPath, ['--no-warnings', 'src/server.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, PORT: String(port), JWT_SECRET: crypto.randomBytes(32).toString('hex'), COOKIE_SECURE: 'false', CORS_ORIGIN: 'http://localhost:5173', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  let exited = false;
  child.on('exit', () => { exited = true; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited during startup:\n${logs.join('')}`);
    try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (Date.now() >= deadline) { child.kill(); throw new Error(`server did not become ready:\n${logs.join('')}`); }
  return { base, logs, stop: () => new Promise((resolve) => { if (exited) return resolve(); child.on('exit', resolve); child.kill(); }) };
}

async function insertUser(db, { id, name, email, password, role, status = 'active' }) {
  const { hashPassword } = require('../src/utils/password'); // eslint-disable-line global-require
  const hash = password ? await hashPassword(password) : null;
  await db.query('INSERT INTO users (id,name,email,password_hash,role,status) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, email, hash, role, status]);
}

async function login(base, email, password) {
  const c = new Client(base);
  const r = await c.post('/api/auth/login', { email, password });
  return { client: c, res: r };
}

function allTypeObjects(tag) {
  const { OBJECT_TYPES } = require('../src/protocol/vocabulary'); // eslint-disable-line global-require
  return OBJECT_TYPES.map((type, i) => ({
    id: `obj-${tag}-${type}`, type,
    x: 0.1 + i * 0.05, y: 0.2 + i * 0.03, width: 0.05 + i * 0.001, height: type === 'rectangle' || type === 'square' ? 0.07 : null,
    rotation: i * 3, color: '#123456', thickness: 2 + i, opacity: 0.9,
    points: type === 'freeline' ? [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }] : null,
    finger: type === 'dot' ? 'pinky' : null, landmarkReference: null, metadata: {}, zIndex: i,
  }));
}

// ----------------------------------------------------------------- suite A
describe('[DETERMINISTIC · HTTP] backend on a freshly migrated database', { skip: depsMissing }, () => {
  const ADMIN_PW = randomPassword();
  const DOC1_PW = randomPassword();
  const DOC2_PW = randomPassword();
  let t; let server; let db;

  before(async () => {
    const { createAdminAccount } = require('../src/services/adminSeed'); // eslint-disable-line global-require
    t = await openTestDatabase();
    db = t.db;
    await createAdminAccount(db, { email: 'admin@example.com', name: 'Admin', password: ADMIN_PW });
    await insertUser(db, { id: 'doc1', name: 'Doc One', email: 'doc1@example.com', password: DOC1_PW, role: 'doctor' });
    await insertUser(db, { id: 'doc2', name: 'Doc Two', email: 'doc2@example.com', password: DOC2_PW, role: 'doctor' });
    server = await startServer(t.env);
  });
  after(async () => { if (server) await server.stop(); if (t) await t.cleanup(); });

  it('health check works', async () => {
    const r = await new Client(server.base).get('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });

  // ---- public DOCTOR registration (temporarily re-enabled). Admin accounts are still operator-created only. ----
  const userRow = (email) => t.row('SELECT id, name, email, password_hash, role, status FROM users WHERE email = $1', email);
  const userCount = async () => (await t.row('SELECT COUNT(*) c FROM users')).c;
  const authCookie = (r) => r.setCookies.some((c) => c.startsWith('ctpp_token=') && !c.startsWith('ctpp_token=;'));

  it('public doctor registration creates an ordinary active doctor, signs them in, and never returns the password hash', async () => {
    const pw = randomPassword();
    const c = new Client(server.base);
    const r = await c.post('/api/auth/register', { name: '  Dr Grace Hopper ', email: 'Grace.Hopper@Example.com', password: pw });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['email', 'id', 'name', 'role'], 'only these fields are returned');
    assert.equal(r.json.role, 'doctor');
    assert.equal(r.json.name, 'Dr Grace Hopper', 'name is trimmed');
    assert.equal(r.json.email, 'grace.hopper@example.com', 'email is stored lower-cased');
    assert.ok(r.setCookies.some((x) => /^ctpp_token=/.test(x) && /HttpOnly/i.test(x)), 'signed in with an httpOnly cookie');

    const row = (await userRow('grace.hopper@example.com'));
    assert.deepEqual([row.role, row.status], ['doctor', 'active']);
    assert.ok(row.password_hash && row.password_hash !== pw && !row.password_hash.includes(pw), 'the password is stored hashed, never in clear');

    const me = await c.get('/api/auth/me'); // the cookie set by registration is enough
    assert.equal(me.status, 200);
    assert.equal(me.json.role, 'doctor');
    assert.equal(me.json.password_hash, undefined);

    // and the normal login route works for the new account (any capitalisation of the email)
    const again = await login(server.base, 'GRACE.HOPPER@example.com', pw);
    assert.equal(again.res.status, 200);
    assert.equal(again.res.json.role, 'doctor');
  });

  it('the role is ALWAYS doctor: a request that asks for admin (or sets status / id / other privileged fields) gets an ordinary doctor, who cannot reach any admin route', async () => {
    const hostile = [
      { role: 'admin' }, { role: 'ADMIN' }, { role: ['admin'] }, { isAdmin: true, admin: true }, { role: 'patient' },
      { status: 'pending', id: 'attacker-chosen-id' }, { password_hash: 'x', created_at: '2000-01-01' },
    ];
    for (const [i, extra] of hostile.entries()) {
      const email = `hostile${i}@example.com`;
      const c = new Client(server.base);
      const r = await c.post('/api/auth/register', { name: 'Eve', email, password: randomPassword(), ...extra });
      assert.equal(r.status, 201, `${JSON.stringify(extra)} -> ${r.text}`);
      assert.equal(r.json.role, 'doctor', JSON.stringify(extra));
      const row = (await userRow(email));
      assert.deepEqual([row.role, row.status], ['doctor', 'active'], `row for ${JSON.stringify(extra)}`);
      assert.notEqual(row.id, 'attacker-chosen-id', 'the id is always server-generated');
      assert.equal((await c.get('/api/auth/me')).json.role, 'doctor');
      // not an admin: every admin surface refuses them
      assert.equal((await c.get('/api/admin/conditions')).status, 403, 'admin conditions');
      assert.equal((await c.get('/api/admin/categories')).status, 403, 'admin categories');
    }
    assert.equal((await t.row("SELECT COUNT(*) c FROM users WHERE role = 'admin'")).c, 1, 'the only admin is still the operator-created one');
  });

  it('a newly registered doctor can do what any doctor can (create their own protocol) — registration changes nothing about doctor behaviour', async () => {
    const c = new Client(server.base);
    await c.post('/api/auth/register', { name: 'Dr New', email: 'dr.new@example.com', password: randomPassword() });
    const created = await c.post('/api/protocols', { name: 'New doctor protocol', protocolType: 'hand' });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.canvases.length, 4);
  });

  it('invalid registrations are refused with 400 and create NO account: missing / blank / non-text name, bad email, short or non-text password, no body', async () => {
    const before = (await userCount());
    const good = { name: 'Dr Valid', email: 'valid.doc@example.com', password: randomPassword() };
    const bad = [
      {}, null, { ...good, name: undefined }, { ...good, name: '   ' }, { ...good, name: 12345 }, { ...good, name: ['Dr'] }, { ...good, name: { first: 'x' } },
      { ...good, email: undefined }, { ...good, email: 'not-an-email' }, { ...good, email: 'a@b' }, { ...good, email: 'sp ace@example.com' }, { ...good, email: ['a@b.co'] },
      { ...good, password: undefined }, { ...good, password: 'short' }, { ...good, password: '1234567' }, { ...good, password: 12345678 }, { ...good, password: ['longenough1', 'x'] },
    ];
    const c = new Client(server.base);
    for (const body of bad) {
      const r = await c.post('/api/auth/register', body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
      assert.equal(authCookie(r), false, 'a refused registration must not sign anyone in');
    }
    assert.equal((await userCount()), before, 'nothing was created');
    assert.equal((await new Client(server.base).get('/api/health')).status, 200, 'and the server is still up after all of that');
  });

  it('an existing email is refused with 409, in any capitalisation — and the existing account (including the admin) is never taken over', async () => {
    const adminBefore = (await userRow('admin@example.com'));
    const before = (await userCount());
    const c = new Client(server.base);
    for (const email of ['admin@example.com', 'ADMIN@EXAMPLE.COM', 'doc1@example.com', 'Doc1@Example.com']) {
      const r = await c.post('/api/auth/register', { name: 'Impostor', email, password: randomPassword() });
      assert.equal(r.status, 409, `${email} -> ${r.text}`);
      assert.equal(authCookie(r), false);
    }
    assert.equal((await userCount()), before);
    assert.deepEqual((await userRow('admin@example.com')), adminBefore, 'the admin row is byte-for-byte unchanged');
    assert.equal((await login(server.base, 'admin@example.com', ADMIN_PW)).res.status, 200, 'the admin still signs in with their own password');
  });

  it('an email reserved for a PENDING patient invite is refused (409) and the patient row is untouched; patient activation still works exactly as before', async () => {
    (await t.run("INSERT INTO users (id, name, email, password_hash, role, status) VALUES ('pat-1', 'Pat', 'pending.patient@example.com', NULL, 'patient', 'pending')"));
    const before = (await userRow('pending.patient@example.com'));
    const r = await new Client(server.base).post('/api/auth/register', { name: 'Dr Squatter', email: 'pending.patient@example.com', password: randomPassword() });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /reserved for a patient/i);
    assert.deepEqual((await userRow('pending.patient@example.com')), before, 'still a pending patient with no password');

    // the separate patient route is untouched: the patient can still claim their own invitation …
    const act = await new Client(server.base).post('/api/auth/patient/activate', { email: 'pending.patient@example.com', password: randomPassword() });
    assert.equal(act.status, 200, act.text);
    assert.equal(act.json.role, 'patient');
    // … and it still refuses anything that is not a pending patient — notably a doctor who registered through the new route
    const doctorEmail = 'activation.target@example.com';
    await new Client(server.base).post('/api/auth/register', { name: 'Dr Target', email: doctorEmail, password: randomPassword() });
    const hijack = await new Client(server.base).post('/api/auth/patient/activate', { email: doctorEmail, password: randomPassword() });
    assert.equal(hijack.status, 404);
    assert.equal((await userRow(doctorEmail)).role, 'doctor');
  });

  it('if another sign-up grabs the email between the availability check and the INSERT, the caller gets a clean 409 — not a 500, and the server survives', async () => {
    // Deterministic stand-in for that race: a trigger inserts the same email just before the route's own INSERT runs,
    // so the route's INSERT hits the UNIQUE constraint exactly as it would in a real race. (Concurrent requests alone
    // cannot reliably reproduce it here: password hashing can finish too quickly for them to interleave.)
    await t.run(`CREATE FUNCTION sim_signup_race_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.email = 'simulated.race@example.com' AND NEW.id <> 'raced-first' THEN
          INSERT INTO users (id, name, email, password_hash, role, status) VALUES ('raced-first', 'Raced', 'simulated.race@example.com', 'x', 'doctor', 'active');
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER sim_signup_race BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION sim_signup_race_fn();`);
    try {
      const r = await new Client(server.base).post('/api/auth/register', { name: 'Late', email: 'simulated.race@example.com', password: randomPassword() });
      assert.equal(r.status, 409, `${r.status} ${r.text}`);
      assert.match(r.json.error, /already exists/i);
      assert.equal(authCookie(r), false);
    } finally { await t.run('DROP TRIGGER sim_signup_race ON users; DROP FUNCTION sim_signup_race_fn();'); }
    assert.equal((await new Client(server.base).get('/api/health')).status, 200, 'the server is still running');
  });

  it('simultaneous registrations for the SAME email: exactly one wins (201), the rest get 409, one row exists, and the server survives', async () => {
    const email = 'race.condition@example.com';
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => new Client(server.base).post('/api/auth/register', { name: `Racer ${i}`, email, password: randomPassword() })));
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((x) => x === 201).length, 1, JSON.stringify(statuses));
    assert.equal(statuses.filter((x) => x === 409).length, 5, JSON.stringify(statuses));
    assert.equal((await t.row('SELECT COUNT(*) c FROM users WHERE email = $1', email)).c, 1);
    assert.equal((await new Client(server.base).get('/api/health')).status, 200);
  });

  it('protocol routes require authentication', async () => {
    assert.equal((await new Client(server.base).get('/api/protocols')).status, 401);
  });

  it('admin can log in via the existing login route; the cookie is httpOnly; /me reports the admin role', async () => {
    const { client, res } = await login(server.base, 'admin@example.com', ADMIN_PW);
    assert.equal(res.status, 200);
    assert.equal(res.json.role, 'admin');
    assert.ok(res.setCookies.some((c) => /^ctpp_token=/.test(c) && /HttpOnly/i.test(c)), 'auth cookie must be httpOnly');
    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.role, 'admin');
    assert.equal(me.json.password_hash, undefined, 'password hash must never be returned');
  });

  it('wrong password is rejected', async () => {
    assert.equal((await login(server.base, 'admin@example.com', 'not the password')).res.status, 401);
  });

  it('builder flow: create -> save every object type -> reload returns them intact (and "pinky" is written as "little")', async () => {
    const { client } = await login(server.base, 'admin@example.com', ADMIN_PW);
    const created = await client.post('/api/protocols', { name: 'Round trip', description: 'd', protocolType: 'hand' });
    assert.equal(created.status, 201);
    assert.deepEqual(created.json.canvases.map((c) => c.viewKey), ['left_front', 'right_front', 'left_back', 'right_back']);
    const protoId = created.json.id;
    const canvasId = created.json.canvases[0].id;

    const sent = allTypeObjects(protoId.slice(0, 8));
    const saved = await client.post(`/api/protocols/${protoId}/save`, { canvases: [{ id: canvasId, objects: sent }] });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.currentVersion, 2);

    const reloaded = (await client.get(`/api/protocols/${protoId}`)).json;
    const got = reloaded.canvases.find((c) => c.id === canvasId).objects;
    assert.equal(got.length, sent.length);
    assert.equal(sent.length, 12, 'the original ten plus fingerBand and text');
    for (const s of sent) {
      const g = got.find((o) => o.id === s.id);
      assert.ok(g, `object ${s.type} missing after reload`);
      for (const k of ['type', 'x', 'y', 'width', 'height', 'rotation', 'color', 'thickness', 'opacity', 'points', 'landmarkReference']) {
        assert.deepEqual(g[k], s[k], `${s.type}.${k} changed on save/reload`);
      }
      assert.equal(g.finger, s.type === 'dot' ? 'little' : null, `${s.type}.finger`);
    }
    const versions = (await client.get(`/api/protocols/${protoId}/versions`)).json;
    assert.deepEqual(versions.map((v) => v.version), [2, 1]);
  });

  it('a doctor sees and edits only their OWN protocols; an admin sees all', async () => {
    const d1 = (await login(server.base, 'doc1@example.com', DOC1_PW)).client;
    const d2 = (await login(server.base, 'doc2@example.com', DOC2_PW)).client;
    const admin = (await login(server.base, 'admin@example.com', ADMIN_PW)).client;

    const p1 = (await d1.post('/api/protocols', { name: 'Doc1 protocol', protocolType: 'hand' })).json;
    const p2 = (await d2.post('/api/protocols', { name: 'Doc2 protocol', protocolType: 'hand' })).json;

    assert.deepEqual((await d1.get('/api/protocols')).json.map((p) => p.id), [p1.id]);
    assert.deepEqual((await d2.get('/api/protocols')).json.map((p) => p.id), [p2.id]);

    // doctor 2 cannot read, modify, duplicate, save or delete doctor 1's protocol — every one is a plain 404
    assert.equal((await d2.get(`/api/protocols/${p1.id}`)).status, 404);
    assert.equal((await d2.put(`/api/protocols/${p1.id}`, { name: 'hacked' })).status, 404);
    assert.equal((await d2.post(`/api/protocols/${p1.id}/duplicate`)).status, 404);
    assert.equal((await d2.post(`/api/protocols/${p1.id}/save`, { canvases: [] })).status, 404);
    assert.equal((await d2.request('DELETE', `/api/protocols/${p1.id}`)).status, 404);
    assert.equal((await d1.get(`/api/protocols/${p1.id}`)).json.name, 'Doc1 protocol', 'unchanged by the rejected attempts');

    const adminList = (await admin.get('/api/protocols')).json.map((p) => p.id);
    assert.ok(adminList.includes(p1.id) && adminList.includes(p2.id), 'admin lists every protocol');
    assert.equal((await admin.get(`/api/protocols/${p1.id}`)).status, 200);
    assert.equal((await admin.put(`/api/protocols/${p1.id}`, { name: 'Renamed by admin' })).json.name, 'Renamed by admin');
    const copy = await admin.post(`/api/protocols/${p2.id}/duplicate`);
    assert.equal(copy.status, 201);
  });

  it('legacy patient flow is intact: doctor assigns -> patient activates -> patient reads ONLY their protocol; patients cannot use the builder API', async () => {
    const doc = (await login(server.base, 'doc1@example.com', DOC1_PW)).client;
    const proto = (await doc.post('/api/protocols', { name: 'For patient', protocolType: 'hand' })).json;
    await doc.post(`/api/protocols/${proto.id}/save`, { canvases: [{ id: proto.canvases[0].id, objects: allTypeObjects(`pt${proto.id.slice(0, 6)}`).slice(0, 2) }] });
    assert.equal((await doc.put(`/api/protocols/${proto.id}`, { status: 'active' })).json.status, 'active');
    const assigned = await doc.post(`/api/protocols/${proto.id}/assign`, { patientEmail: 'patient.one@example.com' });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.json.patient.status, 'pending');

    const patientPw = randomPassword();
    const pc = new Client(server.base);
    const activated = await pc.post('/api/auth/patient/activate', { email: 'patient.one@example.com', password: patientPw });
    assert.equal(activated.status, 200);
    assert.equal(activated.json.role, 'patient');

    const list = await pc.get('/api/patient/protocols');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.map((p) => [p.id, p.canStart]), [[proto.id, true]]);
    const detail = await pc.get(`/api/patient/protocols/${proto.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.canvases.length, 4);
    assert.equal(detail.json.canvases[0].objects.length, 2);

    // a different patient cannot read it by guessing the id
    await doc.post(`/api/protocols/${proto.id}/assign`, { patientEmail: 'patient.one@example.com' });
    const other = (await doc.post(`/api/protocols/${(await doc.post('/api/protocols', { name: 'x', protocolType: 'hand' })).json.id}/assign`, { patientEmail: 'patient.two@example.com' }));
    assert.equal(other.status, 200);
    const pc2 = new Client(server.base);
    await pc2.post('/api/auth/patient/activate', { email: 'patient.two@example.com', password: randomPassword() });
    assert.equal((await pc2.get(`/api/patient/protocols/${proto.id}`)).status, 404);

    // a patient session is refused by the builder API (403), and by admin-only power
    assert.equal((await pc.get('/api/protocols')).status, 403);
    assert.equal((await pc.post('/api/protocols', { name: 'nope', protocolType: 'hand' })).status, 403);
  });

  it('feature flags are enforced by the backend: PROTOCOL_STUDIO off -> protocol API is 404 (not 401/403 leaks); back on -> works again', async () => {
    const { createFeatureFlagService } = require('../src/services/featureFlags'); // eslint-disable-line global-require
    const admin = (await login(server.base, 'admin@example.com', ADMIN_PW)).client;
    const patient = new Client(server.base);
    const pw = randomPassword();
    await patient.post('/api/auth/patient/activate', { email: 'patient.two@example.com', password: pw }).catch(() => {});
    const ptLogin = await login(server.base, 'patient.two@example.com', pw);

    const flags = createFeatureFlagService(t.db); // the running server reads the same database on every request
    try {
      assert.equal((await admin.get('/api/protocols')).status, 200);
      await flags.setFlag('PROTOCOL_STUDIO', false);
      const off = await admin.get('/api/protocols');
      assert.equal(off.status, 404);
      assert.deepEqual(off.json, { error: 'Not found.' });
      assert.equal((await admin.post('/api/protocols', { name: 'x', protocolType: 'hand' })).status, 404);
      // unauthenticated callers still get 401 — they cannot probe which features are off
      assert.equal((await new Client(server.base).get('/api/protocols')).status, 401);
      // legacy patient routes are deliberately NOT gated yet (see docs/FOUNDATION.md): still working
      if (ptLogin.res.status === 200) assert.equal((await ptLogin.client.get('/api/patient/protocols')).status, 200);
      await flags.setFlag('PROTOCOL_STUDIO', true);
      assert.equal((await admin.get('/api/protocols')).status, 200);
    } finally {
      await flags.setFlag('PROTOCOL_STUDIO', true);
    }
  });
});

// ----------------------------------------------------------------- suite B
// The SQLite -> PostgreSQL path for an EXISTING installation: a populated legacy SQLite file (the pre-migration schema,
// user_version 0) is imported with the real importer into a fresh PostgreSQL database, then the real server runs on it.
describe('[DETERMINISTIC · HTTP] a populated LEGACY SQLite database, imported into PostgreSQL, then served', { skip: depsMissing || missingReason('better-sqlite3') }, () => {
  const DOCTOR_PW = randomPassword();
  const PATIENT_PW = randomPassword();
  let legacy; let target; let server; let importResult; let sourceHashBefore;

  const fileHash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  before(async () => {
    legacy = openTempDb();
    seedLegacyDatabase(legacy.db); // the pre-migration schema, user_version 0, real-looking data
    const { hashPassword } = require('../src/utils/password'); // eslint-disable-line global-require
    legacy.db.prepare("UPDATE users SET password_hash = ? WHERE id = 'u-doc'").run(await hashPassword(DOCTOR_PW));
    legacy.db.prepare("UPDATE users SET password_hash = ? WHERE id = 'u-pat1'").run(await hashPassword(PATIENT_PW));
    legacy.db.pragma('wal_checkpoint(TRUNCATE)');
    legacy.db.close();
    sourceHashBefore = fileHash(legacy.file);

    target = await openTestDatabase({ migrated: false }); // completely empty: the importer applies the migrations
    const { importSqliteToPostgres } = require('../scripts/legacy-sqlite/importer'); // eslint-disable-line global-require
    importResult = await importSqliteToPostgres({ sourcePath: legacy.file, pool: target.pool, log: () => {} });
    server = await startServer(target.env);
  });
  after(async () => {
    if (server) await server.stop();
    if (target) await target.cleanup();
    if (legacy) fs.rmSync(legacy.dir, { recursive: true, force: true });
  });

  it('imports and verifies every table, and never modifies the SQLite source file', async () => {
    assert.equal(importResult.committed, true);
    assert.equal(importResult.sourceSchemaVersion, 0);
    const rows = Object.fromEntries(importResult.report.map((r) => [r.table, r.rows]));
    assert.deepEqual({ users: rows.users, protocols: rows.protocols, canvases: rows.canvases, objects: rows.objects, protocol_versions: rows.protocol_versions },
      { users: 3, protocols: 2, canvases: 5, objects: 4, protocol_versions: 2 });
    assert.equal(fileHash(legacy.file), sourceHashBefore, 'the source file is byte-identical after the import');
  });

  it('the EXISTING doctor account still logs in with its old password and sees all of its protocols', async () => {
    const { client, res } = await login(server.base, 'doc@example.com', DOCTOR_PW);
    assert.equal(res.status, 200);
    assert.equal(res.json.role, 'doctor');
    const list = (await client.get('/api/protocols')).json;
    assert.deepEqual(list.map((p) => p.id).sort(), ['p-1', 'p-2']);
    const p1 = list.find((p) => p.id === 'p-1');
    assert.deepEqual([p1.createdAt, p1.updatedAt], ['2024-01-10 12:00:00', '2024-06-11 13:00:00'], 'original timestamps, same format as before');
  });

  it('old objects load exactly as saved (legacy finger "pinky" still readable) and can be re-saved (written as "little")', async () => {
    const { client } = await login(server.base, 'doc@example.com', DOCTOR_PW);
    const p1 = (await client.get('/api/protocols/p-1')).json;
    const canvas = p1.canvases.find((c) => c.viewKey === 'left_front');
    const dot = canvas.objects.find((o) => o.id === 'o-dot');
    assert.equal(dot.x, 0.4578);
    assert.equal(dot.y, 0.4983);
    assert.equal(dot.finger, 'pinky', 'legacy value must remain readable');
    assert.equal(canvas.objects.find((o) => o.id === 'o-ring').thickness, 4);

    const saved = await client.post('/api/protocols/p-1/save', { canvases: p1.canvases.map((c) => ({ id: c.id, objects: c.objects })) });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.currentVersion, 4, 'version continues from the legacy value (3 -> 4)');
    const again = (await client.get('/api/protocols/p-1')).json.canvases.find((c) => c.viewKey === 'left_front').objects.find((o) => o.id === 'o-dot');
    assert.equal(again.finger, 'little');
    assert.equal(again.x, 0.4578, 'coordinates untouched by the rewrite');
  });

  it('the existing patient can still log in and read the protocol assigned to them', async () => {
    const { client, res } = await login(server.base, 'p1@example.com', PATIENT_PW);
    assert.equal(res.status, 200);
    const detail = await client.get('/api/patient/protocols/p-1');
    assert.equal(detail.status, 200);
    assert.equal(detail.json.canvases.length, 4);
  });

  it('the database is at the latest PostgreSQL schema version and the admin role exists', async () => {
    assert.equal((await target.row('SELECT MAX(version) AS v FROM app_schema_migrations')).v, latestSchemaVersion());
    await target.run("INSERT INTO users (id,name,email,password_hash,role) VALUES ('adm','A','adm@example.com','h','admin')");
  });
});
