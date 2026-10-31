import { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link, Navigate } from 'react-router-dom';
import PublicHeader from './PublicHeader';
import { useProtocolAccess } from './AccessPanel';
import { fetchCameraEnabled, loadPublishedForCamera, cameraSessionFor } from '../../camera/publicCameraData';
import { CameraSessionCore } from '../patient/CameraSessionPage';

/**
 * The page around the camera, as a pure function of already-resolved state (same split as the other public pages:
 * effects do not run in a static render, so this half can be rendered and inspected directly in a test).
 *
 *   enabled:  undefined while checking | false (switched off) | true
 *   loaded:   undefined while loading | { status: 'ok' | 'notFound' | 'error', ... } from loadPublishedForCamera
 *   locked:   true when this protocol's access step applies and has not been completed
 */
export function PublicCameraView({ slug, viewKey, enabled, loaded, locked = false, debug = false, mapping = 'skeleton', predictMs = null, palmModel = 'perspective' }) {
  const back = `/protocols/${encodeURIComponent(slug)}`;
  const shell = (children) => (
    <div className="pv-page">
      <PublicHeader />
      <div className="pv-section pv-empty">
        {children}
        <Link to={back} className="pv-link">← Back to the protocol</Link>
      </div>
    </div>
  );

  if (enabled === undefined || loaded === undefined) {
    return shell(<p className="pv-muted" role="status">Loading the camera view…</p>);
  }
  if (!enabled) {
    return shell(
      <>
        <p data-testid="camera-disabled">The camera view is not available right now.</p>
        <p className="pv-muted">You can still view and download this protocol on its page.</p>
      </>
    );
  }
  if (loaded.status === 'notFound') {
    return (
      <div className="pv-page">
        <PublicHeader />
        <div className="pv-section pv-empty">
          <p data-testid="camera-not-found">This protocol isn&apos;t available.</p>
          <p className="pv-muted">It may not be published, or the link may be out of date.</p>
          <Link to="/protocols" className="pv-link">← Back to all protocols</Link>
        </div>
      </div>
    );
  }
  if (loaded.status !== 'ok') {
    return shell(<p className="pv-error" role="alert">This protocol couldn&apos;t be loaded right now. Please try again shortly.</p>);
  }
  if (locked) {
    return shell(<p data-testid="camera-locked">Open the protocol page and get access to this protocol first — then come back to use the camera.</p>);
  }

  const session = cameraSessionFor(loaded, slug, viewKey);
  if (!session || session.kind === 'noViews') {
    return shell(<p data-testid="camera-no-views">This protocol has no hand views that can be shown on the camera.</p>);
  }
  if (session.kind === 'redirect') return <Navigate to={session.to} replace />;

  return (
    <CameraSessionCore
      key={session.sessionKey}
      canvas={session.canvas}
      title={session.title}
      viewLabel={session.viewLabel}
      backTo={back}
      variant="public"
      viewLinks={session.viewLinks}
      debug={debug}
      mapping={mapping}
      predictMs={predictMs}
      palmModel={palmModel}
    />
  );
}

/**
 * /protocols/:slug/camera/:viewKey — live AR for one PUBLISHED protocol view. Public: no login, no patient assignment.
 * Reads only GET /api/public/camera/status and the protocol's published render contract
 * (GET /api/public/protocols/:slug/render) — the same data the protocol page and its PDF are drawn from — so drafts
 * can never reach the camera. Hand tracking runs in the browser; no camera frame is ever sent anywhere.
 */
export default function PublicCameraPage() {
  const { slug, viewKey } = useParams();
  const [search] = useSearchParams();
  const [enabled, setEnabled] = useState(undefined);
  const [loaded, setLoaded] = useState(undefined);
  const access = useProtocolAccess(slug);

  useEffect(() => {
    let cancelled = false;
    setEnabled(undefined);
    setLoaded(undefined); // never show the previous protocol's markings while the next one loads
    Promise.all([fetchCameraEnabled(), loadPublishedForCamera(slug)]).then(([on, data]) => {
      if (cancelled) return;
      setEnabled(on);
      setLoaded(data);
    });
    return () => { cancelled = true; };
  }, [slug]);

  const accessKnown = access.checked || access.phase === 'notConfigured';
  const debugOn = search.get('debug') === '1';
  return (
    <PublicCameraView
      slug={slug}
      viewKey={viewKey}
      enabled={accessKnown ? enabled : undefined}
      loaded={loaded}
      locked={Boolean(access.required && !access.unlocked)}
      debug={debugOn}
      // Developer comparisons only (with ?debug=1): ?mapping=similarity (the previous whole-hand fit), ?predict=<ms>,
      // ?palm=affine (palm without perspective).
      mapping={debugOn && search.get('mapping') === 'similarity' ? 'similarity' : 'skeleton'}
      palmModel={debugOn && search.get('palm') === 'affine' ? 'affine' : 'perspective'}
      predictMs={debugOn && search.get('predict') != null && Number.isFinite(Number(search.get('predict'))) ? Number(search.get('predict')) : null}
    />
  );
}
