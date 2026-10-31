'use strict';
/** Forward rejected async Express handlers to the configured error middleware (Express 4 compatible). */
module.exports = function asyncRoute(handler) {
  return function wrappedAsyncRoute(req, res, next) {
    return Promise.resolve(handler(req, res, next)).catch(next);
  };
};
