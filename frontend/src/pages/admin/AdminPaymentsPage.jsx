import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';

export const PAYMENTS_ADMIN_API = '/admin/payments/settings'; // the API client adds the /api prefix
export const CONFIRM_PAID = 'Switch to PAID mode? Nothing will be charged: no payment provider is configured, so checkout stays unavailable and protocols remain free.';
export const CONFIRM_FREE = 'Switch back to FREE mode? Visitors get protocols free of charge.';

/** Keeps only what this page shows; anything malformed is an error for the caller. */
export function normalizePaymentSettings(d) {
  if (!d || typeof d !== 'object' || (d.mode !== 'FREE' && d.mode !== 'PAID')) return null;
  return {
    mode: d.mode,
    accessEnabled: d.accessEnabled !== false,
    launchMessage: typeof d.launchMessage === 'string' ? d.launchMessage : '',
    futureAmount: typeof d.futureAmount === 'number' ? d.futureAmount : null,
    currency: typeof d.currency === 'string' ? d.currency : 'INR',
    futureProvider: typeof d.futureProvider === 'string' ? d.futureProvider : null,
    chargingActive: d.chargingActive === true,
  };
}

export async function fetchPaymentSettings(client = api) {
  const next = normalizePaymentSettings((await client.get(PAYMENTS_ADMIN_API)).data);
  if (!next) throw new Error('The payment settings could not be read.');
  return next;
}

/** `changes` is any of { mode, accessEnabled, futureAmount, currency }. Resolves the new settings, or throws. */
export async function savePaymentSettings(changes, client = api) {
  const next = normalizePaymentSettings((await client.post(PAYMENTS_ADMIN_API, changes)).data);
  if (!next) throw new Error('The payment settings could not be updated.');
  return next;
}

/** Pure view (effects do not run in a static render, so this half is what tests render). */
export function AdminPaymentsView({ state, loading, error, busy, amountText = '', onAmountChange, onSaveAmount, onSetMode, onToggleAccess }) {
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Payment Access</h1>
          <p className="muted small">Controls how visitors get protocols. Doctors cannot change this setting.</p>
        </div>
        <Link to="/dashboard" className="btn">← Dashboard</Link>
      </header>

      {loading && <p>Loading…</p>}
      {error && <p className="save-error" role="alert">{error}</p>}

      {state && (
        <section className="card payments-admin-card" aria-label="Payment access settings">
          <dl className="payments-admin-list">
            <div><dt>Current mode</dt><dd><span className={`pill ${state.mode === 'FREE' ? 'status' : 'warn'}`} data-testid="payment-mode">{state.mode}</span></dd></div>
            <div><dt>Launch message</dt><dd>{state.mode === 'FREE' ? 'Protocols are currently free.' : state.launchMessage}</dd></div>
            <div><dt>Future amount</dt><dd>{state.futureAmount === null ? '₹____' : `₹${state.futureAmount}`}</dd></div>
            <div><dt>Currency</dt><dd>{state.currency}</dd></div>
            <div><dt>Future provider</dt><dd>{state.futureProvider || 'Not configured'}</dd></div>
            <div><dt>Actual charging</dt><dd><span className={`pill ${state.chargingActive ? 'warn' : 'status'}`} data-testid="charging-status">{state.chargingActive ? 'ON' : 'OFF'}</span></dd></div>
            <div><dt>Access step on protocol pages</dt><dd>{state.accessEnabled ? 'Shown' : 'Hidden'}</dd></div>
          </dl>

          <div className="payments-admin-amount">
            <label htmlFor="future-amount">Future amount (stored only — nothing is charged)</label>
            <input id="future-amount" type="text" inputMode="decimal" value={amountText} onChange={(e) => onAmountChange && onAmountChange(e.target.value)} placeholder="e.g. 199" />
            <button type="button" className="btn" onClick={onSaveAmount} disabled={busy}>Save amount</button>
          </div>

          <div className="row-actions">
            {state.mode === 'FREE'
              ? <button type="button" className="btn" onClick={() => onSetMode && onSetMode('PAID')} disabled={busy}>Switch to PAID mode</button>
              : <button type="button" className="btn primary" onClick={() => onSetMode && onSetMode('FREE')} disabled={busy}>Switch to FREE mode</button>}
            <button type="button" className="btn" onClick={onToggleAccess} disabled={busy}>{state.accessEnabled ? 'Hide access step' : 'Show access step'}</button>
          </div>

          {state.mode === 'PAID' && !state.chargingActive && (
            <p className="small" role="status">PAID is selected but no payment provider is configured, so nothing is charged and visitors are told: “Paid checkout is not configured yet. Protocols remain available for free during the launch period.”</p>
          )}
          <ul className="muted small payments-admin-notes">
            <li>No payment provider is connected in this release. The system does not charge anyone in either mode.</li>
            <li>No card, bank or UPI details are collected or stored.</li>
            <li>Only published protocols can be unlocked.</li>
          </ul>
        </section>
      )}
    </div>
  );
}

/** /admin/payments — admin-only. Reads and writes only through /api/admin/payments/settings. */
export default function AdminPaymentsPage() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [amountText, setAmountText] = useState('');

  const adopt = (next) => { setState(next); setAmountText(next.futureAmount === null ? '' : String(next.futureAmount)); };

  useEffect(() => {
    let cancelled = false;
    fetchPaymentSettings()
      .then((next) => { if (!cancelled) adopt(next); })
      .catch((err) => { if (!cancelled) setError(err.message || 'The payment settings could not be read.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const save = async (changes, question) => {
    if (question && typeof window !== 'undefined' && window.confirm && !window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      adopt(await savePaymentSettings(changes));
    } catch (err) {
      setError((err.response && err.response.data && err.response.data.error) || err.message || 'The payment settings could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminPaymentsView
      state={state} loading={loading} error={error} busy={busy} amountText={amountText}
      onAmountChange={setAmountText}
      onSaveAmount={() => save({ futureAmount: amountText.trim() === '' ? null : amountText.trim() })}
      onSetMode={(mode) => save({ mode }, mode === 'PAID' ? CONFIRM_PAID : CONFIRM_FREE)}
      onToggleAccess={() => save({ accessEnabled: !(state && state.accessEnabled) })}
    />
  );
}
