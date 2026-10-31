import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchAssistantStatus } from '../../ai/aiAssistantClient';

/**
 * The public entry point to the AI Protocol Assistant. It renders NOTHING unless the backend says the assistant is
 * switched on (the AI_ASSESSMENT flag, off by default) — so with the feature off, every public page is exactly as it
 * was. `variant="cta"` is the button used in the home page hero; the default is the header navigation link.
 */
export function FindProtocolLinkView({ enabled, variant = 'nav' }) {
  if (!enabled) return null;
  return variant === 'cta'
    ? <Link to="/find-protocol" className="pv-btn pv-btn-secondary">Find a Relevant Protocol</Link>
    : <Link to="/find-protocol">Find a Relevant Protocol</Link>;
}

export default function FindProtocolLink({ variant = 'nav' }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchAssistantStatus().then((on) => { if (!cancelled) setEnabled(on); });
    return () => { cancelled = true; };
  }, []);
  return <FindProtocolLinkView enabled={enabled} variant={variant} />;
}
