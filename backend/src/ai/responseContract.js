const { OUTCOMES, TEXT } = require('./constants');

/**
 * The ONE shape the public ever receives from the protocol assistant (Stage 2). Every response is built here, field
 * by field, from the backend's own decision and the published protocol's public fields. Nothing a provider said can
 * reach it: not a link, not HTML, not an id, not protocol content.
 *
 *   { status: 'match',         protocol: { slug, name, description }, message, actions: [{ type, label }...], disclaimer }
 *   { status: 'clarification', question, disclaimer }
 *   { status: 'no_match',      message, disclaimer }
 *   { status: 'disabled' }
 *
 * `actions` names what the page may offer for a match. It contains only a fixed type and a fixed label — never a URL:
 * the page builds the protocol link itself from `protocol.slug` using the public route it already has.
 * Internal details (intent, scores, tiers, runner-up candidates, the flag's state) are never part of a response.
 */
const STATUS = Object.freeze({ MATCH: 'match', CLARIFICATION: 'clarification', NO_MATCH: 'no_match', DISABLED: 'disabled' });

const ACTION_TYPES = Object.freeze({ VIEW_PROTOCOL: 'view_protocol', DOWNLOAD_PDF: 'download_pdf', COPY_LINK: 'copy_link' });
const MATCH_ACTIONS = Object.freeze([
  Object.freeze({ type: ACTION_TYPES.VIEW_PROTOCOL, label: 'View Protocol' }),
  Object.freeze({ type: ACTION_TYPES.DOWNLOAD_PDF, label: 'Download PDF' }),
  Object.freeze({ type: ACTION_TYPES.COPY_LINK, label: 'Copy Link' }),
]);

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_MAX = 300;
const NAME_MAX = 200;

const plain = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const disabled = () => ({ status: STATUS.DISABLED });
const noMatch = () => ({ status: STATUS.NO_MATCH, message: TEXT.NO_MATCH, disclaimer: TEXT.DISCLAIMER });

/** @param {object} result the assistant service's internal decision (see assistantService.handle) */
function toPublicResponse(result) {
  if (!result || typeof result !== 'object') return noMatch();

  if (result.outcome === OUTCOMES.RECOMMENDATION) {
    const r = result.recommendation;
    // A slug that is not a plain slug could never be a published protocol; refuse rather than pass it on.
    if (!r || typeof r.slug !== 'string' || !SLUG_PATTERN.test(r.slug)) return noMatch();
    const name = plain(r.displayName || r.name, NAME_MAX);
    if (!name) return noMatch();
    return {
      status: STATUS.MATCH,
      protocol: { slug: r.slug, name, description: plain(r.shortDescription || r.description, DESCRIPTION_MAX) },
      message: result.message === TEXT.REASON_DIRECT ? TEXT.REASON_DIRECT : TEXT.REASON_RELEVANT,
      actions: MATCH_ACTIONS.map((a) => ({ type: a.type, label: a.label })),
      disclaimer: TEXT.DISCLAIMER,
    };
  }

  if (result.outcome === OUTCOMES.FOLLOW_UP) {
    const question = result.followUp && typeof result.followUp.question === 'string' ? result.followUp.question : '';
    if (!question) return noMatch();
    return { status: STATUS.CLARIFICATION, question, disclaimer: TEXT.DISCLAIMER };
  }

  return noMatch();
}

module.exports = { STATUS, ACTION_TYPES, MATCH_ACTIONS, SLUG_PATTERN, toPublicResponse, disabledResponse: disabled };
