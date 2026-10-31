/** Shared HTTP test harness: starts the REAL server.js on a disposable PostgreSQL database and provides a cookie-keeping client. */
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { missingReason } = require('./testDb');
const { openTestDatabase } = require('./pg');

const BACKEND_DIR = path.join(__dirname, '..', '..');
// Only genuinely missing npm packages skip; a missing database is a FAILURE (see helpers/pg.js).
const HTTP_SKIP = missingReason('pg', 'bcryptjs', 'jsonwebtoken', 'express', 'cookie-parser', 'cors', 'uuid');
const randomPassword = () => `test-only-${crypto.randomBytes(9).toString('hex')}`;

class Client {
  constructor(base) { this.base = base; this.cookie = null; }
  async request(method, url, body) {
    const res = await fetch(this.base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    const token = sc.map((c) => c.split(';')[0]).find((c) => c.startsWith('ctpp_token='));
    if (token) this.cookie = token.endsWith('=') ? null : token;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    return { status: res.status, json, text };
  }
  get(u) { return this.request('GET', u); }
  post(u, b) { return this.request('POST', u, b === undefined ? {} : b); }
  put(u, b) { return this.request('PUT', u, b === undefined ? {} : b); }
  delete(u) { return this.request('DELETE', u); }
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
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (Date.now() >= deadline) { child.kill(); throw new Error(`server did not become ready:\n${logs.join('')}`); }
  return { base, logs, stop: () => new Promise((resolve) => { if (exited) return resolve(); child.on('exit', resolve); child.kill(); }) };
}

/**
 * Boots a migrated PostgreSQL database with an admin, a doctor and an active patient,
 * starts the server on it, and returns logged-in clients. `h.db` is the app database API
 * (query/one/many/transaction) on the SAME database, and h.row/h.rows/h.run are shortcuts.
 */
async function bootstrap() {
  const { createAdminAccount } = require('../../src/services/adminSeed'); // eslint-disable-line global-require
  const { hashPassword } = require('../../src/utils/password'); // eslint-disable-line global-require

  const t = await openTestDatabase();
  const pw = { admin: randomPassword(), doctor: randomPassword(), patient: randomPassword() };
  let server;
  try {
    await createAdminAccount(t.db, { email: 'admin@example.com', name: 'Admin', password: pw.admin });
    const ins = 'INSERT INTO users (id,name,email,password_hash,role,status) VALUES ($1,$2,$3,$4,$5,$6)';
    await t.run(ins, 'doc-1', 'Doctor', 'doctor@example.com', await hashPassword(pw.doctor), 'doctor', 'active');
    await t.run(ins, 'pat-1', 'Patient', 'patient@example.com', await hashPassword(pw.patient), 'patient', 'active');

    server = await startServer(t.env);
  } catch (err) {
    await t.cleanup();
    throw err;
  }
  const loginAs = async (email, password) => {
    const c = new Client(server.base);
    const r = await c.post('/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
    return c;
  };
  return {
    t, server, db: t.db, base: server.base, row: t.row, rows: t.rows, run: t.run,
    anon: new Client(server.base),
    admin: await loginAs('admin@example.com', pw.admin),
    doctor: await loginAs('doctor@example.com', pw.doctor),
    patient: await loginAs('patient@example.com', pw.patient),
    async stop() { await server.stop(); await t.cleanup(); },
  };
}

/** A valid drawable dot in API shape. */
let counter = 0;
const dot = (o = {}) => { counter += 1; return { id: `http-obj-${Date.now()}-${counter}`, type: 'dot', x: 0.45, y: 0.5, width: 0.03, height: 0.03, rotation: 0, color: '#e5484d', thickness: 0, opacity: 1, zIndex: counter, metadata: {}, ...o }; };

module.exports = { HTTP_SKIP, Client, startServer, bootstrap, randomPassword, dot };
