import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PublicHeader from './PublicHeader';
import MedicalDisclaimer from './MedicalDisclaimer';
import { fetchAssistantStatus, askProtocolAssistant, MESSAGE_MAX, ANSWER_MAX } from '../../ai/aiAssistantClient';
import { downloadPublishedPdf } from '../../viewer/pdf/publishedPdf';
import { publicProtocolUrl, copyText } from '../../viewer/shareLink';

export const DISCLAIMER = 'This protocol recommendation is not a medical diagnosis. If you have severe, worsening, or concerning symptoms, seek appropriate medical care.';
export const ERROR_TEXT = {
  unavailable: 'The protocol assistant is temporarily unavailable. You can still browse all published protocols.',
  network: "We couldn't reach the server. Please check your connection and try again.",
  invalid: 'Please enter a request of between 1 and 500 characters.',
};

/** What the page shows when a request fails: the feature being switched off (404) is "disabled", anything else is an error. */
export function phaseForError(err) {
  if (err && err.kind === 'disabled') return { phase: 'disabled', errorKind: null };
  return { phase: 'error', errorKind: (err && err.kind) || 'unavailable' };
}

/** Which screen a backend answer leads to. "disabled" means an administrator switched the assistant off while the page was open. */
export function phaseForResult(r) {
  if (!r || r.status === 'disabled') return { phase: 'disabled', result: null };
  return { phase: r.status, result: r };
}

/** Copies the PUBLIC link of a recommended protocol (the existing /protocols/:slug route). Resolves true/false; never throws. */
export async function copyRecommendationLink(slug, { origin, copy = copyText } = {}) {
  return copy(publicProtocolUrl(slug, origin));
}

/** The PDF of the recommended protocol's PUBLISHED version — the same download the Studio and public page use. */
export function downloadRecommendationPdf(protocol, options = {}) {
  return downloadPublishedPdf({ slug: protocol.slug, name: protocol.name, displayName: protocol.name }, options);
}

/**
 * The page as a pure function of already-resolved state (so every state can be rendered and tested directly; the
 * data-fetching wrapper below only holds that state). `phase` is one of:
 *   checking | disabled | form | loading | match | clarification | no_match | error
 * It renders only what the backend sent (see ai/aiAssistantClient.js): the protocol, the sentences and the list of actions.
 */
export function FindProtocolView({
  phase, message = '', answer = '', result = null, errorKind = 'unavailable', copyState = 'idle', pdf = { busy: false, error: null }, linkText = '',
  onMessage, onAnswer, onSubmit, onAnswerSubmit, onTryAgain, onStartOver, onCopyLink, onDownloadPdf,
}) {
  const busy = phase === 'loading';
  const body = (() => {
    if (phase === 'checking') return <p className="pv-muted" role="status">Loading…</p>;

    if (phase === 'disabled') {
      return (
        <div className="pv-empty">
          <p>The protocol assistant isn't available right now.</p>
          <p className="pv-muted">You can still browse every published protocol.</p>
          <Link to="/protocols" className="pv-btn pv-btn-primary">Browse Protocols</Link>
        </div>
      );
    }

    if (phase === 'match' && result && result.protocol) {
      const r = result.protocol;
      const actions = Array.isArray(result.actions) ? result.actions : [];
      const renderAction = (action) => {
        if (action.type === 'view_protocol') return <Link key={action.type} to={`/protocols/${r.slug}`} className="pv-btn pv-btn-primary">{action.label}</Link>;
        if (action.type === 'download_pdf') return <button key={action.type} type="button" className="pv-btn pv-btn-secondary" onClick={onDownloadPdf} disabled={pdf.busy}>{pdf.busy ? 'Preparing PDF…' : action.label}</button>;
        if (action.type === 'copy_link') return <button key={action.type} type="button" className="pv-btn pv-btn-secondary" onClick={onCopyLink}>{copyState === 'copied' ? 'Link copied' : action.label}</button>;
        return null; // an action type this page does not know is never rendered
      };
      return (
        <div className="pv-assistant-result" aria-live="polite">
          <h2>Recommended Protocol</h2>
          <div className="pv-card pv-assistant-card">
            <div className="pv-card-body">
              <h3 className="pv-assistant-protocol-name">{r.name}</h3>
              {r.description && <p className="pv-card-desc">{r.description}</p>}
              <p className="pv-assistant-reason">{result.message}</p>
            </div>
          </div>
          <div className="pv-details-actions">{actions.map(renderAction)}</div>
          {copyState === 'failed' && <p className="pv-error" role="alert">The link could not be copied automatically. Copy it from here: <span className="pv-assistant-linktext">{linkText}</span></p>}
          {pdf.error && <p className="pv-error" role="alert">{pdf.error}</p>}
          <p className="pv-muted"><button type="button" className="pv-link pv-assistant-linkbutton" onClick={onStartOver}>Search for something else</button></p>
        </div>
      );
    }

    if (phase === 'clarification' && result && result.question) {
      return (
        <form className="pv-assistant-form" onSubmit={onAnswerSubmit} aria-label="A quick question">
          <p className="pv-assistant-question" role="status">{result.question}</p>
          <label htmlFor="assistant-answer" className="pv-assistant-label">Your answer</label>
          <input id="assistant-answer" type="text" className="pv-assistant-input" maxLength={ANSWER_MAX} value={answer} onChange={onAnswer} autoComplete="off" />
          <div className="pv-details-actions">
            <button type="submit" className="pv-btn pv-btn-primary" disabled={!answer.trim()}>Continue</button>
            <button type="button" className="pv-btn pv-btn-ghost" onClick={onStartOver}>Start over</button>
          </div>
        </form>
      );
    }

    if (phase === 'no_match') {
      return (
        <div className="pv-assistant-result pv-empty" aria-live="polite">
          <h2>We couldn't find a suitable protocol</h2>
          <p>{(result && result.message) || "We couldn't find a published protocol that closely matches the information provided."}</p>
          <div className="pv-details-actions">
            <button type="button" className="pv-btn pv-btn-primary" onClick={onTryAgain}>Try Again</button>
            <Link to="/protocols" className="pv-btn pv-btn-secondary">Browse all protocols</Link>
          </div>
        </div>
      );
    }

    if (phase === 'error') {
      return (
        <div className="pv-assistant-result pv-empty">
          <p className="pv-error" role="alert">{ERROR_TEXT[errorKind] || ERROR_TEXT.unavailable}</p>
          <div className="pv-details-actions">
            <button type="button" className="pv-btn pv-btn-primary" onClick={onTryAgain}>Try Again</button>
            <Link to="/protocols" className="pv-btn pv-btn-secondary">Browse all protocols</Link>
          </div>
        </div>
      );
    }

    // form / loading
    return (
      <form className="pv-assistant-form" onSubmit={onSubmit} aria-label="Find a relevant protocol">
        <label htmlFor="assistant-message" className="pv-assistant-label">Your request</label>
        <textarea
          id="assistant-message"
          className="pv-assistant-input"
          rows={3}
          maxLength={MESSAGE_MAX}
          placeholder="I want the Back Pain protocol"
          value={message}
          onChange={onMessage}
          disabled={busy}
        />
        <p className="pv-muted pv-assistant-hint">
          Or describe it in your own words, for example: “I have lower back stiffness and don't know which protocol is relevant.”
          Please don't include your name or other personal details — we don't save what you type.
        </p>
        <button type="submit" className="pv-btn pv-btn-primary" disabled={busy || !message.trim()}>{busy ? 'Finding…' : 'Find Protocol'}</button>
        {busy && <p className="pv-muted" role="status">Looking through the published protocols…</p>}
      </form>
    );
  })();

  return (
    <div className="pv-page">
      <PublicHeader />
      <section className="pv-section pv-assistant">
        <h1>Find a Relevant Protocol</h1>
        <p className="pv-hero-sub">Already know what you're looking for? Tell us the protocol or concern you're looking for.</p>
        {body}
        {phase !== 'checking' && phase !== 'disabled' && <p className="pv-assistant-disclaimer" role="note">{(result && result.disclaimer) || DISCLAIMER}</p>}
      </section>
      <MedicalDisclaimer />
    </div>
  );
}

/**
 * The public "Find a Relevant Protocol" page. Everything lives in this component's memory: the person's words are
 * sent to the backend for one request and are never saved anywhere (no storage, no URL, no cookie).
 */
export default function FindProtocolPage() {
  const [phase, setPhase] = useState('checking');
  const [message, setMessage] = useState('');
  const [answer, setAnswer] = useState('');
  const [asked, setAsked] = useState(''); // the original request, kept in memory only so the one follow-up can be sent with it
  const [result, setResult] = useState(null);
  const [errorKind, setErrorKind] = useState('unavailable');
  const [copyState, setCopyState] = useState('idle');
  const [pdf, setPdf] = useState({ busy: false, error: null });

  useEffect(() => {
    let cancelled = false;
    fetchAssistantStatus().then((on) => { if (!cancelled) setPhase(on ? 'form' : 'disabled'); });
    return () => { cancelled = true; };
  }, []);

  const run = async (payload) => {
    setPhase('loading');
    setCopyState('idle');
    setPdf({ busy: false, error: null });
    try {
      const r = await askProtocolAssistant(payload);
      const next = phaseForResult(r);
      setResult(next.result);
      setPhase(next.phase);
    } catch (err) {
      const next = phaseForError(err);
      if (next.errorKind) setErrorKind(next.errorKind);
      setPhase(next.phase);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const text = message.trim();
    if (!text) return;
    setAsked(text);
    setAnswer('');
    run({ message: text });
  };
  const onAnswerSubmit = (e) => {
    e.preventDefault();
    if (!answer.trim()) return;
    run({ message: asked, followUpAnswer: answer });
  };
  const onTryAgain = () => { setPhase('form'); setResult(null); };
  const onStartOver = () => { setPhase('form'); setResult(null); setMessage(''); setAnswer(''); setAsked(''); setCopyState('idle'); };

  const slug = result && result.protocol ? result.protocol.slug : null;
  const onCopyLink = async () => { if (slug) setCopyState((await copyRecommendationLink(slug)) ? 'copied' : 'failed'); };
  const onDownloadPdf = async () => {
    if (!result || !result.protocol) return;
    setPdf({ busy: true, error: null });
    try {
      await downloadRecommendationPdf(result.protocol, {});
      setPdf({ busy: false, error: null });
    } catch (err) {
      setPdf({ busy: false, error: 'The PDF could not be built right now. Please try again.' });
    }
  };

  return (
    <FindProtocolView
      phase={phase}
      message={message}
      answer={answer}
      result={result}
      errorKind={errorKind}
      copyState={copyState}
      pdf={pdf}
      linkText={slug ? publicProtocolUrl(slug) : ''}
      onMessage={(e) => setMessage(e.target.value)}
      onAnswer={(e) => setAnswer(e.target.value)}
      onSubmit={onSubmit}
      onAnswerSubmit={onAnswerSubmit}
      onTryAgain={onTryAgain}
      onStartOver={onStartOver}
      onCopyLink={onCopyLink}
      onDownloadPdf={onDownloadPdf}
    />
  );
}
