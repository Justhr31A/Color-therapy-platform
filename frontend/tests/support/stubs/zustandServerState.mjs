/**
 * TEST-ONLY wrapper around the real zustand, used solely when src/builder/store.js is loaded under Node (see
 * resolve-hook.mjs). zustand 4.5.x renders on the server from the store's INITIAL state, so a test that injects
 * state with setState() and then calls renderToStaticMarkup() would see the pre-injection state. This wrapper
 * makes the server snapshot equal the current state. It is real zustand underneath; production code is untouched.
 */
import { createStore, useStore } from 'zustand';

export function create(initializer) {
  const api = createStore(initializer);
  api.getServerState = api.getState;
  const useBoundStore = (selector) => useStore(api, selector);
  Object.assign(useBoundStore, api);
  return useBoundStore;
}

export default create;
