const { assertProvider } = require('./PaymentProvider');
const { freeProvider } = require('./freeProvider');

/**
 * Which providers exist. Phase 1: only the free one. To add a real gateway later, create its provider file and
 * register it in REAL_PROVIDERS below — and nothing else in the service needs to change.
 * A real provider is "configured" only when it is registered AND its own credentials are present in the backend
 * environment (never in the database, never in the frontend).
 */
const REAL_PROVIDERS = {}; // intentionally empty in Phase 1

function createRegistry({ real = REAL_PROVIDERS } = {}) {
  const realMap = new Map(Object.entries(real).map(([k, v]) => [k, assertProvider(v)]));
  return {
    free: freeProvider,
    /** The configured real provider, or null. `name` is the provider setting (null/unknown -> null). */
    getReal(name) {
      return name && realMap.has(name) ? realMap.get(name) : null;
    },
    realNames() {
      return [...realMap.keys()];
    },
  };
}

module.exports = { createRegistry };
