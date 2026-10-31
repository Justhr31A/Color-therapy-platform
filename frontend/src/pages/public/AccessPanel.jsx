import { useEffect, useState } from 'react';
import {
  ACCESS_TEXT, decideAccessStep, fetchPaymentStatus, requestProtocolAccess, checkAccessRecord,
  rememberedAccessId, rememberAccessId, forgetAccessId,
} from '../../access/accessClient';

/**
 * "Get Your Protocol" — the access step shown on a protocol's page. Reusable: it only needs a protocol slug.
 *
 * It is NOT a payment page: nothing is charged and no payment details are collected. It shows what is true today
 * ("FREE NOW") separately from what is planned ("Secure online payment", in a future release).
 *
 * phase: 'ready' (show the offer) | 'working' | 'done' (unlocked) | 'error' | 'notConfigured'
 */
export function AccessPanelView({ phase = 'ready', onGet }) {
  if (phase === 'done') {
    return (
      <section className="pv-access pv-access-done" aria-label="Protocol access" data-testid="access-panel">
        <p className="pv-access-success" role="status"><span aria-hidden="true">✓ </span>{ACCESS_TEXT.success}</p>
        <p className="pv-muted">{ACCESS_TEXT.successBody}</p>
      </section>
    );
  }
  return (
    <section className="pv-access" aria-label="Protocol access" data-testid="access-panel">
      <h2 className="pv-access-heading">{ACCESS_TEXT.heading}</h2>
      <p className="pv-access-badge">{ACCESS_TEXT.freeBadge}</p>
      <p className="pv-access-intro">{ACCESS_TEXT.intro}</p>
      <div className="pv-access-tiers">
        <div className="pv-access-tier pv-access-now">
          <span className="pv-access-tier-label">{ACCESS_TEXT.freeNow}</span>
          <p>{ACCESS_TEXT.freeNowBody}</p>
        </div>
        <div className="pv-access-tier pv-access-future">
          <span className="pv-access-tier-label">{ACCESS_TEXT.futureLabel} · coming later</span>
          <p>{ACCESS_TEXT.futureBody}</p>
        </div>
      </div>
      {phase === 'notConfigured' && <p className="pv-error" role="alert">{ACCESS_TEXT.notConfigured}</p>}
      {phase === 'error' && <p className="pv-error" role="alert">{ACCESS_TEXT.error}</p>}
      {phase !== 'notConfigured' && (
        <button type="button" className="pv-btn pv-btn-primary" onClick={onGet} disabled={phase === 'working'}>
          {phase === 'working' ? ACCESS_TEXT.working : ACCESS_TEXT.button}
        </button>
      )}
    </section>
  );
}

/**
 * Decides, for one protocol slug, whether the access step applies and whether it has been completed.
 * Returns { required, unlocked, phase, get }. While the status is unknown (loading or unreachable) `required`
 * is false, so a visitor is never blocked by a slow or failing access service.
 */
export function useProtocolAccess(slug, { client } = {}) {
  const [state, setState] = useState({ checked: false, required: false, unlocked: false, phase: 'ready' });

  useEffect(() => {
    let cancelled = false;
    setState({ checked: false, required: false, unlocked: false, phase: 'ready' });
    (async () => {
      const status = await fetchPaymentStatus(client);
      if (cancelled) return;
      const step = decideAccessStep(status);
      if (!step.required) { setState({ checked: true, required: false, unlocked: false, phase: step.phase }); return; }
      const remembered = rememberedAccessId(slug);
      if (remembered) {
        const ok = await checkAccessRecord(remembered, slug, client);
        if (cancelled) return;
        if (ok) { setState({ checked: true, required: true, unlocked: true, phase: 'done' }); return; }
        forgetAccessId(slug);
      }
      setState({ checked: true, required: true, unlocked: false, phase: 'ready' });
    })();
    return () => { cancelled = true; };
  }, [slug, client]);

  const get = async () => {
    setState((s) => ({ ...s, phase: 'working' }));
    const out = await requestProtocolAccess(slug, rememberedAccessId(slug), client);
    if (out.access) {
      rememberAccessId(slug, out.access.accessId);
      setState((s) => ({ ...s, unlocked: true, phase: 'done' }));
    } else {
      setState((s) => ({ ...s, phase: out.error === 'notConfigured' ? 'notConfigured' : 'error' }));
    }
  };

  return { ...state, get };
}

export default function AccessPanel({ slug, access }) {
  const own = useProtocolAccess(slug);
  const a = access || own;
  if (!a.checked || !a.required) {
    return a.phase === 'notConfigured' ? <AccessPanelView phase="notConfigured" /> : null;
  }
  return <AccessPanelView phase={a.phase} onGet={a.get} />;
}
