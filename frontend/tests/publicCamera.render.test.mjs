/**
 * [DETERMINISTIC SOFTWARE TESTS — rendering] the protocol page's Camera option, the public camera page, and the admin
 * Camera switch — rendered to static HTML (no browser, no camera; effects do not run in a static render).
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import api from './support/stubs/apiClient.mjs';
import { __reset, __setRouteParams } from './support/stubs/reactRouter.mjs';
import { loadComponent, RENDER_SKIP } from './support/renderJsx.mjs';
import { availableViews } from '../src/camera/publicCameraData.js';

const render = (Component, props = {}) => renderToStaticMarkup(h(Component, props));
const noop = () => {};

const DIMS = { left_front: [1586, 1982], right_front: [1585, 1983], left_back: [1585, 1981], right_back: [1971, 2010] };
const canvas = (viewKey, objects = []) => ({ viewKey, canvasType: 'hand', label: viewKey, width: DIMS[viewKey][0], height: DIMS[viewKey][1], background: { url: `/static/hands/${viewKey}.png` }, objects });
const dot = (id, o = {}) => ({ id, type: 'dot', x: 0.45, y: 0.5, width: 0.03, height: 0.03, rotation: 0, color: '#0000ff', opacity: 1, zIndex: 1, metadata: {}, ...o });
const renderContract = (slug, canvases) => ({ contract: 'protocol-render/1', protocol: { slug, name: slug, displayName: slug }, canvases });
const detail = (slug, name) => ({ slug, name, displayName: name, description: 'd', category: null, conditions: [], version: { number: 1 }, views: [], links: {} });
const loadedFor = (slug, name, canvases) => ({ status: 'ok', protocol: { slug, name }, canvases, views: availableViews(canvases) });

const BACK_PAIN = [canvas('left_front', [dot('bp-dot')]), canvas('right_front'), canvas('left_back', [dot('bp-lb')]), canvas('right_back')];
const ANXIETY = [canvas('left_front', [dot('ax-dot')])];

let ProtocolDetailsView; let PublicCameraView; let PublicCameraPage; let AdminCameraSettingsView;

describe('[DETERMINISTIC · rendering] public Camera option and camera page', { skip: RENDER_SKIP }, () => {
  before(async () => {
    ({ ProtocolDetailsView } = await loadComponent('src/pages/public/ProtocolDetailsPage.jsx'));
    ({ PublicCameraView, default: PublicCameraPage } = await loadComponent('src/pages/public/PublicCameraPage.jsx'));
    ({ AdminCameraSettingsView } = await loadComponent('src/pages/admin/AdminCameraSettingsPage.jsx'));
  });
  beforeEach(() => { api.reset(); __reset(); });

  describe('protocol page (/protocols/:slug)', () => {
    const base = { loading: false, error: null, detail: detail('back-pain', 'Back Pain'), render: renderContract('back-pain', BACK_PAIN), downloading: false, downloadError: null, onDownload: noop, onDownloadHtml: noop, onCopyLink: noop };

    it('with the camera switched on: Download PDF stays AND a Camera option opens this protocol\'s first hand view', () => {
      const html = render(ProtocolDetailsView, { ...base, cameraEnabled: true });
      assert.match(html, /Download PDF/);
      assert.match(html, /Offline copy \(HTML\)/);
      assert.match(html, /data-testid="camera-link"/);
      assert.match(html, /href="\/protocols\/back-pain\/camera\/left_front"/);
      assert.match(html, />Camera</);
    });

    it('each protocol\'s Camera option points at its OWN protocol', () => {
      const html = render(ProtocolDetailsView, { ...base, detail: detail('anxiety', 'Anxiety'), render: renderContract('anxiety', ANXIETY), cameraEnabled: true });
      assert.match(html, /href="\/protocols\/anxiety\/camera\/left_front"/);
      assert.doesNotMatch(html, /back-pain/);
    });

    it('with the camera switched off (the default): no Camera option, Download unchanged', () => {
      const html = render(ProtocolDetailsView, { ...base });
      assert.doesNotMatch(html, /camera-link/);
      assert.match(html, /Download PDF/);
    });

    it('no Camera option when the protocol has no hand view to show', () => {
      const html = render(ProtocolDetailsView, { ...base, render: renderContract('back-pain', [{ viewKey: 'body_front', canvasType: 'organ', width: 10, height: 10, objects: [] }]), cameraEnabled: true });
      assert.doesNotMatch(html, /camera-link/);
    });

    it('while the protocol is locked behind its access step, neither Download nor Camera is offered', () => {
      const access = { checked: true, required: true, unlocked: false, phase: 'ready', get: noop };
      const html = render(ProtocolDetailsView, { ...base, cameraEnabled: true, access });
      assert.doesNotMatch(html, /camera-link/);
      assert.doesNotMatch(html, /Download PDF/);
    });
  });

  describe('camera page (/protocols/:slug/camera/:viewKey)', () => {
    it('loading state while the switch and the protocol load', () => {
      assert.match(render(PublicCameraView, { slug: 'back-pain', viewKey: 'left_front', enabled: undefined, loaded: undefined }), /Loading the camera view/);
    });

    it('switched off: a plain message and a way back — no camera', () => {
      const html = render(PublicCameraView, { slug: 'back-pain', viewKey: 'left_front', enabled: false, loaded: loadedFor('back-pain', 'Back Pain', BACK_PAIN) });
      assert.match(html, /data-testid="camera-disabled"/);
      assert.match(html, /href="\/protocols\/back-pain"/);
      assert.doesNotMatch(html, /camera-session/);
    });

    it('an unpublished / unknown protocol: not available', () => {
      const html = render(PublicCameraView, { slug: 'draft', viewKey: 'left_front', enabled: true, loaded: { status: 'notFound' } });
      assert.match(html, /camera-not-found/);
      assert.doesNotMatch(html, /camera-session/);
    });

    it('a locked protocol does not open the camera', () => {
      const html = render(PublicCameraView, { slug: 'back-pain', viewKey: 'left_front', enabled: true, loaded: loadedFor('back-pain', 'Back Pain', BACK_PAIN), locked: true });
      assert.match(html, /camera-locked/);
      assert.doesNotMatch(html, /camera-session/);
    });

    it('opens the live session for THIS protocol and view: name, view, Start Camera, view switch, Back — no developer readout', () => {
      const html = render(PublicCameraView, { slug: 'back-pain', viewKey: 'left_back', enabled: true, loaded: loadedFor('back-pain', 'Back Pain', BACK_PAIN) });
      assert.match(html, /data-testid="camera-session"/);
      assert.match(html, /data-view-key="left_back"/);
      assert.match(html, /data-testid="camera-protocol-name">Back Pain</);
      assert.match(html, /data-testid="camera-view-name">Left Back</);
      assert.match(html, /Start Camera/);
      assert.match(html, /Show your left hand with the back of the hand facing the camera/);
      assert.match(html, /Nothing is uploaded or recorded/);
      for (const vk of ['left_front', 'right_front', 'left_back', 'right_back']) assert.match(html, new RegExp(`href="/protocols/back-pain/camera/${vk}"`));
      assert.match(html, /aria-current="page"[^>]*>Left Back|class="active"[^>]*>Left Back/);
      assert.match(html, /href="\/protocols\/back-pain"/);
      assert.doesNotMatch(html, /camera-debug-panel/);
      assert.doesNotMatch(html, /Raw MediaPipe/);
    });

    it('Anxiety opens with Anxiety\'s name and view list only', () => {
      const html = render(PublicCameraView, { slug: 'anxiety', viewKey: 'left_front', enabled: true, loaded: loadedFor('anxiety', 'Anxiety', ANXIETY) });
      assert.match(html, /camera-protocol-name">Anxiety</);
      assert.doesNotMatch(html, /Back Pain/);
      assert.doesNotMatch(html, /camera-view-switch/, 'only one view -> no switch');
    });

    it('a view that has no drawable markings says so before the camera starts', () => {
      const html = render(PublicCameraView, { slug: 'back-pain', viewKey: 'right_front', enabled: true, loaded: loadedFor('back-pain', 'Back Pain', BACK_PAIN) });
      assert.match(html, /camera-no-markings/);
    });

    it('no view (or an unknown one) redirects to the first hand view', () => {
      const html = render(PublicCameraView, { slug: 'anxiety', viewKey: 'right_back', enabled: true, loaded: loadedFor('anxiety', 'Anxiety', ANXIETY) });
      assert.match(html, /data-navigate-to="\/protocols\/anxiety\/camera\/left_front"/);
    });

    it('the real wrapper mounts in its loading state without throwing (no request is made during a static render)', () => {
      __setRouteParams({ slug: 'back-pain', viewKey: 'left_front' });
      api.handler = () => new Promise(() => {});
      assert.match(render(PublicCameraPage), /Loading the camera view/);
    });
  });

  describe('admin Camera switch (/admin/camera)', () => {
    it('OFF: says so and offers Enable', () => {
      const html = render(AdminCameraSettingsView, { state: { enabled: false, available: false, blockedBy: [] }, loading: false, error: null, busy: false, onEnable: noop, onDisable: noop });
      assert.match(html, /data-testid="camera-admin-status">OFF/);
      assert.match(html, /Enable Camera/);
    });
    it('ON but blocked by the website being off: explains why visitors cannot use it', () => {
      const html = render(AdminCameraSettingsView, { state: { enabled: true, available: false, blockedBy: ['WEBSITE'] }, loading: false, error: null, busy: false, onEnable: noop, onDisable: noop });
      assert.match(html, />ON</);
      assert.match(html, /Disable Camera/);
      assert.match(html, /the public website is turned off/);
    });
  });
});
