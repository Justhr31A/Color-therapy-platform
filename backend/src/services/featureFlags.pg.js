
const { createFeatureFlagRepository } = require('../repositories/featureFlags.pg.repo');
const { FLAG_DEFINITIONS, FLAG_KEYS } = require('./featureFlagDefinitions');

class FeatureFlagError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FeatureFlagError';
    this.code = code;
  }
}

function createFeatureFlagService(db) {
  const repo = createFeatureFlagRepository(db);

  async function loadStored() {
    const rows = await repo.getAll();
    return new Map(rows.map((row) => [row.key, row]));
  }

  function storedEnabled(key, stored) {
    const row = stored.get(key);
    return row ? Number(row.enabled) === 1 : FLAG_DEFINITIONS[key].default;
  }

  function effective(key, stored) {
    if (!storedEnabled(key, stored)) return false;
    return FLAG_DEFINITIONS[key].requires.every((dep) => effective(dep, stored));
  }

  async function listFlags() {
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
  }

  async function isEnabled(key) {
    if (!Object.prototype.hasOwnProperty.call(FLAG_DEFINITIONS, key)) {
      throw new FeatureFlagError('UNKNOWN_FLAG', `Unknown feature flag "${key}".`);
    }
    return effective(key, await loadStored());
  }

  async function setFlag(key, enabled, { actorId = null } = {}) {
    if (!Object.prototype.hasOwnProperty.call(FLAG_DEFINITIONS, key)) {
      throw new FeatureFlagError('UNKNOWN_FLAG', `Unknown feature flag "${key}".`);
    }

    const stored = await loadStored();
    const def = FLAG_DEFINITIONS[key];

    if (enabled) {
      const unmet = def.requires.filter((dep) => !effective(dep, stored));
      if (unmet.length) {
        throw new FeatureFlagError(
          'DEPENDENCY_DISABLED',
          `Cannot enable ${key}: enable ${unmet.join(', ')} first.`
        );
      }
    } else {
      const activeDependents = FLAG_KEYS.filter(
        (candidate) =>
          FLAG_DEFINITIONS[candidate].requires.includes(key) &&
          storedEnabled(candidate, stored)
      );

      if (activeDependents.length) {
        throw new FeatureFlagError(
          'DEPENDENT_ENABLED',
          `Cannot disable ${key} while ${activeDependents.join(', ')} is enabled.`
        );
      }
    }

    await repo.upsert(key, enabled, def.description, actorId);
    return (await listFlags()).find((flag) => flag.key === key);
  }

  return { isEnabled, listFlags, setFlag };
}

module.exports = { createFeatureFlagService, FeatureFlagError };
