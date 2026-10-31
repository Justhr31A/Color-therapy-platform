import api from '../api/client';

/**
 * The browser's side of the AI Protocol Assistant: two calls to the PUBLIC backend API (no login, no key).
 *
 *   GET  /api/public/ai/status              -> { enabled }          whether to offer the feature at all
 *   POST /api/public/ai/protocol-assistant  -> the assistant's answer
 *
 * Nothing here stores anything: the person's words go in the POST body, are used for that one request, and live
 * only in the page's memory (never localStorage, sessionStorage, cookies or the URL). The AI provider and its key
 * exist only on the backend.
 */

export const STATUS_PATH = '/public/ai/status';
export const ASSISTANT_PATH = '/public/ai/protocol-assistant';
export const MESSAGE_MAX = 500;
export const ANSWER_MAX = 300;

/** What went wrong, in terms a page can act on: 'disabled' | 'invalid' | 'unavailable' | 'network'. */
export class AssistantError extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'AssistantError';
    this.kind = kind;
  }
}

function kindOf(err) {
  const status = err && err.status;
  if (status === 404) return 'disabled'; // the feature is off (the backend answers 404 exactly like an unknown route)
  if (status === 400 || status === 413) return 'invalid';
  if (typeof status === 'number') return 'unavailable'; // 503 (provider down) and anything else the server says
  return 'network'; // no response at all
}

let statusPromise = null;

/**
 * Is the assistant switched on? Asked once per page load and shared by everything that needs it (the header link,
 * the home page, the assistant page). Any failure counts as "not available" — the entry point just stays hidden.
 */
export function fetchAssistantStatus({ force = false } = {}) {
  if (!statusPromise || force) {
    statusPromise = api.get(STATUS_PATH).then((res) => Boolean(res.data && res.data.enabled === true)).catch(() => false);
  }
  return statusPromise;
}
export function resetAssistantStatusCache() { statusPromise = null; }

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTION_TYPES = ['view_protocol', 'download_pdf', 'copy_link'];
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Keeps only what the page needs, and refuses anything that is not a well-formed answer. The backend contract is
 * exactly one of (see backend/src/ai/responseContract.js):
 *   { status: 'match', protocol: { slug, name, description }, message, actions: [{ type, label }], disclaimer }
 *   { status: 'clarification', question, disclaimer }
 *   { status: 'no_match', message, disclaimer }
 *   { status: 'disabled' }
 * Nothing else is read: no HTML, no URLs, no ids. The page builds the protocol link itself from the slug.
 */
export function normalizeAssistantResponse(data) {
  const d = data && typeof data === 'object' ? data : {};
  const disclaimer = text(d.disclaimer, 1000);
  if (d.status === 'match') {
    const p = d.protocol;
    if (!p || typeof p.slug !== 'string' || !SLUG_PATTERN.test(p.slug)) throw new AssistantError('unavailable');
    const actions = Array.isArray(d.actions)
      ? d.actions
        .filter((a) => a && ACTION_TYPES.includes(a.type) && typeof a.label === 'string' && a.label.trim() && a.label.length <= 40)
        .map((a) => ({ type: a.type, label: a.label }))
      : [];
    return {
      status: 'match',
      protocol: { slug: p.slug, name: text(p.name, 200) || p.slug, description: text(p.description, 300) },
      message: text(d.message, 500),
      actions,
      disclaimer,
    };
  }
  if (d.status === 'clarification') {
    const question = text(d.question, 300);
    if (!question) throw new AssistantError('unavailable');
    return { status: 'clarification', question, disclaimer };
  }
  if (d.status === 'no_match') return { status: 'no_match', message: text(d.message, 500), disclaimer };
  if (d.status === 'disabled') return { status: 'disabled' };
  throw new AssistantError('unavailable');
}

/**
 * Ask the assistant. `followUpAnswer` is only sent for the one clarifying question, together with the ORIGINAL message
 * (the backend keeps no conversation: nothing is remembered between the two calls except in this page's memory).
 * @returns {Promise<{ status: 'match'|'clarification'|'no_match'|'disabled', ... }>}
 * @throws {AssistantError}
 */
export async function askProtocolAssistant({ message, followUpAnswer } = {}) {
  const body = { message: String(message == null ? '' : message).trim() };
  const answer = followUpAnswer == null ? '' : String(followUpAnswer).trim();
  if (answer) body.followUpAnswer = answer;
  let res;
  try {
    res = await api.post(ASSISTANT_PATH, body);
  } catch (err) {
    throw new AssistantError(kindOf(err));
  }
  return normalizeAssistantResponse(res.data);
}
