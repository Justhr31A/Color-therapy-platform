/**
 * [DETERMINISTIC SOFTWARE TESTS — rendering] the public website's real pages (Home, Browser, Details).
 *
 * Each page is split into a thin data-fetching wrapper (the default export) and a pure `*View` component that
 * takes already-resolved state as props (see HomePageView's doc comment in HomePage.jsx for why: React does
 * not run `useEffect` during a static/server render, so a component that fetches its own data inside one
 * cannot be meaningfully rendered and inspected this way — only the prop-driven view half can). These tests
 * render the real `*View` components directly against every state (loading/empty/error/populated), which is
 * exactly what those components actually render for that state — nothing about this is a simulation of them.
 * They also render each default-exported wrapper once, to confirm it mounts without throwing and shows the
 * correct initial (loading) state — the one thing a static render of a `useEffect`-driven component can prove.
 * None of this proves that a browser fetch resolves correctly, that clicking a link navigates, or that typing
 * in a box updates the URL — those need a browser.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import api from './support/stubs/apiClient.mjs';
import { __setRouteParams, __reset } from './support/stubs/reactRouter.mjs';
import { loadComponent, RENDER_SKIP } from './support/renderJsx.mjs';

const render = (Component, props = {}) => renderToStaticMarkup(h(Component, props));
const count = (html, needle) => html.split(needle).length - 1;
const noop = () => {};

const category = (name) => ({ slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name });
const protocolSummary = (o = {}) => ({
  slug: 'headache-relief', name: 'Headache Relief Protocol', displayName: 'Headache Relief',
  shortDescription: 'A gentle daily routine.', category: category('Head & Neck'),
  conditions: [{ slug: 'migraine', name: 'Migraine' }], version: { number: 1, publishedAt: '2026-09-01T00:00:00Z' },
  ...o,
});

let HomePage; let HomePageView;
let ProtocolBrowserPage; let ProtocolBrowserView; let dedupeConditions;
let ProtocolDetailsPage; let ProtocolDetailsView;

describe('[DETERMINISTIC · rendering] public website pages', { skip: RENDER_SKIP }, () => {
  before(async () => {
    ({ default: HomePage, HomePageView } = await loadComponent('src/pages/public/HomePage.jsx'));
    ({ default: ProtocolBrowserPage, ProtocolBrowserView, dedupeConditions } = await loadComponent('src/pages/public/ProtocolBrowserPage.jsx'));
    ({ default: ProtocolDetailsPage, ProtocolDetailsView } = await loadComponent('src/pages/public/ProtocolDetailsPage.jsx'));
  });
  beforeEach(() => { api.reset(); __reset(); });

  describe('Home page view', () => {
    it('shows the hero, the how-it-works steps, and the medical disclaimer in every state', () => {
      const html = render(HomePageView, { categories: null, featured: null, error: null });
      assert.match(html, /Explore Colour Therapy Protocols/);
      assert.match(html, /Explore Protocols/);
      assert.match(html, /How It Works/);
      assert.equal(count(html, 'pv-step-num'), 4);
      assert.match(html, /do not diagnose, treat, cure, or\s+prevent/, 'the exact medical-disclaimer wording');
    });

    it('loading state for categories and protocols', () => {
      const html = render(HomePageView, { categories: null, featured: null, error: null });
      assert.equal(count(html, 'Loading categories'), 1);
      assert.equal(count(html, 'Loading protocols'), 1);
    });

    it('renders published categories dynamically as links to the filtered browser — nothing invented', () => {
      const html = render(HomePageView, { categories: [category('Head & Neck'), category('Skin')], featured: [], error: null });
      assert.match(html, /Head &amp; Neck/);
      assert.match(html, /Skin/);
      assert.match(html, /href="\/protocols\?category=head-neck"/);
    });

    it('an empty category list shows a clean empty state, not an error or placeholder content', () => {
      const html = render(HomePageView, { categories: [], featured: [], error: null });
      assert.match(html, /No categories are published yet/);
    });

    it('shows only the published protocols it was given — invents nothing of its own', () => {
      const html = render(HomePageView, { categories: [], featured: [protocolSummary()], error: null });
      assert.match(html, /Headache Relief/);
      assert.match(html, /Migraine/);
      assert.match(html, /href="\/protocols\/headache-relief"/);
    });

    it('no published protocols at all -> a clean empty state, never an invented example protocol', () => {
      const html = render(HomePageView, { categories: [], featured: [], error: null });
      const listSection = html.slice(html.indexOf('Featured Protocols'));
      assert.match(listSection, /No protocols have been published yet/);
      assert.doesNotMatch(listSection, /pv-card/);
    });

    it('an API error produces a usable error message, not a crash or a blank page', () => {
      const html = render(HomePageView, { categories: [], featured: [], error: 'Network down' });
      assert.match(html, /couldn(?:'|&#x27;)t be loaded right now/, "React HTML-escapes the apostrophe in static markup — this matches either form");
    });

    it('has no editing, save, publish, or admin controls anywhere on the page', () => {
      const html = render(HomePageView, { categories: [], featured: [protocolSummary()], error: null });
      ['Save', 'Publish', 'Delete', 'Duplicate protocol', 'Import JSON'].forEach((word) => assert.doesNotMatch(html, new RegExp(word)));
      assert.match(html, /Practitioner Login/, 'a link to log in is fine — it is not an editing control');
    });

    it('the real wrapper mounts and shows the initial loading state without throwing', () => {
      api.handler = () => new Promise(() => {}); // never resolves — we only care about the FIRST render
      const html = render(HomePage);
      assert.match(html, /Loading categories/);
      assert.match(html, /Loading protocols/);
    });
  });

  describe('Protocol Browser view (/protocols)', () => {
    const baseProps = { categories: [category('Head & Neck')], items: null, error: null, availableConditions: [], q: '', category: '', condition: '', hasFilters: false, onSetParam: noop, onClearFilters: noop };

    it('loading state, then the published protocols once loaded', () => {
      const loaded = render(ProtocolBrowserView, { ...baseProps, items: [protocolSummary(), protocolSummary({ slug: 'second', displayName: 'Second Protocol', conditions: [] })] });
      assert.equal(count(loaded, 'class="pv-card"'), 2);
      assert.match(loaded, /Second Protocol/);
      const loading = render(ProtocolBrowserView, baseProps);
      assert.match(loading, /Loading protocols/);
    });

    it('an empty result shows a clear empty state with a way to clear filters', () => {
      const html = render(ProtocolBrowserView, { ...baseProps, items: [], hasFilters: true });
      assert.match(html, /No protocols match your search/);
      assert.match(html, /Clear filters/);
    });

    it('an empty result with NO filters applied does not offer to "clear" anything that was never set', () => {
      const html = render(ProtocolBrowserView, { ...baseProps, items: [], hasFilters: false });
      assert.doesNotMatch(html, /Clear filters/);
    });

    it('an API error shows a usable error state, not a crash', () => {
      const html = render(ProtocolBrowserView, { ...baseProps, items: [], error: 'down' });
      assert.match(html, /couldn(?:'|&#x27;)t be loaded right now/, "React HTML-escapes the apostrophe in static markup — this matches either form");
    });

    it('the search box and category filter are always present; the condition filter only appears once populated', () => {
      const withoutConditions = render(ProtocolBrowserView, { ...baseProps, items: [] });
      assert.match(withoutConditions, /aria-label="Search protocols"/);
      assert.match(withoutConditions, /aria-label="Filter by category"/);
      assert.doesNotMatch(withoutConditions, /aria-label="Filter by condition"/);

      const withConditions = render(ProtocolBrowserView, { ...baseProps, items: [protocolSummary()], availableConditions: [{ slug: 'migraine', name: 'Migraine' }] });
      assert.match(withConditions, /aria-label="Filter by condition"/);
      assert.match(withConditions, /<option value="migraine">Migraine<\/option>/);
    });

    it('reflects the current query string in the controls\' values', () => {
      const html = render(ProtocolBrowserView, { ...baseProps, items: [], q: 'tension', category: 'head-neck', hasFilters: true });
      assert.match(html, /value="tension"/);
      assert.match(html, /<option value="head-neck" selected="">Head &amp; Neck<\/option>/);
    });

    it('is entirely read-only: no create/edit/save controls', () => {
      const html = render(ProtocolBrowserView, { ...baseProps, items: [protocolSummary()] });
      ['Save', 'Publish', 'Create', 'Delete'].forEach((word) => assert.doesNotMatch(html, new RegExp(`>${word}<`)));
    });

    it('dedupeConditions: collects each condition once, sorted, from a list of protocols', () => {
      const items = [protocolSummary({ conditions: [{ slug: 'b', name: 'Beta' }, { slug: 'a', name: 'Alpha' }] }), protocolSummary({ slug: 'x', conditions: [{ slug: 'a', name: 'Alpha' }] })];
      assert.deepEqual(dedupeConditions(items), [{ slug: 'a', name: 'Alpha' }, { slug: 'b', name: 'Beta' }]);
      assert.deepEqual(dedupeConditions([]), []);
      assert.deepEqual(dedupeConditions(null), []);
    });

    it('the real wrapper mounts and shows the initial loading state without throwing', () => {
      api.handler = () => new Promise(() => {});
      const html = render(ProtocolBrowserPage);
      assert.match(html, /Loading protocols/);
    });
  });

  describe('Protocol Details view (/protocols/:slug)', () => {
    const fourViews = [
      { viewKey: 'left_front', label: 'Left Front', width: 1586, height: 1982, background: { url: '/static/hands/left_front.png' }, objects: [{ type: 'dot', x: 0.4, y: 0.5, width: 0.03, color: '#e5484d', opacity: 1, zIndex: 1, metadata: {} }] },
      { viewKey: 'right_front', label: 'Right Front', width: 1585, height: 1983, background: { url: '/static/hands/right_front.png' }, objects: [] },
      { viewKey: 'left_back', label: 'Left Back', width: 1585, height: 1981, background: { url: '/static/hands/left_back.png' }, objects: [] },
      { viewKey: 'right_back', label: 'Right Back', width: 1971, height: 2010, background: { url: '/static/hands/right_back.png' }, objects: [] },
    ];
    const renderContract = (canvases = fourViews) => ({ contract: 'protocol-render/1', protocol: { slug: 'headache-relief' }, canvases });
    const detail = (o = {}) => ({
      slug: 'headache-relief', name: 'Headache Relief Protocol', displayName: 'Headache Relief', shortDescription: 'Short',
      description: 'A gentle daily routine for tension headaches.', protocolType: 'hand',
      category: category('Head & Neck'), conditions: [{ slug: 'migraine', name: 'Migraine' }], searchTerms: ['migraine', 'headache'],
      metadata: {}, version: { number: 2, publishedAt: '2026-09-01T00:00:00Z' }, views: [], links: {}, ...o,
    });
    const baseProps = { loading: false, error: null, detail: detail(), render: renderContract(), downloading: false, downloadError: null, onDownload: noop };

    it('the loading state shows a plain loading message and nothing else', () => {
      const html = render(ProtocolDetailsView, { ...baseProps, loading: true, detail: undefined, render: null });
      assert.match(html, /Loading protocol/);
      assert.doesNotMatch(html, /Download PDF/);
    });

    it('shows name, category, condition, and description from the published detail endpoint', () => {
      const html = render(ProtocolDetailsView, baseProps);
      assert.match(html, /<h1>Headache Relief<\/h1>/);
      assert.match(html, /Head &amp; Neck/);
      assert.match(html, /For: Migraine/);
      assert.match(html, /A gentle daily routine for tension headaches\./);
    });

    it('does NOT display raw search terms on the page', () => {
      const html = render(ProtocolDetailsView, baseProps);
      assert.doesNotMatch(html, /migraine, headache|"migraine"/);
    });

    it('renders all four hand views from the published structured snapshot, using the shared SVG renderer', () => {
      const html = render(ProtocolDetailsView, baseProps);
      assert.equal(count(html, 'class="pv-view-card"'), 4);
      ['Left Front', 'Right Front', 'Left Back', 'Right Back'].forEach((label) => assert.match(html, new RegExp(label)));
      assert.match(html, /fill="#e5484d"/, 'the dot on Left Front is actually drawn');
    });

    it('a Dot + Ring object on the published snapshot renders with its ring', () => {
      const canvases = fourViews.map((c, i) => (i === 0 ? { ...c, objects: [{ type: 'dot', x: 0.4, y: 0.5, width: 0.03, color: '#e5484d', opacity: 1, zIndex: 1, metadata: { ring: { enabled: true, color: '#1a73e8', thickness: 4, gapPreset: 'medium', gapScale: 1, gap: 16 } } }] } : c));
      const html = render(ProtocolDetailsView, { ...baseProps, render: renderContract(canvases) });
      assert.match(html, /stroke="#1a73e8"/);
      assert.match(html, /fill="#e5484d"/);
    });

    it('a Finger Band object on the published snapshot renders', () => {
      const canvases = fourViews.map((c, i) => (i === 0 ? { ...c, objects: [{ type: 'fingerBand', x: 0.5, y: 0.4, width: 0.13, thickness: 5, rotation: 12, color: '#12a594', opacity: 1, zIndex: 1, metadata: { band: { type: 'plain', position: 0.4, rotationOffset: 0 } } }] } : c));
      const html = render(ProtocolDetailsView, { ...baseProps, render: renderContract(canvases) });
      assert.match(html, /<path /);
      assert.match(html, /stroke="#12a594"/);
    });

    it('has a Download PDF button (plus Copy link and an offline HTML copy) and NO editing controls', () => {
      const html = render(ProtocolDetailsView, baseProps);
      assert.match(html, />Download PDF</);
      assert.match(html, />Copy link</);
      assert.match(html, />Offline copy \(HTML\)</);
      assert.doesNotMatch(html, />Download Protocol</, 'the old HTML-only button is gone: PDF is the primary download');
      ['Save', 'Publish', 'Edit', 'Delete', 'Duplicate protocol', 'Undo', 'Redo'].forEach((word) => assert.doesNotMatch(html, new RegExp(`>${word}`)));
    });

    it('the download button disables while a download is in progress and shows a download error if one occurred', () => {
      const html = render(ProtocolDetailsView, { ...baseProps, downloading: true, downloadError: 'The download could not be built right now. Please try again.' });
      assert.match(html, /disabled=""/);
      assert.match(html, /Preparing download/);
      assert.match(html, /The download could not be built/);
    });

    it('an unpublished/unknown slug (detail: null) shows a clean not-found state, never a crash', () => {
      const html = render(ProtocolDetailsView, { ...baseProps, detail: null, render: null });
      assert.match(html, /isn(?:'|&#x27;)t available/, 'React HTML-escapes the apostrophe in static markup — this matches either form');
      assert.doesNotMatch(html, /Download PDF/);
    });

    it('a non-404 API error shows a usable error state', () => {
      const html = render(ProtocolDetailsView, { ...baseProps, error: 'Server error', detail: undefined, render: null });
      assert.match(html, /couldn(?:'|&#x27;)t be loaded right now/, "React HTML-escapes the apostrophe in static markup — this matches either form");
    });

    it('a protocol with no markings yet shows a clean message instead of an empty grid', () => {
      const html = render(ProtocolDetailsView, { ...baseProps, render: renderContract([]) });
      assert.match(html, /No markings are available/);
    });

    it('the real wrapper mounts and shows the initial loading state without throwing', () => {
      __setRouteParams({ slug: 'headache-relief' });
      api.handler = () => new Promise(() => {});
      const html = render(ProtocolDetailsPage);
      assert.match(html, /Loading protocol/);
    });
  });
});
