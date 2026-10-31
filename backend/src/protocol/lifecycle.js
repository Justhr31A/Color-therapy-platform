/**
 * Protocol lifecycle rules (pure functions).
 *
 *   draft ──▶ in_review ──▶ (publish) ──▶ published ──▶ archived ──▶ draft
 *
 * `status` describes the protocol's workflow state. Which content is PUBLIC is
 * decided only by `published_version_id` + status === 'published'; editing the
 * working copy (canvases/objects/metadata) never changes what the public sees.
 *
 * "active" is the LEGACY status used by the old patient-assignment flow
 * ("released to the assigned patient"). It stays valid so existing rows and the
 * existing builder dropdown keep working, but it is never public.
 */
const STATUSES = Object.freeze(['draft', 'in_review', 'published', 'archived']);
const LEGACY_STATUSES = Object.freeze(['active']);
const ALL_STATUSES = Object.freeze([...STATUSES, ...LEGACY_STATUSES]);

// Targets reachable through a plain status change. 'published' is NEVER a
// target here — only the explicit publish action can produce it.
const TRANSITIONS = Object.freeze({
  draft: ['in_review', 'archived', 'active'],
  in_review: ['draft', 'archived', 'active'],
  active: ['draft', 'in_review', 'archived'],
  published: ['archived'],
  archived: ['draft'],
});

// Statuses from which the publish action is allowed.
const PUBLISHABLE_FROM = Object.freeze(['draft', 'in_review', 'active', 'published']);

/**
 * @returns {{ok:true}|{ok:false, reason:string, code:string}}
 */
function checkStatusChange(from, to, { allowLegacy = false } = {}) {
  if (!ALL_STATUSES.includes(to)) {
    return { ok: false, code: 'UNKNOWN_STATUS', reason: `Unknown status "${to}". Allowed: ${STATUSES.join(', ')}.` };
  }
  if (to === 'published') {
    return { ok: false, code: 'USE_PUBLISH', reason: 'A protocol becomes published only through the explicit publish action.' };
  }
  if (LEGACY_STATUSES.includes(to) && !allowLegacy) {
    return { ok: false, code: 'UNKNOWN_STATUS', reason: `Unknown status "${to}". Allowed: ${STATUSES.join(', ')}.` };
  }
  if (from === to) return { ok: true };
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    const hint = from === 'published' ? ' Archive it instead; a published protocol cannot be moved back to draft.' : '';
    return { ok: false, code: 'INVALID_TRANSITION', reason: `Cannot change status from "${from}" to "${to}".${hint}` };
  }
  return { ok: true };
}

function canPublishFrom(status) {
  return PUBLISHABLE_FROM.includes(status);
}

/** A public visitor may see a protocol only when both conditions hold. */
function isPubliclyVisible(row) {
  return Boolean(row) && row.status === 'published' && Boolean(row.published_version_id);
}

module.exports = { STATUSES, LEGACY_STATUSES, ALL_STATUSES, TRANSITIONS, checkStatusChange, canPublishFrom, isPubliclyVisible };
