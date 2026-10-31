import api from '../api/client';
import { HAND_VIEWS } from '../tracking/cameraGuidance';

/**
 * Loading what the PUBLIC camera page needs. Two public calls, no login, no key — and no second copy of any protocol:
 *
 *   GET /api/public/camera/status            -> { enabled }   is the camera view switched on?
 *   GET /api/public/protocols/:slug/render   -> the PUBLISHED protocol, exactly what the website and the PDF draw
 *
 * Camera frames are never part of any request: hand tracking runs in the browser.
 */
export const CAMERA_STATUS_PATH = '/public/camera/status';
export const renderPath = (slug) => `/public/protocols/${encodeURIComponent(slug)}/render`;

export async function fetchCameraEnabled(client = api) {
  try {
    const res = await client.get(CAMERA_STATUS_PATH);
    return Boolean(res.data && res.data.enabled === true);
  } catch (e) {
    return false; // unreachable or off -> the entry point simply stays hidden
  }
}

/** The hand views this protocol has, in the fixed order Left/Right Front, Left/Right Back. */
export function availableViews(canvases) {
  const list = Array.isArray(canvases) ? canvases : [];
  return HAND_VIEWS
    .map((v) => {
      const c = list.find((x) => x && x.viewKey === v.viewKey && x.canvasType === 'hand' && x.width > 0 && x.height > 0 && Array.isArray(x.objects));
      return c ? { ...v, markingCount: c.objects.length } : null;
    })
    .filter(Boolean);
}

/** The canvas to run the camera on for `viewKey`, or null when this protocol has no such hand view. */
export function selectViewCanvas(canvases, viewKey) {
  if (!availableViews(canvases).some((v) => v.viewKey === viewKey)) return null;
  return canvases.find((c) => c.viewKey === viewKey) || null;
}

/** Resolves { status: 'ok', protocol, canvases, views } | { status: 'notFound' } | { status: 'error' }. */
export async function loadPublishedForCamera(slug, client = api) {
  try {
    const res = await client.get(renderPath(slug));
    const data = res.data;
    if (!data || !data.protocol || !Array.isArray(data.canvases)) return { status: 'error' };
    return {
      status: 'ok',
      protocol: { slug: data.protocol.slug, name: data.protocol.displayName || data.protocol.name || slug },
      canvases: data.canvases,
      views: availableViews(data.canvases),
    };
  } catch (e) {
    return e && e.status === 404 ? { status: 'notFound' } : { status: 'error' };
  }
}

/** The public camera address for one protocol view: /protocols/:slug/camera/:viewKey (viewKey optional). */
export function cameraPath(slug, viewKey) {
  const base = `/protocols/${encodeURIComponent(slug)}/camera`;
  return viewKey ? `${base}/${encodeURIComponent(viewKey)}` : base;
}

/**
 * Decides what the camera page shows for a loaded protocol and the requested view — a pure function, so "which
 * protocol's markings, which view" is testable without a camera.
 *
 *   { kind: 'session', canvas, viewKey, viewLabel, title, sessionKey, viewLinks }   run the camera on this view
 *   { kind: 'redirect', to }                                                          no / unknown view: go to the first one
 *   { kind: 'noViews' }                                                               this protocol has no hand views
 *
 * `sessionKey` changes with the protocol AND the view, so the camera session is remounted from scratch on any change
 * (no previous overlay, smoothing state or camera stream can carry over to another protocol or view).
 */
export function cameraSessionFor(loaded, slug, viewKey) {
  if (!loaded || loaded.status !== 'ok') return null;
  const views = loaded.views || [];
  if (views.length === 0) return { kind: 'noViews' };
  const selected = views.find((v) => v.viewKey === viewKey);
  if (!selected) return { kind: 'redirect', to: cameraPath(slug, views[0].viewKey) };
  const canvas = selectViewCanvas(loaded.canvases, selected.viewKey);
  if (!canvas) return { kind: 'redirect', to: cameraPath(slug, views[0].viewKey) };
  return {
    kind: 'session',
    canvas,
    viewKey: selected.viewKey,
    viewLabel: selected.label,
    title: loaded.protocol.name,
    sessionKey: `${loaded.protocol.slug}::${selected.viewKey}`,
    viewLinks: views.map((v) => ({ viewKey: v.viewKey, label: v.label, to: cameraPath(slug, v.viewKey), active: v.viewKey === selected.viewKey })),
  };
}
