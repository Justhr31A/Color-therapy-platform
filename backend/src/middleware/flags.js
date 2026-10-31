'use strict';

const { assertKnownFlag } = require('../services/featureFlagDefinitions');

let defaultService = null;
// The default service (PostgreSQL) is created on first use, so a test that injects its own
// service can import this middleware without opening a database connection.
function getService() {
  if (!defaultService) {
    // eslint-disable-next-line global-require
    const { createFeatureFlagService } = require('../services/featureFlags');
    // eslint-disable-next-line global-require
    const db = require('../db');
    defaultService = createFeatureFlagService(db);
  }
  return defaultService;
}

/**
 * Express middleware: the backend gate for a feature. When the flag (or a
 * prerequisite) is off the API answers 404 "Not found" — the feature simply
 * does not exist as far as callers can tell (a 403 would advertise that it
 * does). Frontend checks are only UI convenience; this is the enforcement.
 *
 * Passing an unknown flag name throws immediately when the route is being
 * defined, so a typo fails at startup instead of silently never gating.
 *
 * Place it AFTER requireAuth/requireRole so unauthenticated callers cannot
 * probe which features are switched on.
 */
function requireFlag(key, { service } = {}) {
  assertKnownFlag(key);
  return async (req, res, next) => {
    try {
      const svc = service || getService();
      if (!(await svc.isEnabled(key))) {
        return res.status(404).json({ error: 'Not found.' });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireFlag };
