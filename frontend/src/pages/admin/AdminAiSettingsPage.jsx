import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';

export const AI_ADMIN_API = '/admin/ai'; // the API client adds the /api prefix
export const CONFIRM_ENABLE = 'Turn the AI Protocol Assistant on for all visitors? It only ever suggests protocols that are published.';
export const CONFIRM_DISABLE = 'Turn the AI Protocol Assistant off? Visitors will no longer see the "Find a Relevant Protocol" page.';

const BLOCKER_LABELS = { WEBSITE: 'the public website', PROTOCOL_BROWSER: 'the public protocol browser' };

/** Keeps only what this page shows from the admin API answer; anything malformed is treated as an error by the caller. */
export function normalizeAiState(data) {
  if (!data || typeof data !== 'object' || typeof data.enabled !== 'boolean') return null;
  return {
    enabled: data.enabled,
    available: data.available === true,
    blockedBy: Array.isArray(data.blockedBy) ? data.blockedBy.filter((k) => typeof k === 'string') : [],
  };
}

/** Reads the switch (admin session required). Resolves the normalised state, or throws. */
export async function fetchAiState(client = api) {
  const res = await client.get(AI_ADMIN_API);
  const next = normalizeAiState(res.data);
  if (!next) throw new Error('The AI setting could not be read.');
  return next;
}

/** Turns the switch on or off through the admin API. Resolves the new normalised state, or throws. */
export async function setAiEnabled(enabled, client = api) {
  const res = await client.post(`${AI_ADMIN_API}/${enabled ? 'enable' : 'disable'}`);
  const next = normalizeAiState(res.data);
  if (!next) throw new Error('The AI setting could not be updated.');
  return next;
}

/**
 * The page as a pure function of already-resolved state (same split as the other admin pages: effects do not run in
 * a static render, so this half can be rendered and inspected directly).
 */
export function AdminAiSettingsView({ state, loading, error, busy, onEnable, onDisable }) {
  const blockers = state ? state.blockedBy.map((k) => BLOCKER_LABELS[k] || k) : [];
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>AI Protocol Assistant</h1>
          <p className="muted small">Controls whether visitors can use “Find a Relevant Protocol”. Doctors cannot change this setting.</p>
        </div>
        <Link to="/dashboard" className="btn">← Dashboard</Link>
      </header>

      {loading && <p>Loading…</p>}
      {error && <p className="save-error" role="alert">{error}</p>}

      {state && (
        <section className="card ai-admin-card" aria-label="AI Assessment status">
          <div className="ai-admin-status">
            <span className="muted">Status</span>
            <span className={`pill ${state.enabled ? 'status' : 'warn'}`} data-testid="ai-status">{state.enabled ? 'ON' : 'OFF'}</span>
          </div>
          <p>
            {state.enabled
              ? 'The assistant is switched on.'
              : 'The assistant is switched off. Visitors see that it is not available, and everything else on the website works as usual.'}
          </p>
          {state.enabled && !state.available && (
            <p className="save-error" role="alert">
              It is switched on, but visitors still cannot use it because {blockers.length ? `${blockers.join(' and ')} ${blockers.length > 1 ? 'are' : 'is'} turned off` : 'a required website feature is turned off'}.
            </p>
          )}
          <div className="row-actions">
            {state.enabled
              ? <button type="button" className="btn danger" onClick={onDisable} disabled={busy}>{busy ? 'Saving…' : 'Disable AI Assistant'}</button>
              : <button type="button" className="btn primary" onClick={onEnable} disabled={busy}>{busy ? 'Saving…' : 'Enable AI Assistant'}</button>}
          </div>
          <ul className="muted small ai-admin-notes">
            <li>It only suggests protocols that are published. It cannot create, change or reveal anything else.</li>
            <li>It does not use any outside AI service, and what visitors type is not saved or sent anywhere.</li>
            <li>It is not a medical tool: it never diagnoses, and every answer carries the medical disclaimer.</li>
          </ul>
          {state.enabled && state.available && <p className="small"><Link to="/find-protocol">Open the public page</Link></p>}
        </section>
      )}
    </div>
  );
}

/**
 * /admin/ai — admin-only switch for the AI_ASSESSMENT feature flag. It reads and writes only through
 * GET /api/admin/ai, POST /api/admin/ai/enable and POST /api/admin/ai/disable, which sit on top of the existing
 * feature-flag service (backend/src/routes/admin.ai.routes.js); this page holds no flag logic of its own.
 */
export default function AdminAiSettingsPage() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAiState()
      .then((next) => { if (!cancelled) setState(next); })
      .catch((err) => { if (!cancelled) setError(err.message || 'The AI setting could not be read.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const change = async (enabled, question) => {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      setState(await setAiEnabled(enabled));
    } catch (err) {
      setError(err.message || 'The AI setting could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminAiSettingsView
      state={state} loading={loading} error={error} busy={busy}
      onEnable={() => change(true, CONFIRM_ENABLE)}
      onDisable={() => change(false, CONFIRM_DISABLE)}
    />
  );
}
