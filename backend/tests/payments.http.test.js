/**
 * [DETERMINISTIC SOFTWARE TESTS — HTTP level, real server.js + real PostgreSQL]
 * Payment Phase 1: free launch + payment-ready architecture.
 * No payment SDK, key or network is involved anywhere: the only provider that exists is the free one.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { HTTP_SKIP, bootstrap, dot } = require('./helpers/httpHarness');

const A = '/api/admin';
const SET = '/api/admin/payments/settings';
const STATUS = '/api/public/payment/status';
const access = (slug) => `/api/public/protocols/${slug}/access`;

describe('[DETERMINISTIC · HTTP] payment access (free launch)', { skip: HTTP_SKIP }, () => {
  let h;
  let pub; // a published protocol
  // insert_seq-free table: created_at (microsecond precision in storage) then id gives insertion order
  const orders = () => h.rows('SELECT * FROM payment_orders ORDER BY created_at, id COLLATE "C"');
  const settingsRow = () => h.row('SELECT * FROM payment_settings');
  const flag = async (k) => (await h.row('SELECT enabled FROM feature_flags WHERE key = $1', k)).enabled;
  const setFlag = async (key, enabled) => {
    const { createFeatureFlagService } = require('../src/services/featureFlags'); // eslint-disable-line global-require
    await createFeatureFlagService(h.db).setFlag(key, enabled);
  };

  async function make(name, { publish = true } = {}) {
    const r = await h.admin.post(`${A}/protocols`, { name });
    assert.equal(r.status, 201, r.text);
    const p = r.json;
    await h.admin.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects: [dot({ id: `o-${p.slug}` })] }] });
    if (publish) assert.equal((await h.admin.post(`${A}/protocols/${p.id}/publish`, {})).status, 201);
    return p;
  }

  before(async () => {
    h = await bootstrap();
    pub = await make('Back Pain Relief');
  });
  after(async () => { if (h) await h.stop(); });

  it('a fresh database is in FREE mode with charging off, and the PAYMENTS feature flag is untouched (off)', async () => {
    assert.deepEqual({ mode: (await settingsRow()).mode, enabled: (await settingsRow()).access_enabled }, { mode: 'FREE', enabled: 1 });
    assert.equal(await flag('PAYMENTS'), 0);
    const s = (await h.anon.get(STATUS)).json;
    assert.equal(s.mode, 'FREE');
    assert.equal(s.free, true);
    assert.equal(s.accessEnabled, true);
    assert.equal(s.canCheckout, true);
    assert.equal(s.price, null);
    assert.match(s.message, /free/i);
    const a = (await h.admin.get(SET)).json;
    assert.equal(a.mode, 'FREE');
    assert.equal(a.launchMessage, 'Protocols are currently free.');
    assert.equal(a.chargingActive, false);
    assert.equal(a.futureProvider, null);
    assert.equal(a.currency, 'INR');
    assert.equal(a.futureAmount, null);
  });

  it('anonymous FREE access to a published protocol works with no account, and is recorded as a free access record', async () => {
    const r = await h.anon.post(access(pub.slug), {});
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.unlocked, true);
    assert.equal(r.json.status, 'free');
    assert.equal(r.json.mode, 'FREE');
    assert.equal(r.json.protocol.slug, pub.slug);
    assert.match(r.json.message, /free access activated/i);
    const rows = (await orders());
    assert.equal(rows.length, 1);
    const o = rows[0];
    assert.equal(o.status, 'free');
    assert.equal(o.mode, 'FREE');
    assert.equal(o.provider, 'free');
    assert.equal(o.amount_minor, 0);
    assert.equal(o.user_id, null);
    assert.ok(o.completed_at);
    const v = await h.row('SELECT published_version_id, id FROM protocols WHERE slug = $1', pub.slug);
    assert.equal(o.protocol_id, v.id);
    assert.equal(o.protocol_version_id, v.published_version_id, 'the access record names the published version');
  });

  it('never claims a payment happened: no paid/transaction wording, no paid row, no provider internals in responses', async () => {
    const r = await h.anon.post(access(pub.slug), {});
    const text = r.text;
    assert.doesNotMatch(text, /payment successful|transaction completed|\bpaid\b|₹0 payment/i);
    for (const k of ['provider', 'signature', 'providerOrderId', 'providerPaymentId', 'amount']) assert.ok(!(k in r.json), `no "${k}" in the response`);
    assert.equal((await orders()).filter((o) => o.status === 'paid').length, 0);
    assert.equal((await orders()).filter((o) => o.mode === 'PAID').length, 0);
  });

  it('the access record can be read back by its id, and an invalid or unknown id is a 404', async () => {
    const made = (await h.anon.post(access(pub.slug), {})).json;
    const got = await h.anon.get(`/api/public/access/${made.accessId}`);
    assert.equal(got.status, 200);
    assert.equal(got.json.unlocked, true);
    assert.equal(got.json.protocol.slug, pub.slug);
    assert.equal((await h.anon.get('/api/public/access/not-an-id')).status, 404);
    assert.equal((await h.anon.get('/api/public/access/00000000-0000-4000-8000-000000000000')).status, 404);
  });

  it('retrying with the same accessId does not create another record', async () => {
    const first = (await h.anon.post(access(pub.slug), {})).json;
    const before_ = (await orders()).length;
    const again = await h.anon.post(access(pub.slug), { accessId: first.accessId });
    assert.equal(again.json.accessId, first.accessId);
    assert.equal((await orders()).length, before_);
  });

  it('a signed-in user is linked to the record, but is not required', async () => {
    const r = await h.patient.post(access(pub.slug), {});
    assert.equal(r.status, 201);
    assert.equal((await h.row('SELECT user_id FROM payment_orders WHERE id = $1', r.json.accessId)).user_id, 'pat-1');
  });

  it('only PUBLISHED protocols can be unlocked: draft, in-review, archived and unknown are all the same 404, and store nothing', async () => {
    const draft = await make('Draft Only', { publish: false });
    const review = await make('In Review One', { publish: false });
    await h.admin.post(`${A}/protocols/${review.id}/status`, { status: 'in_review' });
    const arch = await make('Archived One');
    await h.admin.post(`${A}/protocols/${arch.id}/archive`);
    const before_ = (await orders()).length;
    const bodies = [];
    for (const slug of [draft.slug, review.slug, arch.slug, 'no-such-protocol', 'Bad Slug!!', '..%2f..']) {
      const r = await h.anon.post(access(slug), {});
      assert.equal(r.status, 404, slug);
      bodies.push(r.text);
    }
    assert.equal(new Set(bodies).size, 1, 'identical response whatever the reason');
    assert.equal((await orders()).length, before_);
  });

  it('an access record stops unlocking when its protocol is later archived', async () => {
    const p = await make('Later Archived');
    const made = (await h.anon.post(access(p.slug), {})).json;
    assert.equal(made.unlocked, true);
    await h.admin.post(`${A}/protocols/${p.id}/archive`);
    const got = (await h.anon.get(`/api/public/access/${made.accessId}`)).json;
    assert.equal(got.unlocked, false);
    assert.equal(got.protocol, null);
  });

  describe('settings: admin only', () => {
    it('anonymous 401, doctor 403, patient 403 — on reads and writes — and nothing changes', async () => {
      const before_ = JSON.stringify((await settingsRow()));
      for (const [who, code] of [['anon', 401], ['doctor', 403], ['patient', 403]]) {
        assert.equal((await h[who].get(SET)).status, code, `${who} GET`);
        assert.equal((await h[who].post(SET, { mode: 'PAID' })).status, code, `${who} POST`);
        assert.equal((await h[who].request('PUT', SET, { mode: 'PAID' })).status, code, `${who} PUT`);
      }
      assert.equal(JSON.stringify((await settingsRow())), before_);
    });

    it('the public side cannot change settings', async () => {
      for (const [m, u] of [['POST', STATUS], ['PUT', STATUS], ['POST', '/api/public/payment/settings'], ['POST', '/api/public/payment/mode']]) {
        await h.anon.request(m, u, { mode: 'PAID' });
      }
      assert.equal((await settingsRow()).mode, 'FREE');
    });

    it('rejects bad values with 400 and changes nothing', async () => {
      const before_ = JSON.stringify((await settingsRow()));
      for (const bad of [{ mode: 'FREEISH' }, { mode: 5 }, { futureAmount: -1 }, { futureAmount: 'abc' }, { futureAmount: 10.123 }, { currency: 'inr' }, { currency: 'RUPEES' }, { accessEnabled: 'yes' }]) {
        assert.equal((await h.admin.post(SET, bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal(JSON.stringify((await settingsRow())), before_);
    });

    it('the admin can store a future amount and currency (as integer minor units) without charging anything', async () => {
      const r = await h.admin.post(SET, { futureAmount: 199.5, currency: 'INR' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.futureAmount, 199.5);
      assert.equal((await settingsRow()).amount_minor, 19950);
      assert.equal(r.json.mode, 'FREE');
      assert.equal(r.json.chargingActive, false);
      assert.equal((await h.anon.get(STATUS)).json.price, null, 'FREE never shows or promises a price');
      assert.equal((await h.admin.post(SET, { futureAmount: null })).json.futureAmount, null);
    });
  });

  describe('PAID selected but no provider configured', () => {
    before(async () => {
      const r = await h.admin.post(SET, { mode: 'PAID', futureAmount: 100 });
      assert.equal(r.status, 200);
      assert.equal(r.json.mode, 'PAID');
      assert.equal(r.json.chargingActive, false);
      assert.equal(r.json.providerConfigured, false);
      assert.equal(r.json.futureProvider, null);
    });
    after(async () => { await h.admin.post(SET, { mode: 'FREE', futureAmount: null }); });

    it('checkout is refused safely with the product message; no order, no access, no charge', async () => {
      const before_ = (await orders()).length;
      const r = await h.anon.post(access(pub.slug), {});
      assert.equal(r.status, 503);
      assert.equal(r.json.error, 'Paid checkout is not configured yet. Protocols remain available for free during the launch period.');
      assert.equal((await orders()).length, before_);
    });

    it('also refused when the PAYMENTS flag is switched on — a flag alone cannot start charging', async () => {
      await setFlag('PAYMENTS', true);
      try {
        assert.equal((await h.anon.post(access(pub.slug), {})).status, 503);
        assert.equal((await h.admin.get(SET)).json.chargingActive, false);
      } finally {
        await setFlag('PAYMENTS', false);
      }
    });

    it('the public status says checkout is unavailable, and the verify endpoint cannot unlock anything', async () => {
      const s = (await h.anon.get(STATUS)).json;
      assert.equal(s.mode, 'PAID');
      assert.equal(s.canCheckout, false);
      const made = (await h.anon.post(access(pub.slug), {})); // refused, so nothing to verify
      assert.equal(made.status, 503);
      const fake = '11111111-1111-4111-8111-111111111111';
      await h.run("INSERT INTO payment_orders (id, protocol_id, protocol_version_id, amount_minor, status, mode, provider) SELECT $1, id, published_version_id, 100, 'pending', 'PAID', 'ghost' FROM protocols WHERE slug = $2", fake, pub.slug);
      const v = await h.anon.post(`/api/public/access/${fake}/verify`, { paid: true, status: 'paid', amount: 0 });
      assert.equal(v.status, 503);
      assert.equal((await h.row('SELECT status FROM payment_orders WHERE id = $1', fake)).status, 'pending');
      assert.equal((await h.anon.get(`/api/public/access/${fake}`)).json.unlocked, false);
      await h.run('DELETE FROM payment_orders WHERE id = $1', fake);
    });
  });

  it('the frontend cannot dictate the outcome: amount, "paid", status and unlocked in the body are ignored', async () => {
    const before_ = (await orders()).length;
    const r = await h.anon.post(access(pub.slug), { amount: 99999, paid: true, status: 'paid', unlocked: true, mode: 'PAID', provider: 'razorpay', amountMinor: 5 });
    assert.equal(r.status, 201);
    const o = (await orders())[before_];
    assert.equal(o.status, 'free');
    assert.equal(o.amount_minor, 0);
    assert.equal(o.mode, 'FREE');
    assert.equal(o.provider, 'free');
  });

  it('no card, CVV, bank or UPI data is ever stored: the schema has nowhere to put it and sent values are not persisted', async () => {
    const secrets = ['4111111111111111', '123-cvv-987', 'hunter2-bank-pw', 'upi-pin-5566'];
    await h.anon.post(access(pub.slug), { cardNumber: secrets[0], cvv: secrets[1], bankPassword: secrets[2], upiPin: secrets[3] });
    const dump = JSON.stringify([(await orders()), (await settingsRow())]);
    secrets.forEach((s) => assert.ok(!dump.includes(s), s));
    const cols = (await h.rows("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_orders' ORDER BY ordinal_position")).map((c) => c.name);
    assert.deepEqual(cols, ['id', 'user_id', 'protocol_id', 'protocol_version_id', 'amount_minor', 'currency', 'status', 'mode', 'provider', 'provider_order_id', 'provider_payment_id', 'provider_reference', 'created_at', 'updated_at', 'completed_at']);
    assert.ok(!cols.some((c) => /card|cvv|pin|password|pan/i.test(c)));
  });

  it('turning the access step off refuses new access with 503 but leaves public browsing alone', async () => {
    await h.admin.post(SET, { accessEnabled: false });
    try {
      assert.equal((await h.anon.post(access(pub.slug), {})).status, 503);
      assert.equal((await h.anon.get(`/api/public/protocols/${pub.slug}`)).status, 200);
      assert.equal((await h.anon.get(STATUS)).json.accessEnabled, false);
    } finally { await h.admin.post(SET, { accessEnabled: true }); }
  });

  it('existing public APIs and the AI assistant → protocol → access path still work', async () => {
    assert.equal((await h.anon.get('/api/public/protocols')).status, 200);
    assert.equal((await h.anon.get(`/api/public/protocols/${pub.slug}`)).status, 200);
    assert.equal((await h.anon.get(`/api/public/protocols/${pub.slug}/render`)).status, 200);
    assert.equal((await h.anon.get('/api/public/categories')).status, 200);
    assert.equal((await h.anon.get('/api/public/ai/status')).status, 200);
    assert.equal((await h.admin.post('/api/admin/ai/enable', {})).status, 200);
    const ai = (await h.anon.post('/api/public/ai/protocol-assistant', { message: 'Back Pain' })).json;
    assert.equal(ai.status, 'match');
    const unlocked = await h.anon.post(access(ai.protocol.slug), {});
    assert.equal(unlocked.status, 201);
    assert.equal(unlocked.json.unlocked, true);
    assert.equal((await h.admin.post('/api/admin/ai/disable', {})).status, 200);
    assert.equal((await h.anon.get('/api/health')).status, 200);
  });

  it('the public routes are gated by the website flags like the rest of /api/public', async () => {
    await setFlag('WEBSITE', false);
    try {
      assert.equal((await h.anon.get(STATUS)).status, 404);
      assert.equal((await h.anon.post(access(pub.slug), {})).status, 404);
    } finally {
      await setFlag('WEBSITE', true);
    }
  });

  it('no payment SDK, key or external payment request exists in the backend source or manifests', async () => {
    const root = path.join(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ');
    assert.doesNotMatch(deps, /stripe|razorpay|paypal|paytm|cashfree|braintree|square|payu|instamojo|phonepe/i);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = [...walk(path.join(root, 'src', 'payments')), path.join(root, 'src', 'routes', 'public.payments.routes.js'), path.join(root, 'src', 'routes', 'admin.payments.routes.js')];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      assert.doesNotMatch(src, /require\(['"](stripe|razorpay|paypal|@paypal|paytm|cashfree)/i, f);
      assert.doesNotMatch(src, /\bfetch\(|https?:\/\/|require\(['"](https?|axios|node-fetch|got)['"]\)/, `${path.basename(f)} makes no network calls`);
      assert.doesNotMatch(src, /process\.env\.\w*(KEY|SECRET)/i, `${path.basename(f)} reads no payment key`);
    }
    assert.equal(require('../src/payments/providers/freeProvider').freeProvider.external, false); // eslint-disable-line global-require
  });
});
