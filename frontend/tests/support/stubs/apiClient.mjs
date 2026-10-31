// Test double for src/api/client.js (see resolve-hook.mjs for why it is needed).
const api = {
  calls: [],
  handler: null, // set a function (url, body) => ({ data }) to script server responses
  reset() { api.calls = []; api.handler = null; },
  async post(url, body) {
    api.calls.push({ method: 'post', url, body });
    return api.handler ? api.handler(url, body) : { data: null };
  },
  // `config` (e.g. { params: {...} }) is additive: existing handlers that only read `url` are unaffected;
  // a handler can optionally read the second argument for query-parameter-aware responses.
  async get(url, config) {
    api.calls.push({ method: 'get', url, params: config && config.params });
    return api.handler ? api.handler(url, config) : { data: null };
  },
  async put(url, body) {
    api.calls.push({ method: 'put', url, body });
    return api.handler ? api.handler(url, body) : { data: null };
  },
};
export default api;
export const baseURL = 'http://test.invalid';
