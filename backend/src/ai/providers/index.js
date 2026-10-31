const { AIProvider } = require('./AIProvider');
const { MockProvider } = require('./mockProvider');

/**
 * Chooses the provider from the BACKEND environment. Stages 1 and 2 ship only the development provider:
 *
 *   AI_PROVIDER=mock   (the default) — no key, no network.
 *
 * A real provider (a future stage) is added here and will read its key from AI_API_KEY. Nothing reads that variable today. That key exists only in the server's
 * environment: it is never sent to the browser and never logged. Asking for a provider that is not available is an
 * explicit error (the assistant then answers "temporarily unavailable"), never a silent fallback to something else.
 */
const REGISTRY = Object.freeze({
  mock: () => new MockProvider(),
});

function createProvider(env = process.env) {
  const name = String(env.AI_PROVIDER || 'mock').trim().toLowerCase();
  const make = REGISTRY[name];
  if (!make) throw new Error(`AI provider "${name.slice(0, 40)}" is not available in this version`);
  return make(env);
}

module.exports = { AIProvider, MockProvider, createProvider, REGISTRY };
