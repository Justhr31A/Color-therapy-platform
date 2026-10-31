'use strict';

const { FLAG_DEFINITIONS, FLAG_KEYS, assertKnownFlag, dependentsOf } = require('./featureFlagDefinitions');
const { createFeatureFlagRepository } = require('../repositories/featureFlags.repo');

class FeatureFlagError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FeatureFlagError';
    this.code = code; // UNKNOWN_FLAG | DEPENDENCY_DISABLED | DEPENDENT_ENABLED
  }
}

/**
 * Feature flag service.
 *
 * A flag counts as ENABLED ("effective") only if its stored value is on AND
 * every flag it requires is effectively enabled. That rule is applied when
 * reading, not just when writing, so even a hand-edited database cannot end
 * up with e.g. AR active while CAMERA is off.
 */
/** `db` is the PostgreSQL app database (or a transaction handle). Every method is async. */
function createFeatureFlagService(db) {
  const repo = createFeatureFlagRepository(db);

  async function loadStored() {
    const map = new Map();
    (await repo.getAll()).forEach((row) => map.set(row.key, row));
    return map;
  }

  function storedEnabled(key, stored) {
    const row = stored.get(key);
    // A missing row falls back to the code-level default rather than failing.
    return row ? row.enabled === 1 : FLAG_DEFINITIONS[key].default;
  }

  function effective(key, stored) {
    if (!storedEnabled(key, stored)) return false;
    return FLAG_DEFINITIONS[key].requires.every((dep) => effective(dep, stored));
  }

  const service = {
    /** True only if the flag and all of its prerequisites are on. Throws for an unknown flag (a programming error). */
    async isEnabled(key) {
      assertKnownFlag(key);
      return effective(key, await loadStored());
    },

    /** Several flags from ONE read of the table (each answer is the same rule as isEnabled). */
    async areEnabled(keys) {
      keys.forEach(assertKnownFlag);
      const stored = await loadStored();
      return keys.map((key) => effective(key, stored));
    },

    async listFlags() {
      const stored = await loadStored();
      return FLAG_KEYS.map((key) => {
        const def = FLAG_DEFINITIONS[key];
        return {
          key,
          description: def.description,
          requires: def.requires,
          stored: storedEnabled(key, stored),
          enabled: effective(key, stored),
          blockedBy: def.requires.filter((dep) => !effective(dep, stored)),
        };
      });
    },

    /**
     * Turns a flag on/off, enforcing dependencies:
     *  - cannot enable a flag whose prerequisite is off (AR needs CAMERA);
     *  - cannot disable a flag while something that requires it is on
     *    (turn AR off before CAMERA) — so no hidden "on but inert" states.
     */
    async setFlag(key, enabled, { actorId = null } = {}) {
      if (!Object.prototype.hasOwnProperty.call(FLAG_DEFINITIONS, key)) {
        throw new FeatureFlagError('UNKNOWN_FLAG', `Unknown feature flag "${key}". Known flags: ${FLAG_KEYS.join(', ')}`);
      }
      const stored = await loadStored();

      if (enabled) {
        const unmet = FLAG_DEFINITIONS[key].requires.filter((dep) => !effective(dep, stored));
        if (unmet.length) {
          throw new FeatureFlagError('DEPENDENCY_DISABLED', `Cannot enable ${key}: it requires ${unmet.join(', ')} to be enabled first.`);
        }
      } else {
        const activeDependents = dependentsOf(key).filter((dep) => storedEnabled(dep, stored));
        if (activeDependents.length) {
          throw new FeatureFlagError(
            'DEPENDENT_ENABLED',
            `Cannot disable ${key} while ${activeDependents.join(', ')} ${activeDependents.length > 1 ? 'are' : 'is'} enabled. Disable ${activeDependents.join(', ')} first.`
          );
        }
      }
      await repo.upsert(key, enabled, FLAG_DEFINITIONS[key].description, actorId);
      return (await service.listFlags()).find((f) => f.key === key);
    },
  };
  return service;
}

module.exports = { createFeatureFlagService, FeatureFlagError };
