/**
 * [DETERMINISTIC · rendering + client logic] Payment Phase 1 (free launch): the "Get Your Protocol" access step on the
 * protocol page, its client, and the admin Payment Access page. Nothing here uses a payment SDK, key or network.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import api from './support/stubs/apiClient.mjs';
import { __setRouteParams, __reset } from './support/stubs/reactRouter.mjs';
import { loadComponent, RENDER_SKIP } from './support/renderJsx.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const read = (rel) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const noop = () => {};
const render = (C, props = {}) => renderToStaticMarkup(h(C, props));
const FORBIDDEN = /payment successful|transaction completed|₹0 payment|\bpaid\b|payment complete/i;

let AccessPanelView; let ProtocolDetailsView; let client; let Admin; let AdminPaymentsView;

const detail = { slug: 'headache-relief', name: 'Headache Relief Protocol', displayName: 'Headache Relief', description: 'A gentle routine.', category: null, conditions: [] };
const renderData = { contract: 'protocol-render/1', protocol: { slug: 'headache-relief' }, canvases: [{ viewKey: 'left_front', label: 'Left Front', width: 1586, height: 1982, background: { url: '/static/hands/left_front.png' }, objects: [{ type: 'dot', x: 0.4, y: 0.5, width: 0.03, color: '#e5484d', opacity: 1, zIndex: 1, metadata: {} }] }] };
const base = { loading: false, error: null, detail, render: renderData, downloading: false, downloadError: null, onDownload: noop };
const FREE_STATUS = { accessEnabled: true, mode: 'FREE', free: true, canCheckout: true, price: null, message: 'x' };
const OK_ACCESS = { accessId: '11111111-1111-4111-8111-111111111111', status: 'free', mode: 'FREE', unlocked: true, protocol: { slug: 'headache-relief', name: 'Headache Relief' } };

describe('[DETERMINISTIC · rendering] the "Get Your Protocol" access step', { skip: RENDER_SKIP }, () => {
  before(async () => {
    ({ AccessPanelView } = await loadComponent('src/pages/public/AccessPanel.jsx'));
    ({ ProtocolDetailsView } = await loadComponent('src/pages/public/ProtocolDetailsPage.jsx'));
    client = await loadComponent('src/access/accessClient.js');
    ({ default: Admin, AdminPaymentsView } = await loadComponent('src/pages/admin/AdminPaymentsPage.jsx'));
  });
  beforeEach(() => { api.reset(); __reset(); });

  it('shows "Get Your Protocol", "Free during launch" and the button "Get Protocol — Free Now"', () => {
    const html = render(AccessPanelView, { phase: 'ready', onGet: noop });
    assert.match(html, /Get Your Protocol/);
    assert.match(html, /Free during launch/);
    assert.match(html, />Get Protocol — Free Now</);
    assert.match(html, /For now, protocols are completely free — no payment required\./);
  });

  it('separates what is true NOW (FREE NOW) from what is planned LATER (Secure online payment)', () => {
    const html = render(AccessPanelView, { phase: 'ready' });
    assert.match(html, /FREE NOW/);
    assert.match(html, /No payment is required right now\./);
    assert.match(html, /Secure online payment/);
    assert.match(html, /Payment will be introduced in a future release\./);
    assert.match(html, /pv-access-future/);
  });

  it('is not a payment page: no inputs, no card/UPI/bank wording, no price promised', () => {
    const html = render(AccessPanelView, { phase: 'ready' });
    assert.doesNotMatch(html, /<input|<form|card number|cvv|upi|net ?banking|password/i);
    assert.doesNotMatch(html, /₹\s?\d|\$\s?\d|Rs\.?\s?\d/);
  });

  it('the success state says "Free access activated" / "Protocol unlocked — free during launch" and never claims a payment', () => {
    const html = render(AccessPanelView, { phase: 'done' });
    assert.match(html, /Free access activated/);
    assert.match(html, /Protocol unlocked — free during launch/);
    assert.doesNotMatch(html, FORBIDDEN);
  });

  it('no phase ever shows paid / payment-successful / transaction wording', () => {
    // The one required refusal sentence starts "Paid checkout is not configured yet" — it says nothing was paid, so it is allowed.
    const strip = (t) => t.replace(client.ACCESS_TEXT.notConfigured, '');
    for (const phase of ['ready', 'working', 'done', 'error', 'notConfigured']) assert.doesNotMatch(strip(render(AccessPanelView, { phase })), FORBIDDEN, phase);
    for (const v of Object.values(client.ACCESS_TEXT)) assert.doesNotMatch(strip(v), FORBIDDEN);
  });

  it('while working the button is disabled; on error a retry stays possible; "not configured" shows the backend wording and no button', () => {
    assert.match(render(AccessPanelView, { phase: 'working' }), /<button[^>]*disabled=""[^>]*>Activating…<\/button>/);
    const err = render(AccessPanelView, { phase: 'error' });
    assert.match(err, /role="alert"/);
    assert.match(err, />Get Protocol — Free Now</);
    const nc = render(AccessPanelView, { phase: 'notConfigured' });
    assert.match(nc, /Paid checkout is not configured yet\. Protocols remain available for free during the launch period\./);
    assert.doesNotMatch(nc, /<button/);
  });

  describe('on the protocol page', () => {
    const locked = { checked: true, required: true, unlocked: false, phase: 'ready', get: noop };
    const open = { checked: true, required: true, unlocked: true, phase: 'done', get: noop };
    it('before access: the access step is shown and the protocol (markings and downloads) is not', () => {
      const html = render(ProtocolDetailsView, { ...base, access: locked });
      assert.match(html, /Get Your Protocol/);
      assert.match(html, /Get Protocol — Free Now/);
      assert.match(html, /<h1>Headache Relief<\/h1>/);
      assert.doesNotMatch(html, /Download PDF|Protocol Markings|Copy link/);
    });
    it('after access: "Free access activated" and the full protocol are shown', () => {
      const html = render(ProtocolDetailsView, { ...base, access: open });
      assert.match(html, /Free access activated/);
      assert.match(html, /Download PDF/);
      assert.match(html, /Protocol Markings/);
      assert.doesNotMatch(html, />Get Protocol — Free Now</);
    });
    it('when the access step is not required (off, unknown or unreachable) the protocol is simply shown, as before', () => {
      for (const access of [{ checked: true, required: false, unlocked: false, phase: 'ready' }, { checked: false, required: false, unlocked: false, phase: 'ready' }]) {
        const html = render(ProtocolDetailsView, { ...base, access });
        assert.match(html, /Download PDF/);
        assert.match(html, /Protocol Markings/);
        assert.doesNotMatch(html, /Get Your Protocol/);
      }
    });
    it('PAID with no provider: the notice is shown and the protocol stays available', () => {
      const html = render(ProtocolDetailsView, { ...base, access: { checked: true, required: false, unlocked: false, phase: 'notConfigured' } });
      assert.match(html, /Paid checkout is not configured yet/);
      assert.match(html, /Download PDF/);
    });
    it('without the optional `access` prop the page is exactly the old page', () => {
      const html = render(ProtocolDetailsView, base);
      assert.doesNotMatch(html, /Get Your Protocol|pv-access/);
      assert.match(html, /Download PDF/);
    });
    it('the real page mounts and starts in its loading state', async () => {
      __setRouteParams({ slug: 'headache-relief' });
      const { default: Page } = await loadComponent('src/pages/public/ProtocolDetailsPage.jsx');
      assert.match(render(Page), /Loading protocol/);
    });
  });

  describe('the client (backend decides; the browser only displays)', () => {
    it('asks POST /public/protocols/:slug/access with an empty body, and is unlocked only when the backend says unlocked', async () => {
      api.handler = () => ({ data: OK_ACCESS });
      const out = await client.requestProtocolAccess('headache-relief', null, api);
      assert.equal(out.access.unlocked, true);
      assert.deepEqual(api.calls.map((c) => [c.method, c.url, c.body]), [['post', '/public/protocols/headache-relief/access', {}]]);
    });
    it('sends only the remembered access id on a retry — never an amount, a "paid" flag or any payment data', async () => {
      api.handler = () => ({ data: OK_ACCESS });
      await client.requestProtocolAccess('headache-relief', OK_ACCESS.accessId, api);
      assert.deepEqual(api.calls[0].body, { accessId: OK_ACCESS.accessId });
    });
    it('a reply that is not an unlocked record (locked, malformed, empty) is a failure, not a guess', async () => {
      for (const data of [{ ...OK_ACCESS, unlocked: false }, { accessId: 5 }, null, {}, 'ok']) {
        api.reset(); api.handler = () => ({ data });
        assert.deepEqual(await client.requestProtocolAccess('x', null, api), { error: 'failed' }, JSON.stringify(data));
      }
    });
    it('a 503 from the backend maps to "not configured"; other failures to "failed"', async () => {
      api.handler = () => { throw Object.assign(new Error('x'), { status: 503 }); };
      assert.deepEqual(await client.requestProtocolAccess('x', null, api), { error: 'notConfigured' });
      api.handler = () => { throw Object.assign(new Error('x'), { status: 404 }); };
      assert.deepEqual(await client.requestProtocolAccess('x', null, api), { error: 'failed' });
      api.handler = () => { throw new Error('offline'); };
      assert.deepEqual(await client.requestProtocolAccess('x', null, api), { error: 'failed' });
    });
    it('status: reads GET /public/payment/status; a malformed or unreachable answer is "unknown" (null)', async () => {
      api.handler = () => ({ data: FREE_STATUS });
      assert.deepEqual(await client.fetchPaymentStatus(api), { accessEnabled: true, mode: 'FREE', free: true, canCheckout: true });
      for (const data of [null, {}, { accessEnabled: 'yes' }]) { api.handler = () => ({ data }); assert.equal(await client.fetchPaymentStatus(api), null); }
      api.handler = () => { throw new Error('down'); };
      assert.equal(await client.fetchPaymentStatus(api), null);
    });
    it('a remembered access record only counts if the backend confirms it for THIS protocol', async () => {
      api.handler = () => ({ data: OK_ACCESS });
      assert.ok(await client.checkAccessRecord(OK_ACCESS.accessId, 'headache-relief', api));
      assert.equal(await client.checkAccessRecord(OK_ACCESS.accessId, 'other-protocol', api), null);
      api.handler = () => ({ data: { ...OK_ACCESS, unlocked: false } });
      assert.equal(await client.checkAccessRecord(OK_ACCESS.accessId, 'headache-relief', api), null);
      api.handler = () => { throw Object.assign(new Error('x'), { status: 404 }); };
      assert.equal(await client.checkAccessRecord(OK_ACCESS.accessId, 'headache-relief', api), null);
    });
    it('decides whether the access step applies: unknown/off -> shown protocol; PAID without checkout -> notice; FREE -> required', () => {
      assert.deepEqual(client.decideAccessStep(null), { required: false, phase: 'ready' });
      assert.deepEqual(client.decideAccessStep({ accessEnabled: false, canCheckout: false }), { required: false, phase: 'ready' });
      assert.deepEqual(client.decideAccessStep({ accessEnabled: true, mode: 'PAID', canCheckout: false }), { required: false, phase: 'notConfigured' });
      assert.deepEqual(client.decideAccessStep({ accessEnabled: true, mode: 'FREE', canCheckout: true }), { required: true, phase: 'ready' });
    });
    it('local storage being unavailable never throws', () => {
      assert.equal(client.rememberedAccessId('x'), null);
      client.rememberAccessId('x', 'id');
      client.forgetAccessId('x');
    });
  });

  describe('Admin Payment Access page', () => {
    const FREE = { mode: 'FREE', accessEnabled: true, launchMessage: 'Protocols are currently free.', futureAmount: null, currency: 'INR', futureProvider: null, chargingActive: false };
    const view = (props) => render(AdminPaymentsView, { state: null, loading: false, error: null, busy: false, ...props });
    it('shows the FREE launch state: mode, message, ₹____, INR, "Not configured", charging OFF', () => {
      const html = view({ state: FREE });
      assert.match(html, /<h1>Payment Access<\/h1>/);
      assert.match(html, /data-testid="payment-mode">FREE</);
      assert.match(html, /Protocols are currently free\./);
      assert.match(html, /₹____/);
      assert.match(html, /INR/);
      assert.match(html, /Not configured/);
      assert.match(html, /data-testid="charging-status">OFF</);
      assert.match(html, /Doctors cannot change this setting/);
      assert.match(html, />Switch to PAID mode</);
    });
    it('PAID without a provider says plainly that nothing is charged', () => {
      const html = view({ state: { ...FREE, mode: 'PAID', launchMessage: 'x' } });
      assert.match(html, /data-testid="payment-mode">PAID</);
      assert.match(html, /Paid checkout is not configured yet\. Protocols remain available for free during the launch period\./);
      assert.match(html, /data-testid="charging-status">OFF</);
      assert.match(html, />Switch to FREE mode</);
    });
    it('shows a stored future amount without enabling anything', () => {
      assert.match(view({ state: { ...FREE, futureAmount: 199.5 } }), /₹199\.5/);
    });
    it('loading and error states; errors are escaped', () => {
      assert.match(view({ loading: true }), /Loading…/);
      assert.match(view({ error: '<img src=x onerror=alert(1)>' }), /role="alert"/);
      assert.doesNotMatch(view({ error: '<img src=x onerror=alert(1)>' }), /<img src=x/);
    });
    it('the real page mounts in its loading state', () => {
      assert.match(render(Admin), /Loading…/);
    });
    it('reads GET /admin/payments/settings and saves with POST to the same path — nothing else', async () => {
      const page = await loadComponent('src/pages/admin/AdminPaymentsPage.jsx');
      api.handler = () => ({ data: FREE });
      assert.deepEqual(await page.fetchPaymentSettings(api), FREE);
      await page.savePaymentSettings({ mode: 'PAID' }, api);
      assert.deepEqual(api.calls.map((c) => [c.method, c.url]), [['get', '/admin/payments/settings'], ['post', '/admin/payments/settings']]);
      assert.deepEqual(api.calls[1].body, { mode: 'PAID' });
    });
    it('a malformed answer is an error, never a guessed state; a refusal (403) rejects', async () => {
      const page = await loadComponent('src/pages/admin/AdminPaymentsPage.jsx');
      for (const data of [null, {}, { mode: 'free' }, { mode: 'MAYBE' }]) { api.handler = () => ({ data }); await assert.rejects(() => page.fetchPaymentSettings(api), /could not be read/); }
      api.handler = () => { throw Object.assign(new Error('You do not have permission to do that.'), { status: 403 }); };
      await assert.rejects(() => page.fetchPaymentSettings(api), /permission/);
    });
  });
});

describe('[DETERMINISTIC] who can reach the payment settings page, and what ships', () => {
  it('/admin/payments is declared inside the ADMIN-only protected route (never the doctor one)', () => {
    const app = read('App.jsx');
    const adminBlock = app.slice(app.indexOf('<ProtectedRoute role="admin" />'), app.indexOf('<ProtectedRoute role="patient" />'));
    assert.match(adminBlock, /path="\/admin\/payments" element=\{<AdminPaymentsPage \/>\}/);
    const doctorBlock = app.slice(app.indexOf("roles={['doctor', 'admin']}"), app.indexOf('<ProtectedRoute role="admin" />'));
    assert.doesNotMatch(doctorBlock, /admin\/payments/);
    const publicPart = app.slice(0, app.indexOf("roles={['doctor', 'admin']}"));
    assert.doesNotMatch(publicPart, /admin\/payments/);
  });
  it('the dashboard link is admin-only', () => {
    assert.match(read('pages/DashboardPage.jsx'), /\{user\.role === 'admin' && <Link to="\/admin\/payments" className="btn">Payment Access<\/Link>\}/);
  });
  it('public pages never call admin endpoints; the access client talks only to the three public endpoints', () => {
    const c = code('access/accessClient.js') + code('pages/public/AccessPanel.jsx');
    assert.doesNotMatch(c, /admin/i);
    const paths = [...new Set(c.match(/[`'](\/public\/[^`']*)[`']/g))].map((x) => x.slice(1, -1)).sort();
    assert.deepEqual(paths, ['/public/access/${encodeURIComponent(id)}', '/public/payment/status', '/public/protocols/${encodeURIComponent(slug)}/access']);
  });
  it('no payment SDK, gateway key or external payment request exists in the frontend', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    assert.doesNotMatch(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' '), /stripe|razorpay|paypal|paytm|cashfree|braintree|payu/i);
    const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const f of walk(SRC).filter((p) => /\.(jsx?|mjs)$/.test(p))) {
      const src = readFileSync(f, 'utf8');
      assert.doesNotMatch(src, /checkout\.razorpay|js\.stripe\.com|paypal\.com\/sdk|rzp_(live|test)_|pk_(live|test)_/, f);
    }
  });
  it('the access step stores only an opaque id — no card, amount or unlock flag — and is wrapped against unavailable storage', () => {
    const c = code('access/accessClient.js');
    assert.match(c, /try \{ return window\.localStorage/);
    assert.doesNotMatch(c, /sessionStorage|document\.cookie|cardNumber|cvv|upiPin/i);
  });
});
