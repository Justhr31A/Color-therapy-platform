const crypto = require('crypto');

/**
 * Slugs: lowercase, URL-safe, deterministic from a name, collision-safe.
 *   "Headache Relief Protocol" -> "headache-relief-protocol"
 * English/Latin only for now (decision #8): characters with no Latin form are
 * dropped, and a name that yields nothing falls back to a default word.
 */
const MAX_SLUG_LENGTH = 80;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugify(input, { fallback = 'item' } = {}) {
  let s = String(input === null || input === undefined ? '' : input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents: "Café" -> "Cafe"
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > MAX_SLUG_LENGTH) s = s.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
  return s || fallback;
}

function isValidSlug(value) {
  return typeof value === 'string' && value.length <= MAX_SLUG_LENGTH && SLUG_RE.test(value);
}

/**
 * Returns `base` if free, otherwise base-2, base-3, ... (deterministic for a
 * given database state). The base is trimmed when needed so the suffix always
 * fits inside MAX_SLUG_LENGTH. `exists(candidate)` must return true if taken.
 */
function uniqueSlug(base, exists, { maxAttempts = 1000 } = {}) {
  if (!exists(base)) return base;
  for (let n = 2; n <= maxAttempts; n += 1) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '') + suffix;
    if (!exists(candidate)) return candidate;
  }
  // Practically unreachable; keeps the function total instead of looping forever.
  const suffix = `-${crypto.randomBytes(4).toString('hex')}`;
  return base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '') + suffix;
}

/** Same rule as uniqueSlug, for an asynchronous `exists(candidate)` (database lookups). */
async function uniqueSlugAsync(base, exists, { maxAttempts = 1000 } = {}) {
  if (!(await exists(base))) return base;
  for (let n = 2; n <= maxAttempts; n += 1) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '') + suffix;
    // eslint-disable-next-line no-await-in-loop
    if (!(await exists(candidate))) return candidate;
  }
  const suffix = `-${crypto.randomBytes(4).toString('hex')}`;
  return base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '') + suffix;
}

module.exports = { slugify, isValidSlug, uniqueSlug, uniqueSlugAsync, MAX_SLUG_LENGTH };
