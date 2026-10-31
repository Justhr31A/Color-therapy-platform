'use strict';

const crypto = require('crypto');
const { createPaymentsRepository } = require('../repositories/payments.repo');
const { createRegistry } = require('./providers/registry');
const { HttpError } = require('../utils/errors');
const { isValidSlug } = require('../services/slug');

/** Exact wording the product asked for. Never "paid" / "payment successful" / "transaction completed". */
const MESSAGES = Object.freeze({
  freeActivated: 'Free access activated — protocol unlocked, free during our launch period.',
  notConfigured: 'Paid checkout is not configured yet. Protocols remain available for free during the launch period.',
  accessOff: 'Protocol access is not available right now.',
  notFound: 'Protocol not found.',
});

const MODES = ['FREE', 'PAID'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MINOR = 100000000 * 100; // 1 crore in major units — a sanity ceiling, not a price
const str = (v) => (typeof v === 'string' ? v.slice(0, 200) : null); // provider-supplied text is length-capped before storing

/**
 * Payment Phase 1 service: protocol ACCESS decisions, entirely on the backend.
 *
 * FREE (the default): granting access calls no gateway, creates no charge and records a 'free' access row.
 * PAID (future): a real provider must be registered AND configured AND the PAYMENTS flag on; otherwise checkout is
 * refused and nothing is granted. Even then access is only granted after provider verification — the browser's word
 * ("I paid", an amount, an unlocked flag) is never read.
 *
 * `findPublished(slug)` must return { protocolId, versionId, slug, name } for a currently PUBLISHED protocol, else null.
 */
function createPaymentService({ db, flags, findPublished, registry = createRegistry(), idFactory = () => crypto.randomUUID() }) {
  const repo = createPaymentsRepository(db);

  const settings = async () => {
    const s = (await repo.getSettings()) || { mode: 'FREE', access_enabled: 1, amount_minor: null, currency: 'INR', provider: null };
    return {
      mode: s.mode === 'PAID' ? 'PAID' : 'FREE',
      accessEnabled: s.access_enabled === 1,
      amountMinor: s.amount_minor,
      currency: s.currency || 'INR',
      provider: s.provider || null,
      updatedAt: s.updated_at || null,
    };
  };

  /** The real provider that could charge right now, or null. All three conditions are required. */
  async function activeProvider(s = null) {
    const current = s || await settings();
    if (current.mode !== 'PAID') return null;
    if (!(await flags.isEnabled('PAYMENTS'))) return null;
    return registry.getReal(current.provider);
  }

  const chargingActive = async (s = null) => (await activeProvider(s)) !== null;

  const present = (order, found) => {
    const unlocked = (order.status === 'free' || order.status === 'paid') && !!found;
    return {
      accessId: order.id,
      status: order.status,
      mode: order.mode,
      unlocked,
      protocol: found ? { slug: found.slug, name: found.name } : null,
      message: unlocked && order.status === 'free' ? MESSAGES.freeActivated : unlocked ? 'Protocol unlocked.' : null,
    };
  };

  async function publicStatus() {
    const s = await settings();
    const canCheckout = s.mode === 'FREE' || await chargingActive(s);
    return {
      accessEnabled: s.accessEnabled,
      mode: s.mode,
      free: s.mode === 'FREE',
      canCheckout: s.accessEnabled && canCheckout,
      // Only a configured future price is ever shown; nothing is promised otherwise.
      price: s.mode === 'PAID' && s.amountMinor !== null ? { amountMinor: s.amountMinor, currency: s.currency } : null,
      message: s.mode === 'FREE' ? 'Protocols are free during our launch period. No payment is required right now.' : null,
    };
  }

  async function adminState() {
    const s = await settings();
    return {
      mode: s.mode,
      accessEnabled: s.accessEnabled,
      launchMessage: s.mode === 'FREE' ? 'Protocols are currently free.' : 'Paid mode is selected, but nothing is charged until a payment provider is configured.',
      futureAmount: s.amountMinor === null ? null : s.amountMinor / 100,
      futureAmountMinor: s.amountMinor,
      currency: s.currency,
      futureProvider: s.provider && registry.getReal(s.provider) ? s.provider : null,
      providerConfigured: registry.realNames().length > 0 && !!registry.getReal(s.provider),
      chargingActive: await chargingActive(s),
      updatedAt: s.updatedAt,
    };
  }

  async function updateSettings(input, actorId) {
    const body = input && typeof input === 'object' ? input : {};
    const cur = await settings();
    const next = { ...cur };
    if (body.mode !== undefined) {
      if (!MODES.includes(body.mode)) throw new HttpError(400, 'mode must be FREE or PAID.');
      next.mode = body.mode;
    }
    if (body.accessEnabled !== undefined) {
      if (typeof body.accessEnabled !== 'boolean') throw new HttpError(400, 'accessEnabled must be true or false.');
      next.accessEnabled = body.accessEnabled;
    }
    if (body.futureAmount !== undefined) {
      if (body.futureAmount === null || body.futureAmount === '') next.amountMinor = null;
      else {
        const n = Number(body.futureAmount);
        const minor = Math.round(n * 100);
        if (!Number.isFinite(n) || n < 0 || minor > MAX_MINOR || Math.abs(n * 100 - minor) > 1e-6) {
          throw new HttpError(400, 'futureAmount must be a number of 0 or more with at most two decimals.');
        }
        next.amountMinor = minor;
      }
    }
    if (body.currency !== undefined) {
      if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) throw new HttpError(400, 'currency must be a 3-letter code such as INR.');
      next.currency = body.currency;
    }
    // The provider cannot be chosen from the API in Phase 1 (none exists); any value in the request is ignored.
    await repo.saveSettings({ mode: next.mode, accessEnabled: next.accessEnabled, amountMinor: next.amountMinor, currency: next.currency, updatedBy: actorId });
    return adminState();
  }

  const nowIso = () => new Date().toISOString();

  async function requestAccess({ slug, userId = null, accessId = null }) {
    const s = await settings();
    if (!s.accessEnabled) throw new HttpError(503, MESSAGES.accessOff, { code: 'ACCESS_OFF' });
    const found = isValidSlug(slug) ? await findPublished(slug) : null;
    if (!found) throw new HttpError(404, MESSAGES.notFound);

    // Idempotent retry: the same accessId for the same protocol never creates a second record.
    if (typeof accessId === 'string' && UUID_RE.test(accessId)) {
      const existing = await repo.getOrder(accessId);
      if (existing && existing.protocol_id === found.protocolId && (existing.status === 'free' || existing.status === 'paid')) {
        return present(existing, found);
      }
    }

    if (s.mode === 'FREE') {
      const provider = registry.free;
      await provider.createOrder({ orderId: null, amountMinor: 0, currency: s.currency, protocol: found.slug });
      const id = idFactory();
      await repo.insertOrder({
        id, userId, protocolId: found.protocolId, versionId: found.versionId, amountMinor: 0, currency: s.currency,
        status: 'free', mode: 'FREE', provider: provider.id, providerOrderId: null, completedAt: nowIso(),
      });
      return present(await repo.getOrder(id), found);
    }

    // PAID: refuse unless a real provider is registered, configured and the PAYMENTS flag is on. Nothing is stored.
    const provider = await activeProvider(s);
    if (!provider || s.amountMinor === null) throw new HttpError(503, MESSAGES.notConfigured, { code: 'PAYMENT_NOT_CONFIGURED' });
    const id = idFactory();
    let created;
    try {
      created = await provider.createOrder({ orderId: id, amountMinor: s.amountMinor, currency: s.currency, protocol: found.slug });
    } catch (e) {
      throw new HttpError(502, 'Checkout could not be started. Please try again later.', { code: 'PAYMENT_PROVIDER_ERROR' });
    }
    const status = ['pending', 'created'].includes(created && created.status) ? created.status : 'pending'; // a provider can never create a paid order directly
    await repo.insertOrder({
      id, userId, protocolId: found.protocolId, versionId: found.versionId, amountMinor: s.amountMinor, currency: s.currency,
      status, mode: 'PAID', provider: provider.id, providerOrderId: str(created && created.providerOrderId), completedAt: null,
    });
    return present(await repo.getOrder(id), found);
  }

  /** Re-reads the published state NOW: an access record never keeps an archived/unpublished protocol reachable. */
  async function currentFound(order) {
    const slug = await repo.findPublishedSlug(order.protocol_id);
    return slug ? findPublished(slug) : null;
  }

  async function getAccess(accessId) {
    if (typeof accessId !== 'string' || !UUID_RE.test(accessId)) throw new HttpError(404, 'Access record not found.');
    const order = await repo.getOrder(accessId);
    if (!order) throw new HttpError(404, 'Access record not found.');
    return present(order, await currentFound(order));
  }

  /** PAID only. The provider decides; the request body is passed through and never stored. */
  async function verifyAccess(accessId, evidence) {
    const order = typeof accessId === 'string' && UUID_RE.test(accessId) ? await repo.getOrder(accessId) : null;
    if (!order) throw new HttpError(404, 'Access record not found.');
    if (order.mode !== 'PAID' || order.status === 'free') return present(order, await currentFound(order));
    if (order.status === 'paid') return present(order, await currentFound(order));
    const provider = registry.getReal(order.provider);
    if (!provider || !(await flags.isEnabled('PAYMENTS'))) throw new HttpError(503, MESSAGES.notConfigured, { code: 'PAYMENT_NOT_CONFIGURED' });
    let result;
    try {
      result = await provider.verifyPayment({ order: { id: order.id, providerOrderId: order.provider_order_id, amountMinor: order.amount_minor, currency: order.currency }, evidence });
    } catch (e) {
      throw new HttpError(502, 'Payment could not be verified. Please try again later.', { code: 'PAYMENT_PROVIDER_ERROR' });
    }
    if (result && result.paid === true) {
      await repo.updateOrder(order.id, { status: 'paid', providerPaymentId: str(result.providerPaymentId), providerReference: str(result.reference), completed: true });
    } else {
      await repo.updateOrder(order.id, { status: 'failed', completed: false });
    }
    return present(await repo.getOrder(order.id), await currentFound(order));
  }

  return { MESSAGES, settings, publicStatus, adminState, updateSettings, requestAccess, getAccess, verifyAccess, chargingActive };
}

module.exports = { createPaymentService, MESSAGES };
