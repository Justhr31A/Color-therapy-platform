/**
 * [DETERMINISTIC SOFTWARE TESTS — real server process, real HTTP]
 * The authentication cookie across the two production origins (frontend and API on different sites) and on localhost.
 *
 * THE BUG these tests pin down: the login cookie was issued as `SameSite=Lax` (non-Secure) unless COOKIE_SECURE was exactly
 * "true". A browser silently drops a Lax cookie that arrives on a cross-site API response, so login "succeeded" but the next
 * request (GET /api/auth/me, GET /api/protocols) carried no cookie and got `401 Not authenticated.` Logout also cleared the
 * cookie without Secure/SameSite=None, which a browser refuses to apply across sites.
 *
 * Tests run the real backend (src/server.js) as a child process under several environments, read the real Set-Cookie headers,
 * and feed them through a small BrowserJar that applies the browser rules that matter here:
 *   - response to a request from a page on ANOTHER SITE: the cookie is stored only if it is `SameSite=None; Secure`;
 *   - response to a same-site request (localhost:5173 -> localhost:4000 — ports do not make a different site): Lax is fine;
 *   - a Set-Cookie that is rejected neither stores NOR deletes anything.
 * CORS itself is the `cors` package (configuration checked statically below); verify it live with the curl in docs/DEPLOY notes.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { missingReason } = require('./helpers/testDb');
const { openTestDatabase } = require('./helpers/pg');

let depsMissing = missingReason('pg');
if (!depsMissing) {
  for (const dep of ['express', 'bcryptjs', 'jsonwebtoken', 'cookie-parser', 'cors']) {
    try { require.resolve(dep); } catch (e) { depsMissing = `${dep} is not installed (run \`npm install\` in backend/)`; break; }
  }
}

const BACKEND_DIR = path.join(__dirname, '..');
const FRONTEND_SRC = path.join(__dirname, '..', '..', 'frontend', 'src');
const FRONTEND_ORIGIN = 'https://colour-therapy-platform.onrender.com';
const PASSWORD = `test-only-${crypto.randomBytes(9).toString('hex')}`;

// ------------------------------------------------------------------------------------------------ server helper
async function startServer(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const logs = [];
  const full = { ...process.env, PORT: String(port), JWT_SECRET: crypto.randomBytes(32).toString('hex'), CORS_ORIGIN: FRONTEND_ORIGIN };
  // The three variables that decide the cookie policy must come ONLY from the test, never from the machine running it.
  ['COOKIE_SECURE', 'NODE_ENV', 'RENDER'].forEach((k) => delete full[k]);
  Object.entries(env).forEach(([k, v]) => { if (v === undefined) delete full[k]; else full[k] = v; });
  const child = spawn(process.execPath, ['--no-warnings', 'src/server.js'], { cwd: BACKEND_DIR, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return { base, stop: () => new Promise((resolve) => { if (exited) return resolve(); child.on('exit', resolve); child.kill(); }) };
}

// ------------------------------------------------------------------------------------------- browser cookie model
function parseSetCookie(header) {
  const [pair, ...attrs] = header.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const c = { name: pair.slice(0, eq), value: pair.slice(eq + 1), httpOnly: false, secure: false, sameSite: null, path: null, expired: false };
  attrs.forEach((a) => {
    const i = a.indexOf('=');
    const k = (i === -1 ? a : a.slice(0, i)).toLowerCase();
    const v = i === -1 ? '' : a.slice(i + 1);
    if (k === 'httponly') c.httpOnly = true;
    else if (k === 'secure') c.secure = true;
    else if (k === 'samesite') c.sameSite = v.toLowerCase();
    else if (k === 'path') c.path = v;
    else if (k === 'max-age' && Number(v) <= 0) c.expired = true;
    else if (k === 'expires' && Date.parse(v) <= Date.now()) c.expired = true;
  });
  return c;
}
/** A cookie on the response to a request made by a page on ANOTHER site is kept only if it is SameSite=None; Secure. */
const acceptedCrossSite = (c) => c.sameSite === 'none' && c.secure;
/** Same-site (e.g. localhost:5173 -> localhost:4000): Lax/Strict/None-with-Secure are all fine. */
const acceptedSameSite = (c) => c.sameSite !== 'none' || c.secure;

class BrowserJar {
  constructor({ crossSite }) { this.crossSite = crossSite; this.cookies = new Map(); }
  receive(setCookieHeaders) {
    for (const h of setCookieHeaders) {
      const c = parseSetCookie(h);
      const ok = this.crossSite ? acceptedCrossSite(c) : acceptedSameSite(c);
      if (!ok) continue; // a rejected Set-Cookie neither stores nor deletes anything
      if (c.expired || c.value === '') this.cookies.delete(c.name); else this.cookies.set(c.name, c.value);
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  get size() { return this.cookies.size; }
}
/** An API client behaving like the frontend: a page on FRONTEND_ORIGIN calling `base`, with credentials. */
class BrowserClient {
  constructor(base, { crossSite }) { this.base = base; this.jar = new BrowserJar({ crossSite }); }
  async request(method, url, body) {
    const res = await fetch(this.base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: FRONTEND_ORIGIN, ...(this.jar.size ? { Cookie: this.jar.header() } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    this.jar.receive(setCookies);
    let json = null; let text = '';
    try { text = await res.text(); json = JSON.parse(text); } catch (e) { /* no JSON body */ }
    return { status: res.status, json, text, setCookies };
  }
  get(url) { return this.request('GET', url); }
  post(url, body) { return this.request('POST', url, body || {}); }
}

// -------------------------------------------------------------------------------------------------------- tests
describe('[DETERMINISTIC · HTTP] authentication cookie: production (two origins) and localhost', { skip: depsMissing }, () => {
  let t; const servers = {};
  const CONFIGS = {
    production: { NODE_ENV: 'production' },                         // COOKIE_SECURE not set at all (the failing state)
    render: { RENDER: 'true' },                                      // Render sets RENDER=true on every service
    flagTrue: { COOKIE_SECURE: 'true' },
    flagMessy: { COOKIE_SECURE: ' True ' },                          // capital letter + stray space: must still count as true
    local: {},                                                       // localhost development: nothing set
    optOut: { NODE_ENV: 'production', COOKIE_SECURE: 'false' },      // explicit opt-out wins over production detection
  };
  const SECURE_CONFIGS = ['production', 'render', 'flagTrue', 'flagMessy'];

  before(async () => {
    const { hashPassword } = require('../src/utils/password'); // eslint-disable-line global-require
    t = await openTestDatabase();
    const hash = await hashPassword(PASSWORD);
    await t.run("INSERT INTO users (id,name,email,password_hash,role,status) VALUES ('doc1','Doc One','doc1@example.com',$1,'doctor','active')", hash);
    await t.run("INSERT INTO users (id,name,email,password_hash,role,status) VALUES ('pat1','Pat','pat1@example.com',NULL,'patient','pending')");
    for (const [name, env] of Object.entries(CONFIGS)) servers[name] = await startServer({ ...t.env, ...env });
  });
  after(async () => { await Promise.all(Object.values(servers).map((s) => s.stop())); if (t) await t.cleanup(); });

  const login = (name, opts) => { const c = new BrowserClient(servers[name].base, opts); return c.post('/api/auth/login', { email: 'doc1@example.com', password: PASSWORD }).then((res) => ({ c, res })); };

  // ---- the cookie a production login sets
  for (const name of SECURE_CONFIGS) {
    it(`[${name}] login sets an httpOnly, Secure, SameSite=None cookie that a browser on the other origin will accept`, async () => {
      const { res } = await login(name, { crossSite: true });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.setCookies.length, 1);
      const c = parseSetCookie(res.setCookies[0]);
      assert.equal(c.name, 'ctpp_token');
      assert.equal(c.httpOnly, true, 'httpOnly: JavaScript can never read the JWT');
      assert.equal(c.secure, true);
      assert.equal(c.sameSite, 'none');
      assert.equal(c.path, '/');
      assert.equal(acceptedCrossSite(c), true, 'a browser on another site stores it');
    });
  }

  it('[local] localhost development is unchanged: SameSite=Lax, not Secure (works over plain http), still httpOnly', async () => {
    const { res } = await login('local', { crossSite: false });
    const c = parseSetCookie(res.setCookies[0]);
    assert.deepEqual([c.httpOnly, c.secure, c.sameSite, c.path], [true, false, 'lax', '/']);
    assert.equal(acceptedSameSite(c), true, 'localhost:5173 -> localhost:4000 is same-site, so Lax works');
  });

  it('[optOut] COOKIE_SECURE=false wins over production detection (an http-only staging server can opt out)', async () => {
    const c = parseSetCookie((await login('optOut', { crossSite: false })).res.setCookies[0]);
    assert.deepEqual([c.secure, c.sameSite], [false, 'lax']);
  });

  // ---- the headline bug and its fix, end to end, as a browser on the OTHER origin
  it('THE BUG (reproduced): a Lax cookie is never stored by a browser on another site, so the very next request is "Not authenticated."', async () => {
    const { c, res } = await login('local', { crossSite: true }); // the failing configuration, seen from the production frontend
    assert.equal(res.status, 200, 'login itself still "succeeds" — this is why the page says "Signed in as …"');
    assert.equal(c.jar.size, 0, 'but the browser dropped the cookie');
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 401);
    assert.equal(me.json.error, 'Not authenticated.');
    assert.equal((await c.get('/api/protocols')).status, 401);
  });

  for (const name of SECURE_CONFIGS) {
    it(`[${name}] FIXED: from the other origin, /api/auth/me works immediately after login, and so do the protected doctor APIs`, async () => {
      const { c, res } = await login(name, { crossSite: true });
      assert.equal(res.status, 200);
      assert.equal(c.jar.size, 1, 'the cookie was stored');
      const me = await c.get('/api/auth/me');
      assert.equal(me.status, 200, me.text);
      assert.equal(me.json.role, 'doctor');
      assert.equal(me.json.password_hash, undefined);
      assert.equal((await c.get('/api/protocols')).status, 200);
      const created = await c.post('/api/protocols', { name: `From ${name}`, protocolType: 'hand' });
      assert.equal(created.status, 201, created.text);
      assert.equal((await c.get(`/api/protocols/${created.json.id}`)).status, 200);
    });
  }

  it('[local] localhost still works end to end (same-site browser): login -> /me -> protocols', async () => {
    const { c } = await login('local', { crossSite: false });
    assert.equal((await c.get('/api/auth/me')).json.role, 'doctor');
    assert.equal((await c.get('/api/protocols')).status, 200);
  });

  // ---- logout clears the SAME cookie
  for (const name of [...SECURE_CONFIGS, 'local']) {
    it(`[${name}] logout clears the same cookie: same Path/Secure/SameSite/httpOnly as login, expired, empty value`, async () => {
      const crossSite = name !== 'local';
      const { c, res } = await login(name, { crossSite });
      const set = parseSetCookie(res.setCookies[0]);
      const out = await c.post('/api/auth/logout');
      assert.equal(out.status, 200);
      const clr = parseSetCookie(out.setCookies[0]);
      assert.equal(clr.name, 'ctpp_token');
      assert.equal(clr.value, '');
      assert.equal(clr.expired, true);
      assert.deepEqual([clr.path, clr.secure, clr.sameSite, clr.httpOnly], [set.path, set.secure, set.sameSite, set.httpOnly], 'identical attributes to the cookie it removes');
      assert.equal(c.jar.size, 0, 'the browser model removed the cookie');
      assert.equal((await c.get('/api/auth/me')).status, 401, 'and the session really is gone');
    });
  }

  it('the OLD logout header (no Secure / SameSite=None) would have been ignored by a cross-site browser — which is why logout must repeat the attributes', () => {
    const jar = new BrowserJar({ crossSite: true });
    jar.cookies.set('ctpp_token', 'abc');
    jar.receive(['ctpp_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    assert.equal(jar.size, 1, 'rejected, so the cookie survives and logout would not log anyone out');
    jar.receive(['ctpp_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=None']);
    assert.equal(jar.size, 0);
  });

  // ---- registration and patient activation use the same cookie policy
  it('[production] registration signs the new doctor in with the same production cookie, and /me works at once', async (tc) => {
    const c = new BrowserClient(servers.production.base, { crossSite: true });
    const res = await c.post('/api/auth/register', { name: 'New Doc', email: 'new.doc@example.com', password: PASSWORD });
    if (res.status === 403) return tc.skip('public registration is switched off in this build');
    assert.equal(res.status, 201, res.text);
    const cookie = parseSetCookie(res.setCookies[0]);
    assert.deepEqual([cookie.httpOnly, cookie.secure, cookie.sameSite, cookie.path], [true, true, 'none', '/']);
    assert.equal(c.jar.size, 1);
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.role, 'doctor');
    return undefined;
  });

  it('[production] patient activation uses the same production cookie', async () => {
    const c = new BrowserClient(servers.production.base, { crossSite: true });
    const res = await c.post('/api/auth/patient/activate', { email: 'pat1@example.com', password: PASSWORD });
    assert.equal(res.status, 200, res.text);
    const cookie = parseSetCookie(res.setCookies[0]);
    assert.deepEqual([cookie.httpOnly, cookie.secure, cookie.sameSite], [true, true, 'none']);
    assert.equal((await c.get('/api/auth/me')).json.role, 'patient');
  });

  // ---- the JWT is never handed to JavaScript
  it('the JWT is only ever in the httpOnly cookie: never in a JSON body, and the cookie value is a real JWT for this user', async () => {
    for (const name of ['production', 'local']) {
      const { res } = await login(name, { crossSite: name === 'production' });
      const jwt = parseSetCookie(res.setCookies[0]).value;
      assert.match(jwt, /^[\w-]+\.[\w-]+\.[\w-]+$/);
      assert.ok(!res.text.includes(jwt), 'the login response body does not contain the token');
      assert.deepEqual(Object.keys(res.json).sort(), ['email', 'id', 'name', 'role']);
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
      assert.deepEqual([payload.sub, payload.role], ['doc1', 'doctor']);
    }
  });

  it('authentication is still enforced: no cookie -> 401, a forged cookie -> 401', async () => {
    const c = new BrowserClient(servers.production.base, { crossSite: true });
    assert.equal((await c.get('/api/auth/me')).status, 401);
    assert.equal((await c.get('/api/protocols')).status, 401);
    c.jar.cookies.set('ctpp_token', 'not.a.jwt');
    assert.equal((await c.get('/api/auth/me')).status, 401);
    assert.equal((await c.get('/api/protocols')).status, 401);
  });

  it('a wrong password sets no cookie at all', async () => {
    const c = new BrowserClient(servers.production.base, { crossSite: true });
    const r = await c.post('/api/auth/login', { email: 'doc1@example.com', password: 'wrong-password-123' });
    assert.equal(r.status, 401);
    assert.equal(r.setCookies.length, 0);
  });
});

describe('[DETERMINISTIC] the other half of the contract: frontend credentials and backend CORS configuration', () => {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const hasFrontend = fs.existsSync(FRONTEND_SRC);

  it('the frontend API client sends credentials on every request and takes the API origin from VITE_API_URL', { skip: !hasFrontend && 'frontend/ is not next to backend/' }, () => {
    const client = read(path.join(FRONTEND_SRC, 'api', 'client.js'));
    assert.match(client, /withCredentials:\s*true/);
    assert.match(client, /import\.meta\.env\.VITE_API_URL/);
  });

  it('no frontend code reads the cookie or keeps a token in web storage (the JWT stays out of JavaScript)', { skip: !hasFrontend && 'frontend/ is not next to backend/' }, () => {
    const files = [];
    (function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(e.name)) files.push(p); }); }(FRONTEND_SRC));
    files.forEach((f) => {
      const src = read(f);
      assert.doesNotMatch(src, /document\.cookie|localStorage\.(set|get)Item\([^)]*(token|jwt|auth)|sessionStorage\.(set|get)Item\([^)]*(token|jwt|auth)/i, path.relative(FRONTEND_SRC, f));
    });
  });

  it('every call in the auth flow goes through the axios client (so withCredentials applies), never a bare fetch', { skip: !hasFrontend && 'frontend/ is not next to backend/' }, () => {
    ['auth/AuthContext.jsx', 'pages/LoginPage.jsx', 'pages/DashboardPage.jsx'].forEach((f) => {
      const p = path.join(FRONTEND_SRC, f);
      if (fs.existsSync(p)) assert.doesNotMatch(read(p), /\bfetch\(|XMLHttpRequest/, f);
    });
  });

  it('the backend CORS configuration allows the origins listed in CORS_ORIGIN, with credentials', () => {
    const server = read(path.join(BACKEND_DIR, 'src', 'server.js'));
    assert.match(server, /process\.env\.CORS_ORIGIN/);
    assert.match(server, /cors\(\{[^}]*origin:\s*CORS_ORIGIN[^}]*credentials:\s*true[^}]*\}\)/);
  });
});
