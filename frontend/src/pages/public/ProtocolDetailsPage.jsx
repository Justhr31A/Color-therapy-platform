import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api, { baseURL } from '../../api/client';
import PublicHeader from './PublicHeader';
import MedicalDisclaimer from './MedicalDisclaimer';
import HandViewsViewer from '../../viewer/HandViewsViewer';
import { buildProtocolDownloadHtml, downloadHtmlFile } from '../../viewer/buildDownload';
import { buildProtocolPdf, downloadPdfFile } from '../../viewer/pdf/buildPdf';
import { publicProtocolUrl, copyText } from '../../viewer/shareLink';
import AccessPanel, { useProtocolAccess } from './AccessPanel';
import { fetchCameraEnabled, availableViews, cameraPath } from '../../camera/publicCameraData';

/**
 * The actual page markup, as a pure function of already-resolved state (see HomePageView's comment: `useEffect`
 * never runs during a static/server render, so only this half can be rendered directly and inspected in a test).
 * `detail`/`render` are exactly GET /api/public/protocols/:slug and its /render sibling's responses.
 */
export function ProtocolDetailsView({ loading, error, detail, render, downloading, downloadError, onDownload, onDownloadHtml, onCopyLink, linkCopied, access, cameraEnabled = false }) {
  // `access` is optional and additive: without it the page behaves exactly as before. With it, a protocol whose access
  // step is required stays closed until the backend has granted access (see ./AccessPanel.jsx).
  const locked = Boolean(access && access.required && !access.unlocked);
  if (loading) {
    return (
      <div className="pv-page">
        <PublicHeader />
        <div className="pv-section"><p className="pv-muted" role="status">Loading protocol…</p></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pv-page">
        <PublicHeader />
        <div className="pv-section"><p className="pv-error" role="alert">This protocol couldn't be loaded right now. Please try again shortly.</p></div>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="pv-page">
        <PublicHeader />
        <div className="pv-section pv-empty">
          <p>This protocol isn't available.</p>
          <p className="pv-muted">It may not be published, or the link may be out of date.</p>
          <Link to="/protocols" className="pv-link">← Back to all protocols</Link>
        </div>
      </div>
    );
  }

  const conditionNames = (detail.conditions || []).map((c) => c.name).join(', ');
  // Camera (live AR): offered only while the camera view is switched on AND this protocol has a hand view to show.
  // It opens the camera on THIS protocol's first hand view; the camera page has a switch for the others.
  const cameraViews = render ? availableViews(render.canvases) : [];
  const cameraTo = cameraEnabled && cameraViews.length > 0 ? cameraPath(detail.slug, cameraViews[0].viewKey) : null;

  return (
    <div className="pv-page">
      <PublicHeader />
      <div className="pv-section pv-details">
        <Link to="/protocols" className="pv-link pv-back">← All protocols</Link>
        {detail.category && <span className="pv-card-tag">{detail.category.name}</span>}
        <h1>{detail.displayName || detail.name}</h1>
        {conditionNames && <p className="pv-details-condition">For: {conditionNames}</p>}
        {detail.description && <p className="pv-details-description">{detail.description}</p>}

        {access && <AccessPanel slug={detail.slug} access={access} />}

        {!locked && (
        <>
        <div className="pv-details-actions">
          <button type="button" className="pv-btn pv-btn-primary" onClick={onDownload} disabled={downloading || !render}>
            {downloading ? 'Preparing download…' : 'Download PDF'}
          </button>
          {cameraTo && (
            <Link to={cameraTo} className="pv-btn pv-btn-secondary" data-testid="camera-link" title="See this protocol's markings on your own hand, live, with your camera">
              Camera
            </Link>
          )}
          <button type="button" className="pv-btn pv-btn-secondary" onClick={onCopyLink}>
            {linkCopied ? 'Link copied' : 'Copy link'}
          </button>
          <button type="button" className="pv-btn pv-btn-secondary" onClick={onDownloadHtml} disabled={downloading || !render} title="A single web page you can open offline">
            Offline copy (HTML)
          </button>
          {downloadError && <span className="pv-error" role="alert">{downloadError}</span>}
        </div>

        <h2 className="pv-views-heading">Protocol Markings</h2>
        {render && render.canvases && render.canvases.length > 0 ? (
          <HandViewsViewer canvases={render.canvases} />
        ) : (
          <p className="pv-muted">No markings are available for this protocol yet.</p>
        )}
        </>
        )}
      </div>
      <MedicalDisclaimer />
    </div>
  );
}

/**
 * /protocols/:slug — uses the existing public detail + render endpoints, which read ONLY a protocol's frozen
 * PUBLISHED snapshot (see backend/src/services/publicProtocols.js) — there is no path here that can reach a
 * draft, in-review, or unpublished protocol; an unpublished slug gets the identical 404 as a nonexistent one.
 */
export default function ProtocolDetailsPage() {
  const { slug } = useParams();
  const [detail, setDetail] = useState(undefined); // undefined = still loading; null = not found; object = loaded
  const [render, setRender] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const access = useProtocolAccess(slug);

  useEffect(() => {
    let cancelled = false;
    fetchCameraEnabled().then((on) => { if (!cancelled) setCameraEnabled(on); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(undefined);
    setError(null);
    Promise.all([api.get(`/public/protocols/${slug}`), api.get(`/public/protocols/${slug}/render`)])
      .then(([d, r]) => { if (!cancelled) { setDetail(d.data); setRender(r.data); } })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 404) setDetail(null);
        else setError(err.message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  // Both downloads are built from `render` — the published snapshot returned by /render — never from a draft.
  const runDownload = async (build) => {
    if (!render) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await build();
    } catch (err) {
      setDownloadError('The download could not be built right now. Please try again.');
    } finally {
      setDownloading(false);
    }
  };
  const handleDownloadPdf = () => runDownload(async () => {
    const bytes = await buildProtocolPdf(render, { imageBaseUrl: baseURL, shareUrl: publicProtocolUrl(slug) });
    downloadPdfFile(bytes, slug);
  });
  const handleDownloadHtml = () => runDownload(async () => {
    downloadHtmlFile(await buildProtocolDownloadHtml(render, baseURL), slug);
  });
  const handleCopyLink = async () => {
    const ok = await copyText(publicProtocolUrl(slug));
    setLinkCopied(ok);
    if (ok) setTimeout(() => setLinkCopied(false), 2500);
  };

  return (
    <ProtocolDetailsView
      loading={loading} error={error} detail={detail} render={render}
      downloading={downloading} downloadError={downloadError} onDownload={handleDownloadPdf}
      onDownloadHtml={handleDownloadHtml} onCopyLink={handleCopyLink} linkCopied={linkCopied} access={access}
      cameraEnabled={cameraEnabled}
    />
  );
}
