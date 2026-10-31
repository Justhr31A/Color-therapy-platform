/**
 * The launch-period provider. It moves no money and contacts nobody: it only says "this access is free".
 * No key, no SDK, no network (`external: false`) — a test asserts that.
 */
const freeProvider = Object.freeze({
  id: 'free',
  external: false,
  createOrder() {
    return { status: 'free' };
  },
  verifyPayment() {
    // Nothing was ever charged, so nothing can be "verified as paid".
    return { paid: false };
  },
  getOrderStatus() {
    return { status: 'free' };
  },
});

module.exports = { freeProvider };
