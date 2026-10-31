import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';

export const CAMERA_ADMIN_API = '/admin/camera'; // the API client adds the /api prefix
export const CONFIRM_ENABLE = 'Turn the Camera (live AR) view on for all visitors? It shows published protocols only, and camera video never leaves the visitor\'s device.';
export const CONFIRM_DISABLE = 'Turn the Camera view off? Visitors will no longer see the Camera option on protocol pages. Viewing and downloading are not affected.';

const BLOCKER_LABELS = { WEBSITE: 'the public website', PROTOCOL_BROWSER: 'the public protocol browser' };

/** Keeps only what this page shows from the admin API answer; anything malformed is treated as an error by the caller. */
export function normalizeCameraState(data) {
  if (!data || typeof data !== 'object' || typeof data.enabled !== 'boolean') return null;
  return {
    enabled: data.enabled,
    available: data.available === true,
    blockedBy: Array.isArray(data.blockedBy) ? data.blockedBy.filter((k) => typeof k === 'string') : [],
  };
}

export async function fetchCameraState(client = api) {
  const next = normalizeCameraState((await client.get(CAMERA_ADMIN_API)).data);
  if (!next) throw new Error('The camera setting could not be read.');
  return next;
}

export async function setCameraEnabled(enabled, client = api) {
  const next = normalizeCameraState((await client.post(`${CAMERA_ADMIN_API}/${enabled ? 'enable' : 'disable'}`)).data);
  if (!next) throw new Error('The camera setting could not be updated.');
  return next;
}

/** The page as a pure function of already-resolved state (same split as AdminAiSettingsPage). */
export function AdminCameraSettingsView({ state, loading, error, busy, onEnable, onDisable }) {
  const blockers = state ? state.blockedBy.map((k) => BLOCKER_LABELS[k] || k) : [];
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Camera (live AR)</h1>
          <p className="muted small">Controls whether visitors see the Camera option on published protocol pages. Doctors cannot change this setting.</p>
        </div>
        <Link to="/dashboard" className="btn">← Dashboard</Link>
      </header>

      {loading && <p>Loading…</p>}
      {error && <p className="save-error" role="alert">{error}</p>}

      {state && (
        <section className="card ai-admin-card" aria-label="Camera status">
          <div className="ai-admin-status">
            <span className="muted">Status</span>
            <span className={`pill ${state.enabled ? 'status' : 'warn'}`} data-testid="camera-admin-status">{state.enabled ? 'ON' : 'OFF'}</span>
          </div>
          <p>
            {state.enabled
              ? 'The Camera view is switched on.'
              : 'The Camera view is switched off. Protocol pages show only View and Download, as before.'}
          </p>
          {state.enabled && !state.available && (
            <p className="save-error" role="alert">
              It is switched on, but visitors still cannot use it because {blockers.length ? `${blockers.join(' and ')} ${blockers.length > 1 ? 'are' : 'is'} turned off` : 'a required website feature is turned off'}.
            </p>
          )}
          <div className="row-actions">
            {state.enabled
              ? <button type="button" className="btn danger" onClick={onDisable} disabled={busy}>{busy ? 'Saving…' : 'Disable Camera'}</button>
              : <button type="button" className="btn primary" onClick={onEnable} disabled={busy}>{busy ? 'Saving…' : 'Enable Camera'}</button>}
          </div>
          <ul className="muted small ai-admin-notes">
            <li>Only published protocols can be opened on the camera; drafts and unpublished edits never appear.</li>
            <li>Hand tracking runs on the visitor&apos;s own device. No camera video or image is uploaded or stored.</li>
            <li>The overlay is an approximate visual guide. Camera access needs an https address.</li>
            <li>This switch resets to OFF if the server&apos;s database is reset (for example after a redeploy on temporary storage).</li>
          </ul>
        </section>
      )}
    </div>
  );
}

/** /admin/camera — admin-only switch for the CAMERA + AR feature flags (backend/src/routes/admin.camera.routes.js). */
export default function AdminCameraSettingsPage() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCameraState()
      .then((next) => { if (!cancelled) setState(next); })
      .catch((err) => { if (!cancelled) setError(err.message || 'The camera setting could not be read.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const change = async (enabled, question) => {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      setState(await setCameraEnabled(enabled));
    } catch (err) {
      setError(err.message || 'The camera setting could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminCameraSettingsView
      state={state} loading={loading} error={error} busy={busy}
      onEnable={() => change(true, CONFIRM_ENABLE)}
      onDisable={() => change(false, CONFIRM_DISABLE)}
    />
  );
}
