import api from '../api/client';

/**
 * The browser's side of protocol access (Payment Phase 1: free launch). Three PUBLIC backend calls, no login, no key:
 *
 *   GET  /api/public/payment/status        -> whether the access step is shown, and whether it is free right now
 *   POST /api/public/protocols/:slug/access -> asks the BACKEND to unlock a published protocol
 *   GET  /api/public/access/:accessId       -> re-checks a remembered access record
 *
 * The browser never decides anything about money or unlocking: it displays what the backend says. The only thing
 * remembered locally is an opaque access id per protocol (localStorage, wrapped in try/catch because it can be
 * unavailable) — the backend re-validates it every time, so editing it unlocks nothing.
 */
export const STATUS_PATH = '/public/payment/status';
export const accessPath = (slug) => `/public/protocols/${encodeURIComponent(slug)}/access`;
export const accessRecordPath = (id) => `/public/access/${encodeURIComponent(id)}`;

/** The wording the product asked for. NEVER "payment successful", "paid" or "transaction completed". */
export const ACCESS_TEXT = Object.freeze({
  heading: 'Get Your Protocol',
  freeBadge: 'Free during launch',
  freeNow: 'FREE NOW',
  freeNowBody: 'Free during our launch period. No payment is required right now.',
  futureLabel: 'Secure online payment',
  futureBody: 'Normally, access to this protocol will be available through secure online payment. Payment will be introduced in a future release.',
  intro: 'Normally, access to this protocol will be available through secure online payment. For now, protocols are completely free — no payment required.',
  button: 'Get Protocol — Free Now',
  working: 'Activating…',
  success: 'Free access activated',
  successBody: 'Protocol unlocked — free during launch. Your protocol is available below.',
  notConfigured: 'Paid checkout is not configured yet. Protocols remain available for free during the launch period.',
  error: 'Access could not be activated right now. Please try again.',
});

const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');

/** Keeps only what the page needs; anything malformed is "unknown" (null) and the page simply shows the protocol. */
export function normalizeStatus(data) {
  if (!data || typeof data !== 'object' || typeof data.accessEnabled !== 'boolean') return null;
  return {
    accessEnabled: data.accessEnabled,
    mode: data.mode === 'PAID' ? 'PAID' : 'FREE',
    free: data.free === true,
    canCheckout: data.canCheckout === true,
  };
}

export function normalizeAccess(data) {
  if (!data || typeof data !== 'object' || typeof data.accessId !== 'string') return null;
  return {
    accessId: data.accessId,
    status: str(data.status, 20),
    unlocked: data.unlocked === true,
    slug: data.protocol && typeof data.protocol.slug === 'string' ? data.protocol.slug : null,
  };
}

/**
 * Pure decision: given the backend's status (or null = unknown), does the access step apply?
 * Unknown or switched off -> not required (the protocol is shown). Paid checkout unavailable -> not required, with the
 * "not configured" notice. Otherwise required: the visitor must get access first.
 */
export function decideAccessStep(status) {
  if (!status || !status.accessEnabled) return { required: false, phase: 'ready' };
  if (!status.canCheckout) return { required: false, phase: 'notConfigured' };
  return { required: true, phase: 'ready' };
}

export async function fetchPaymentStatus(client = api) {
  try {
    return normalizeStatus((await client.get(STATUS_PATH)).data);
  } catch (e) {
    return null; // unknown -> the protocol stays visible; an unreachable access step never locks anyone out
  }
}

/** Asks the backend to unlock `slug`. Resolves { access } or { error: 'unavailable'|'notConfigured'|'failed' }. */
export async function requestProtocolAccess(slug, previousId = null, client = api) {
  try {
    const res = await client.post(accessPath(slug), previousId ? { accessId: previousId } : {});
    const access = normalizeAccess(res.data);
    return access && access.unlocked ? { access } : { error: 'failed' };
  } catch (e) {
    if (e && e.status === 503) return { error: 'notConfigured' };
    return { error: 'failed' };
  }
}

export async function checkAccessRecord(id, slug, client = api) {
  try {
    const a = normalizeAccess((await client.get(accessRecordPath(id))).data);
    return a && a.unlocked && a.slug === slug ? a : null;
  } catch (e) {
    return null;
  }
}

const KEY = (slug) => `ctpp_access_${slug}`;
export function rememberedAccessId(slug) {
  try { return window.localStorage.getItem(KEY(slug)) || null; } catch (e) { return null; }
}
export function rememberAccessId(slug, id) {
  try { window.localStorage.setItem(KEY(slug), id); } catch (e) { /* storage unavailable: access still works for this visit */ }
}
export function forgetAccessId(slug) {
  try { window.localStorage.removeItem(KEY(slug)); } catch (e) { /* ignore */ }
}
