/**
 * The shareable link for a published protocol. It is the EXISTING public route, `/protocols/:slug` — the same stable slug
 * the website already uses — and it always serves the published (immutable) version, never a draft: the server answers 404
 * for anything unpublished (see backend/src/services/publicProtocols.js). So there is nothing to generate or store: the
 * link exists the moment the protocol is published, and a draft's link simply does not resolve.
 */
export function publicProtocolPath(slug) {
  return `/protocols/${encodeURIComponent(slug)}`;
}

/** Absolute public URL for a slug. `origin` defaults to the page's own origin (the website the doctor is signed in to). */
export function publicProtocolUrl(slug, origin) {
  const base = origin !== undefined ? origin : (typeof window !== 'undefined' && window.location ? window.location.origin : '');
  return `${String(base).replace(/\/+$/, '')}${publicProtocolPath(slug)}`;
}

/**
 * Copies text to the clipboard. Uses the async Clipboard API where it exists, and falls back to a hidden textarea +
 * execCommand for older browsers / non-secure contexts. Resolves true on success, false otherwise — never throws.
 */
export async function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to the legacy path */ }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return Boolean(ok);
  } catch (e) {
    return false;
  }
}
