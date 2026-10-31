/**
 * The single, code-level source of truth for which feature flags EXIST, what
 * they mean, their initial state, and which flags depend on which.
 *
 * Pure data: no database access, so it can be imported anywhere (including
 * at route-definition time, to catch a mistyped flag name at startup).
 *
 * `default` is used only when a flag has no row in the database. The
 * database (table feature_flags, seeded by migration 003) holds the live
 * state. `requires` lists flags that must ALSO be enabled for this one to
 * count as enabled.
 */
const FLAG_DEFINITIONS = Object.freeze({
  WEBSITE: { default: true, requires: [], description: 'Public website' },
  PROTOCOL_BROWSER: { default: true, requires: [], description: 'Public protocol browser' },
  ADMIN: { default: true, requires: [], description: 'Admin area' },
  PROTOCOL_STUDIO: { default: true, requires: [], description: 'Protocol Studio (doctor/admin protocol authoring API)' },
  DOWNLOAD: { default: true, requires: [], description: 'Protocol downloads' },

  AI_ASSESSMENT: { default: false, requires: [], description: 'AI-assisted symptom assessment' },
  PAYMENTS: { default: false, requires: [], description: 'Payments' },
  CAMERA: { default: false, requires: [], description: 'Camera access on public pages' },
  AR: { default: false, requires: ['CAMERA'], description: 'Augmented-reality overlay (requires CAMERA)' },
  PATIENT_ACCOUNTS: { default: false, requires: [], description: 'Legacy patient accounts' },
  PATIENT_ASSIGNMENT: {
    default: false,
    requires: ['PATIENT_ACCOUNTS'],
    description: 'Legacy protocol-to-patient assignment (requires PATIENT_ACCOUNTS)',
  },
});

const FLAG_KEYS = Object.freeze(Object.keys(FLAG_DEFINITIONS));

function isKnownFlag(key) {
  return Object.prototype.hasOwnProperty.call(FLAG_DEFINITIONS, key);
}

function assertKnownFlag(key) {
  if (!isKnownFlag(key)) {
    throw new Error(`Unknown feature flag "${key}". Known flags: ${FLAG_KEYS.join(', ')}`);
  }
}

/** Flags that directly list `key` in their `requires`. */
function dependentsOf(key) {
  return FLAG_KEYS.filter((k) => FLAG_DEFINITIONS[k].requires.includes(key));
}

module.exports = { FLAG_DEFINITIONS, FLAG_KEYS, isKnownFlag, assertKnownFlag, dependentsOf };
