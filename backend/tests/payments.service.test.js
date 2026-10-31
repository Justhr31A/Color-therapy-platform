/**
 * [DETERMINISTIC SOFTWARE TESTS — service level, real PostgreSQL]
 * The payment service with FAKE providers: proves the FREE path never touches a provider, and that the future PAID path
 * (provider boundary) grants access only after provider verification — never on the caller's say-so.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./helpers/publishingEnv');
const { missingReason } = require('./helpers/testDb');

const SKIP = missingReason('pg');

async function setup({ real = {}, flagOn = false } = {}) {
  const env = await makeEnv();
  const { createPaymentService } = require('../src/payments/paymentService'); // eslint-disable-line global-require
  const { createRegistry } = require('../src/payments/providers/registry'); // eslint-disable-line global-require
  const { createFeatureFlagService } = require('../src/services/featureFlags'); // eslint-disable-line global-require
  const id = await env.makePublishable('Neck Relief Protocol');
  await env.protocols.publish(id, {}, env.actor);
  const slug = (await env.row('SELECT slug FROM protocols WHERE id = $1', id)).slug;
  const flags = createFeatureFlagService(env.db);
  if (flagOn) await flags.setFlag('PAYMENTS', true);
  const findPublished = async (s) => {
    const r = (await env.row("SELECT p.id, p.slug, p.published_version_id v FROM protocols p WHERE p.slug = $1 AND p.status = 'published'", s));
    return r ? { protocolId: r.id, versionId: r.v, slug: r.slug, name: 'Neck Relief' } : null;
  };
  const svc = createPaymentService({ db: env.db, flags, findPublished, registry: createRegistry({ real }) });
  return { env, svc, slug, id };
}
const fakeProvider = (over = {}) => {
  const calls = [];
  return {
    calls,
    id: 'fake', external: true,
    createOrder: async (a) => { calls.push(['create', a]); return { status: 'pending', providerOrderId: 'ord_1' }; },
    verifyPayment: async (a) => { calls.push(['verify', a]); return { paid: true, providerPaymentId: 'pay_1', reference: 'ref_1' }; },
    getOrderStatus: async () => ({ status: 'pending' }),
    ...over,
  };
};

describe('[DETERMINISTIC] payment service', { skip: SKIP }, () => {
  it('FREE mode never calls a real provider, even when one is registered and configured', async () => {
    const p = fakeProvider();
    const { env, svc, slug } = await setup({ real: { fake: p }, flagOn: true });
    await env.run("UPDATE payment_settings SET provider = 'fake', amount_minor = 500");
    const r = await svc.requestAccess({ slug });
    assert.equal(r.unlocked, true);
    assert.equal(r.status, 'free');
    assert.deepEqual(p.calls, []);
    assert.equal((await env.row('SELECT amount_minor, provider FROM payment_orders')).amount_minor, 0);
    await env.cleanup();
  });

  it('the free provider reports nothing as paid', async () => {
    const { freeProvider } = require('../src/payments/providers/freeProvider'); // eslint-disable-line global-require
    assert.equal((await freeProvider.verifyPayment({})).paid, false);
    assert.equal((await freeProvider.getOrderStatus({})).status, 'free');
  });

  it('PAID with a configured provider: creates a PENDING order that does NOT unlock; verification unlocks it', async () => {
    const p = fakeProvider();
    const { env, svc, slug } = await setup({ real: { fake: p }, flagOn: true });
    await env.run("UPDATE payment_settings SET mode = 'PAID', provider = 'fake', amount_minor = 500");
    const r = await svc.requestAccess({ slug });
    assert.equal(r.status, 'pending');
    assert.equal(r.unlocked, false);
    assert.equal((await env.row('SELECT amount_minor, status FROM payment_orders')).amount_minor, 500);
    assert.equal((await svc.getAccess(r.accessId)).unlocked, false);
    const v = await svc.verifyAccess(r.accessId, { anything: 'the browser says' });
    assert.equal(v.status, 'paid');
    assert.equal(v.unlocked, true);
    const row = (await env.row('SELECT * FROM payment_orders'));
    assert.equal(row.provider_payment_id, 'pay_1');
    assert.ok(row.completed_at);
    await env.cleanup();
  });

  it('a provider that says not-paid leaves the order failed and locked; evidence is never stored', async () => {
    const p = fakeProvider({ verifyPayment: async () => ({ paid: false }) });
    const { env, svc, slug } = await setup({ real: { fake: p }, flagOn: true });
    await env.run("UPDATE payment_settings SET mode = 'PAID', provider = 'fake', amount_minor = 500");
    const r = await svc.requestAccess({ slug });
    const v = await svc.verifyAccess(r.accessId, { cardNumber: '4111111111111111', paid: true });
    assert.equal(v.unlocked, false);
    assert.equal(v.status, 'failed');
    assert.ok(!JSON.stringify((await env.rows('SELECT * FROM payment_orders'))).includes('4111111111111111'));
    await env.cleanup();
  });

  it('a provider cannot create an already-paid order: "paid" from createOrder is treated as pending', async () => {
    const p = fakeProvider({ createOrder: async () => ({ status: 'paid' }) });
    const { env, svc, slug } = await setup({ real: { fake: p }, flagOn: true });
    await env.run("UPDATE payment_settings SET mode = 'PAID', provider = 'fake', amount_minor = 500");
    const r = await svc.requestAccess({ slug });
    assert.equal(r.unlocked, false);
    assert.equal(r.status, 'pending');
    await env.cleanup();
  });

  it('a throwing provider gives a safe 502 and leaves no access', async () => {
    const p = fakeProvider({ createOrder: async () => { throw new Error('secret-gateway-detail'); } });
    const { env, svc, slug } = await setup({ real: { fake: p }, flagOn: true });
    await env.run("UPDATE payment_settings SET mode = 'PAID', provider = 'fake', amount_minor = 500");
    await assert.rejects(() => svc.requestAccess({ slug }), (e) => e.status === 502 && !/secret-gateway-detail/.test(e.message));
    assert.equal((await env.row('SELECT COUNT(*) n FROM payment_orders')).n, 0);
    await env.cleanup();
  });

  it('PAID needs all of: a registered provider, the PAYMENTS flag, and a configured amount', async () => {
    for (const [real, flagOn, amount] of [[{}, true, 500], [{ fake: fakeProvider() }, false, 500], [{ fake: fakeProvider() }, true, null]]) {
      const { env, svc, slug } = await setup({ real, flagOn });
      await env.run('UPDATE payment_settings SET mode = $1, provider = $2, amount_minor = $3', 'PAID', 'fake', amount);
      await assert.rejects(() => svc.requestAccess({ slug }), (e) => e.status === 503 && e.message === svc.MESSAGES.notConfigured);
      assert.equal((await env.row('SELECT COUNT(*) n FROM payment_orders')).n, 0);
      await env.cleanup();
    }
  });

  it('the provider boundary rejects an incomplete provider', async () => {
    const { createRegistry } = require('../src/payments/providers/registry'); // eslint-disable-line global-require
    assert.throws(() => createRegistry({ real: { bad: { id: 'bad' } } }), /missing createOrder/);
  });

  it('the payment schema is seeded as the SQLite migration 007 left it: PAYMENTS off, settings FREE/INR, constraints enforced', async () => {
    const { env } = await setup();
    assert.equal((await env.row("SELECT enabled FROM feature_flags WHERE key = 'PAYMENTS'")).enabled, 0);
    const s = (await env.row('SELECT * FROM payment_settings'));
    assert.deepEqual({ id: s.id, mode: s.mode, c: s.currency, a: s.access_enabled, amt: s.amount_minor, prov: s.provider }, { id: 1, mode: 'FREE', c: 'INR', a: 1, amt: null, prov: null });
    await assert.rejects(env.run("INSERT INTO payment_settings (id, mode) VALUES (2, 'FREE')"), /check constraint/i);
    await assert.rejects(env.run("UPDATE payment_settings SET mode = 'BOGUS'"), /check constraint/i);
    await env.cleanup();
  });
});
