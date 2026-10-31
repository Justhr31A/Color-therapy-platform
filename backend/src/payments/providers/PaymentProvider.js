/**
 * The boundary every payment provider sits behind.
 *
 * A provider is a plain object with three methods (all may be async). The service never talks to a gateway any other
 * way, and nothing a provider returns reaches the public API except the normalised fields named below — provider
 * internals (keys, raw gateway payloads, signatures) stay in the backend.
 *
 *   id                                   short lowercase name, e.g. 'free'
 *   external                             true when the provider would call a payment gateway over the network
 *   createOrder({ orderId, amountMinor, currency, protocol })
 *        -> { status: 'free'|'pending'|'created', providerOrderId?: string }
 *   verifyPayment({ order, evidence })   `evidence` is whatever the future gateway hands the browser; it is passed
 *        straight to the provider and NEVER stored by the service.
 *        -> { paid: boolean, providerPaymentId?: string, reference?: string }
 *   getOrderStatus({ order })
 *        -> { status: 'created'|'pending'|'paid'|'failed'|'cancelled'|'free' }
 *
 * A real provider (Razorpay, Stripe, …) would live in its own file here and be registered in ./registry.js. Phase 1
 * ships NONE: only the free provider exists, and it needs no key, no SDK and no network.
 */
const METHODS = ['createOrder', 'verifyPayment', 'getOrderStatus'];

function assertProvider(p) {
  if (!p || typeof p.id !== 'string' || !p.id) throw new Error('A payment provider needs an id.');
  METHODS.forEach((m) => {
    if (typeof p[m] !== 'function') throw new Error(`Payment provider "${p.id}" is missing ${m}().`);
  });
  return p;
}

module.exports = { assertProvider, METHODS };
