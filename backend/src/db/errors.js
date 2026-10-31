'use strict';

/**
 * PostgreSQL error classification. The app maps a constraint race (two requests passing the same
 * pre-check) to a clean 409; everything else stays a 500 whose message is never sent to the caller.
 * Codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const UNIQUE_VIOLATION = '23505';

/** True for a unique_violation, optionally only on one named constraint or unique index. */
function isUniqueViolation(err, constraint = null) {
  if (!err || err.code !== UNIQUE_VIOLATION) return false;
  return constraint ? err.constraint === constraint : true;
}

module.exports = { isUniqueViolation, UNIQUE_VIOLATION };
