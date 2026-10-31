/**
 * [DETERMINISTIC · rendering] the Admin AI Assistant page (AI Stage 2, Task 1): ON/OFF display, enable/disable, that only
 * admins can reach it, and that it talks only to the admin AI endpoints. Same View/wrapper split as the other admin pages.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import api from './support/stubs/apiClient.mjs';
import { loadComponent, RENDER_SKIP } from './support/renderJsx.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const read = (rel) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const noop = () => {};

let AdminAiSettingsPage; let AdminAiSettingsView; let normalizeAiState; let fetchAiState; let setAiEnabled; let AI_ADMIN_API;
const OFF = { enabled: false, available: false, blockedBy: [] };
const ON = { enabled: true, available: true, blockedBy: [] };
const render = (props) => renderToStaticMarkup(h(AdminAiSettingsView, { state: null, loading: false, error: null, busy: false, onEnable: noop, onDisable: noop, ...props }));

describe('[DETERMINISTIC · rendering] Admin AI Assistant page', { skip: RENDER_SKIP }, () => {
  before(async () => {
    ({ default: AdminAiSettingsPage, AdminAiSettingsView, normalizeAiState, fetchAiState, setAiEnabled, AI_ADMIN_API } = await loadComponent('src/pages/admin/AdminAiSettingsPage.jsx'));
  });
  beforeEach(() => api.reset());

  it('shows the title, the ON/OFF status, and an Enable button when it is OFF', () => {
    const html = render({ state: OFF });
    assert.match(html, /<h1>AI Protocol Assistant<\/h1>/);
    assert.match(html, /data-testid="ai-status">OFF</);
    assert.match(html, />Enable AI Assistant</);
    assert.doesNotMatch(html, />Disable AI Assistant</);
    assert.match(html, /switched off/);
  });
  it('shows ON and a Disable button when it is ON, with a link to the public page', () => {
    const html = render({ state: ON });
    assert.match(html, /data-testid="ai-status">ON</);
    assert.match(html, />Disable AI Assistant</);
    assert.doesNotMatch(html, />Enable AI Assistant</);
    assert.match(html, /<a href="\/find-protocol">Open the public page<\/a>/);
  });
  it('explains when it is switched on but visitors still cannot use it (a required website feature is off)', () => {
    const html = render({ state: { enabled: true, available: false, blockedBy: ['PROTOCOL_BROWSER'] } });
    assert.match(html, /role="alert"/);
    assert.match(html, /the public protocol browser is turned off/);
    assert.doesNotMatch(html, /Open the public page/);
    assert.match(render({ state: { enabled: true, available: false, blockedBy: ['WEBSITE', 'PROTOCOL_BROWSER'] } }), /the public website and the public protocol browser are turned off/);
  });
  it('while saving, the button is disabled and says so; while loading there is no status yet; errors are shown as alerts', () => {
    assert.match(render({ state: OFF, busy: true }), /<button[^>]*disabled=""[^>]*>Saving…<\/button>/);
    const loading = render({ loading: true });
    assert.match(loading, /Loading…/);
    assert.doesNotMatch(loading, /ai-status|Enable AI|Disable AI/);
    assert.match(render({ error: 'Not authenticated.' }), /role="alert">Not authenticated\./);
  });
  it('tells the admin plainly what it does and does not do (published only, no outside AI, nothing saved, not medical)', () => {
    const html = render({ state: OFF });
    assert.match(html, /only suggests protocols that are published/);
    assert.match(html, /does not use any outside AI service/);
    assert.match(html, /not saved or sent anywhere/);
    assert.match(html, /never diagnoses/);
  });
  it('says doctors cannot change the setting, and offers a way back to the dashboard', () => {
    const html = render({ state: OFF });
    assert.match(html, /Doctors cannot change this setting/);
    assert.match(html, /<a href="\/dashboard"[^>]*>← Dashboard<\/a>/);
  });
  it('escapes anything it shows', () => {
    assert.doesNotMatch(render({ error: '<img src=x onerror=alert(1)>' }), /<img src=x/);
  });
  it('the real page mounts without throwing and starts in its loading state', () => {
    const html = renderToStaticMarkup(h(AdminAiSettingsPage));
    assert.match(html, /<h1>AI Protocol Assistant<\/h1>/);
    assert.match(html, /Loading…/);
  });

  describe('talking to the backend', () => {
    it('reads GET /admin/ai and returns the normalised state', async () => {
      api.handler = () => ({ data: { key: 'AI_ASSESSMENT', enabled: true, available: true, blockedBy: [], extra: 'x' } });
      assert.deepEqual(await fetchAiState(api), ON);
      assert.deepEqual(api.calls.map((c) => [c.method, c.url]), [['get', '/admin/ai']]);
    });
    it('enabling POSTs /admin/ai/enable and disabling POSTs /admin/ai/disable — nothing else', async () => {
      api.handler = (url) => ({ data: url.endsWith('/enable') ? { enabled: true, available: true, blockedBy: [] } : { enabled: false, available: false, blockedBy: [] } });
      assert.deepEqual(await setAiEnabled(true, api), ON);
      assert.deepEqual(await setAiEnabled(false, api), OFF);
      assert.deepEqual(api.calls.map((c) => [c.method, c.url]), [['post', '/admin/ai/enable'], ['post', '/admin/ai/disable']]);
      assert.equal(AI_ADMIN_API, '/admin/ai');
    });
    it('a malformed answer is an error, never a guessed state', async () => {
      for (const data of [null, {}, 'on', { enabled: 'true' }, { enabled: 1 }, []]) {
        api.reset(); api.handler = () => ({ data });
        await assert.rejects(() => fetchAiState(api), /could not be read/, JSON.stringify(data));
        await assert.rejects(() => setAiEnabled(true, api), /could not be updated/, JSON.stringify(data));
      }
    });
    it('a failed request (not signed in, not an admin) rejects with the server error', async () => {
      api.handler = () => { throw Object.assign(new Error('You do not have permission to do that.'), { status: 403 }); };
      await assert.rejects(() => fetchAiState(api), /permission/);
      await assert.rejects(() => setAiEnabled(true, api), /permission/);
    });
    it('normaliseAiState keeps only enabled / available / blockedBy', () => {
      assert.deepEqual(normalizeAiState({ enabled: false, available: 'yes', blockedBy: ['WEBSITE', 5, null], key: 'AI_ASSESSMENT', secret: 1 }), { enabled: false, available: false, blockedBy: ['WEBSITE'] });
      assert.equal(normalizeAiState(undefined), null);
    });
  });
});

describe('[DETERMINISTIC] who can reach the admin AI page', () => {
  it('/admin/ai is declared inside the ADMIN-only protected route, next to /admin/conditions', () => {
    const app = read('App.jsx');
    const adminBlock = app.slice(app.indexOf('<ProtectedRoute role="admin" />'), app.indexOf('<ProtectedRoute role="patient" />'));
    assert.match(adminBlock, /path="\/admin\/ai" element=\{<AdminAiSettingsPage \/>\}/);
    assert.match(adminBlock, /path="\/admin\/conditions"/);
    const doctorBlock = app.slice(app.indexOf("roles={['doctor', 'admin']}"), app.indexOf('<ProtectedRoute role="admin" />'));
    assert.doesNotMatch(doctorBlock, /admin\/ai/);
  });
  it('the dashboard shows the link only to admins', () => {
    assert.match(read('pages/DashboardPage.jsx'), /\{user\.role === 'admin' && <Link to="\/admin\/ai" className="btn">AI Assistant<\/Link>\}/);
  });
  it('the page keeps nothing in the browser and holds no flag logic of its own', () => {
    const src = code('pages/admin/AdminAiSettingsPage.jsx');
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/);
    assert.doesNotMatch(src, /feature_flags|AI_ASSESSMENT|\/flags|api\.(put|delete|patch)/);
  });
  it('the public pages never call the admin AI endpoint', () => {
    for (const f of ['ai/aiAssistantClient.js', 'pages/public/FindProtocolPage.jsx', 'pages/public/FindProtocolLink.jsx']) assert.doesNotMatch(code(f), /admin/i, f);
  });
});
