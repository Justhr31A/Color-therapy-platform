/**
 * [DETERMINISTIC SOFTWARE TESTS] the public "Find a Relevant Protocol" experience (AI Protocol Assistant; Stage 2 response contract):
 * the entry point, the page in every state, the actions on a recommendation, and the browser-side client.
 *
 * As with the other public pages, the page is a thin stateful wrapper around a pure view (FindProtocolView), because
 * React does not run effects during a static render: every state is rendered directly from props. Clicking, typing and
 * real navigation need a browser; what is proven here is what each state shows, what each action calls, and that the
 * client talks only to the two documented public endpoints.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import api from './support/stubs/apiClient.mjs';
import { __reset } from './support/stubs/reactRouter.mjs';
import { loadComponent, RENDER_SKIP } from './support/renderJsx.mjs';
import { downloadPublishedPdf } from '../src/viewer/pdf/publishedPdf.js';
import {
  askProtocolAssistant, fetchAssistantStatus, resetAssistantStatusCache, normalizeAssistantResponse, AssistantError, STATUS_PATH, ASSISTANT_PATH, MESSAGE_MAX, ANSWER_MAX,
} from '../src/ai/aiAssistantClient.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const read = (rel) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
/** Source with comments removed, so a scan checks what the code DOES, not what its explanations mention. */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const render = (Component, props = {}) => renderToStaticMarkup(h(Component, props));
const count = (html, needle) => html.split(needle).length - 1;
const noop = () => {};

const DISCLAIMER = 'This protocol recommendation is not a medical diagnosis. If you have severe, worsening, or concerning symptoms, seek appropriate medical care.';
const REASON = 'Based on the information you provided, this protocol may be relevant to the concern you described.';
const ACTIONS = [{ type: 'view_protocol', label: 'View Protocol' }, { type: 'download_pdf', label: 'Download PDF' }, { type: 'copy_link', label: 'Copy Link' }];
const matchResult = (o = {}) => ({
  status: 'match', message: REASON, disclaimer: DISCLAIMER, actions: ACTIONS.map((x) => ({ ...x })),
  protocol: { slug: 'back-pain', name: 'Back Pain', description: 'A gentle routine for the lower back.' },
  ...o,
});
const NO_MATCH_TEXT = "We couldn't find a published protocol that closely matches the information provided.";
const noMatchResult = () => ({ status: 'no_match', message: NO_MATCH_TEXT, disclaimer: DISCLAIMER });
const QUESTION = 'Which part of the body, or what concern, would you like to find a protocol for?';
const clarificationResult = () => ({ status: 'clarification', question: QUESTION, disclaimer: DISCLAIMER });

let FindProtocolPage; let FindProtocolView; let phaseForResult; let phaseForError; let copyRecommendationLink; let downloadRecommendationPdf; let DISCLAIMER_CONST; let ERROR_TEXT;
let FindProtocolLink; let FindProtocolLinkView; let PublicHeader; let HomePageView;

describe('[DETERMINISTIC · rendering] Find a Relevant Protocol', { skip: RENDER_SKIP }, () => {
  before(async () => {
    ({ default: FindProtocolPage, FindProtocolView, phaseForResult, phaseForError, copyRecommendationLink, downloadRecommendationPdf, DISCLAIMER: DISCLAIMER_CONST, ERROR_TEXT } = await loadComponent('src/pages/public/FindProtocolPage.jsx'));
    ({ default: FindProtocolLink, FindProtocolLinkView } = await loadComponent('src/pages/public/FindProtocolLink.jsx'));
    ({ default: PublicHeader } = await loadComponent('src/pages/public/PublicHeader.jsx'));
    ({ HomePageView } = await loadComponent('src/pages/public/HomePage.jsx'));
  });
  beforeEach(() => { api.reset(); __reset(); resetAssistantStatusCache(); });

  // ------------------------------------------------------------------------------------ 1. the entry point
  describe('the entry point', () => {
    it('is a "Find a Relevant Protocol" link to /find-protocol — in the header nav and as a hero button — when the assistant is enabled', () => {
      assert.equal(render(FindProtocolLinkView, { enabled: true }), '<a href="/find-protocol">Find a Relevant Protocol</a>');
      const cta = render(FindProtocolLinkView, { enabled: true, variant: 'cta' });
      assert.match(cta, /href="\/find-protocol"/);
      assert.match(cta, /class="pv-btn pv-btn-secondary"/);
      assert.match(cta, />Find a Relevant Protocol</);
    });
    it('renders NOTHING when the assistant is off or its state is not yet known — so with the feature off the site is exactly as before', () => {
      assert.equal(render(FindProtocolLinkView, { enabled: false }), '');
      assert.equal(render(FindProtocolLinkView, { enabled: undefined }), '');
      assert.equal(render(FindProtocolLink), '', 'the real component starts hidden');
      assert.equal(render(FindProtocolLink, { variant: 'cta' }), '');
    });
    it('the public header and home page show no assistant link until it is enabled, and keep everything they had', () => {
      const header = render(PublicHeader);
      assert.doesNotMatch(header, /Find a Relevant Protocol|find-protocol/);
      assert.match(header, />Browse Protocols</);
      assert.match(header, />Practitioner Login</);
      const home = render(HomePageView, { categories: [], featured: [], error: null });
      assert.doesNotMatch(home, /Find a Relevant Protocol|find-protocol/);
      assert.match(home, />Explore Protocols</);
      assert.match(home, />How It Works</);
    });
    it('the route /find-protocol exists, is PUBLIC (declared before any protected route, no login) and sits before the catch-all', () => {
      const app = read('App.jsx');
      const route = app.indexOf('path="/find-protocol"');
      assert.ok(route > -1);
      assert.match(app, /<Route path="\/find-protocol" element=\{<FindProtocolPage \/>\} \/>/);
      assert.ok(route < app.indexOf('<ProtectedRoute'), 'declared before any ProtectedRoute');
      assert.ok(route < app.indexOf('path="*"'), 'before the catch-all');
    });
    it('the header and the home page use the one shared entry-point component', () => {
      assert.match(read('pages/public/PublicHeader.jsx'), /<FindProtocolLink \/>/);
      assert.match(read('pages/public/HomePage.jsx'), /<FindProtocolLink variant="cta" \/>/);
    });
  });

  // ------------------------------------------------------------------------------------ 2. input / form
  describe('the form', () => {
    const form = (extra = {}) => render(FindProtocolView, { phase: 'form', onMessage: noop, onSubmit: noop, ...extra });
    it('has the heading, the intro sentence, and the exact placeholder', () => {
      const html = form();
      assert.match(html, /<h1>Find a Relevant Protocol<\/h1>/);
      assert.match(html, /Already know what you(?:'|&#x27;)re looking for\? Tell us the protocol or concern you(?:'|&#x27;)re looking for\./);
      assert.match(html, /placeholder="I want the Back Pain protocol"/);
    });
    it('a labelled text input, limited to 500 characters, with the example sentence and a "we do not save what you type" note', () => {
      const html = form();
      assert.match(html, /<label for="assistant-message"[^>]*>Your request<\/label>/);
      const input = html.match(/<textarea[^>]*>/)[0];
      assert.match(input, /id="assistant-message"/);
      assert.match(input, new RegExp(`maxLength="${MESSAGE_MAX}"`));
      assert.match(html, /I have lower back stiffness and don(?:'|&#x27;)t know which protocol is relevant/);
      assert.match(html, /we don(?:'|&#x27;)t save what you type/);
    });
    it('shows what was typed, and the submit button is "Find Protocol" — disabled while the box is empty or blank', () => {
      assert.match(form({ message: 'lumbago' }), /<textarea[^>]*>lumbago<\/textarea>/);
      assert.match(form(), /<button type="submit"[^>]*disabled=""[^>]*>Find Protocol<\/button>/);
      assert.match(form({ message: '   ' }), /<button type="submit"[^>]*disabled=""[^>]*>Find Protocol<\/button>/);
      const ready = form({ message: 'I want the Back Pain protocol' });
      assert.doesNotMatch(ready, /<button type="submit"[^>]*disabled/);
      assert.match(ready, />Find Protocol</);
    });
    it('is a real <form> with a submit button (so Enter and the button both submit it)', () => {
      const html = form({ message: 'x' });
      assert.match(html, /<form[^>]*aria-label="Find a relevant protocol"/);
      assert.equal(count(html, 'type="submit"'), 1);
    });
    it('always shows the exact medical disclaimer, and the site-wide medical disclaimer', () => {
      const html = form();
      assert.ok(html.includes(DISCLAIMER));
      assert.equal(DISCLAIMER_CONST, DISCLAIMER);
      assert.match(html, /do not diagnose, treat, cure, or\s+prevent/);
    });
    it('while the status is being checked it shows only a loading line — no form, no disclaimer', () => {
      const html = render(FindProtocolView, { phase: 'checking' });
      assert.match(html, /role="status">Loading…/);
      assert.doesNotMatch(html, /<form|textarea|Find Protocol|not a medical diagnosis/);
    });
    it('the real page mounts without throwing and starts in that loading state', () => {
      const html = render(FindProtocolPage);
      assert.match(html, /<h1>Find a Relevant Protocol<\/h1>/);
      assert.match(html, /Loading…/);
      assert.doesNotMatch(html, /textarea/);
    });
  });

  // ------------------------------------------------------------------------------------ 3. loading
  describe('loading', () => {
    it('while a request is running: the input and button are disabled, the button says "Finding…" and a status line explains', () => {
      const html = render(FindProtocolView, { phase: 'loading', message: 'I want the Back Pain protocol', onMessage: noop, onSubmit: noop });
      assert.match(html, /<textarea[^>]*disabled=""/);
      assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Finding…<\/button>/);
      assert.match(html, /role="status">Looking through the published protocols…/);
      assert.doesNotMatch(html, /Recommended Protocol|We couldn(?:'|&#x27;)t find/);
    });
  });

  // ------------------------------------------------------------------------------------ 4. recommendation
  describe('a recommendation', () => {
    const rec = (extra = {}) => render(FindProtocolView, { phase: 'match', result: matchResult(), onDownloadPdf: noop, onCopyLink: noop, onStartOver: noop, ...extra });
    it('shows "Recommended Protocol", the protocol name and short description, and the "may be relevant" reason', () => {
      const html = rec();
      assert.match(html, /<h2>Recommended Protocol<\/h2>/);
      assert.match(html, /<h3[^>]*>Back Pain<\/h3>/);
      assert.match(html, /A gentle routine for the lower back\./);
      assert.ok(html.includes(REASON));
      assert.match(html, /may be relevant/);
    });
    it('offers exactly the three actions: View Protocol, Download PDF, Copy Link', () => {
      const html = rec();
      assert.match(html, />View Protocol</);
      assert.match(html, />Download PDF</);
      assert.match(html, />Copy Link</);
      assert.equal(count(html, 'pv-details-actions'), 1);
    });
    it('VIEW PROTOCOL goes to the existing public protocol page /protocols/:slug — not a second protocol page, never a Studio URL', () => {
      const html = rec();
      assert.match(html, /<a href="\/protocols\/back-pain" class="pv-btn pv-btn-primary">View Protocol<\/a>/);
      assert.doesNotMatch(html, /builder|admin|\/find-protocol\/|dashboard/);
    });
    it('still carries the disclaimer the backend sent, and the medical disclaimer', () => {
      const html = rec();
      assert.ok(html.includes(DISCLAIMER));
      assert.match(html, /role="note"/);
    });
    it('shows nothing internal: no ids, scores, ranks, intents or tiers', () => {
      const html = rec({ result: matchResult({ intent: 'DIRECT_PROTOCOL_REQUEST', score: 99, tier: 'name_exact', protocolId: 'p-1' }) });
      assert.doesNotMatch(html, /score|rank|candidate|DIRECT_PROTOCOL|GENERAL_PROTOCOL|tier|name_exact|protocolId|p-1/i);
    });
    it('DOWNLOAD PDF: shows "Preparing PDF…" (disabled) while building, and a clear message if it fails', () => {
      assert.match(rec({ pdf: { busy: true, error: null } }), /<button[^>]*disabled=""[^>]*>Preparing PDF…<\/button>/);
      const failed = rec({ pdf: { busy: false, error: 'The PDF could not be built right now. Please try again.' } });
      assert.match(failed, /role="alert">The PDF could not be built right now\./);
      assert.match(failed, />Download PDF</);
    });
    it('COPY LINK: confirms with "Link copied", and if copying is blocked it shows the link itself to copy by hand', () => {
      assert.match(rec({ copyState: 'copied' }), />Link copied</);
      assert.doesNotMatch(rec({ copyState: 'copied' }), />Copy Link</);
      const failed = rec({ copyState: 'failed', linkText: 'https://clinic.example/protocols/back-pain' });
      assert.match(failed, /role="alert">The link could not be copied automatically\./);
      assert.match(failed, /https:\/\/clinic\.example\/protocols\/back-pain/);
    });
    it('offers a way to search for something else', () => {
      assert.match(rec(), />Search for something else</);
    });
    it('escapes anything it shows (a protocol name is text, never markup)', () => {
      const evil = matchResult();
      evil.protocol.name = '<img src=x onerror=alert(1)>';
      evil.protocol.description = '<script>alert(1)</script>';
      const html = rec({ result: evil });
      assert.doesNotMatch(html, /<img src=x|<script>/);
      assert.match(html, /&lt;img src=x/);
    });
    it('a match phase with no protocol does not crash and shows the form instead', () => {
      assert.match(render(FindProtocolView, { phase: 'match', result: null, onMessage: noop, onSubmit: noop }), /Find Protocol/);
    });
    it('renders exactly the actions the backend listed, in its order, with its labels — and ignores any it does not know', () => {
      const only = rec({ result: matchResult({ actions: [{ type: 'view_protocol', label: 'Open it' }] }) });
      assert.match(only, />Open it</);
      assert.doesNotMatch(only, />Download PDF<|>Copy Link<|>View Protocol</);
      const mixed = rec({ result: matchResult({ actions: [{ type: 'copy_link', label: 'Copy Link' }, { type: 'launch_missiles', label: 'Boom' }, { type: 'view_protocol', label: 'View Protocol' }] }) });
      assert.ok(mixed.indexOf('Copy Link') < mixed.indexOf('View Protocol'), 'backend order');
      assert.doesNotMatch(mixed, /Boom|launch_missiles/);
      assert.doesNotMatch(rec({ result: matchResult({ actions: [] }) }), /View Protocol|Download PDF|Copy Link/);
    });
    it('the protocol link is built by the page from the slug, never taken from the backend', () => {
      const html = rec({ result: matchResult({ actions: [{ type: 'view_protocol', label: 'View Protocol', href: 'https://evil.example', url: 'https://evil.example', path: '//evil.example' }] }) });
      assert.match(html, /href="\/protocols\/back-pain"/);
      assert.doesNotMatch(html, /evil\.example/);
    });
  });

  // ------------------------------------------------------------------------------------ the actions themselves
  describe('the Copy Link and Download PDF actions', () => {
    it('Copy Link copies the PUBLIC link /protocols/:slug on the site\'s own origin', async () => {
      let copied = null;
      const ok = await copyRecommendationLink('back-pain', { origin: 'https://clinic.example', copy: async (t) => { copied = t; return true; } });
      assert.equal(ok, true);
      assert.equal(copied, 'https://clinic.example/protocols/back-pain');
      assert.equal(await copyRecommendationLink('x', { origin: 'https://a.example', copy: async () => false }), false);
    });
    it('Copy Link works through the real clipboard helper, and reports failure instead of throwing', async () => {
      const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      let written = null;
      Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { written = t; } } }, configurable: true, writable: true });
      try { assert.equal(await copyRecommendationLink('back-pain', { origin: 'https://clinic.example' }), true); assert.equal(written, 'https://clinic.example/protocols/back-pain'); } finally { if (prev) Object.defineProperty(globalThis, 'navigator', prev); else delete globalThis.navigator; }
      Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });
      const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
      Object.defineProperty(globalThis, 'document', { value: undefined, configurable: true, writable: true });
      try { assert.equal(await copyRecommendationLink('back-pain', { origin: 'https://clinic.example' }), false); } finally { delete globalThis.navigator; if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc); else delete globalThis.document; }
    });
    it('Download PDF uses the existing PUBLISHED-snapshot download for that protocol, under its name', async () => {
      const seen = {};
      const rec = matchResult().protocol;
      const out = await downloadRecommendationPdf(rec, {
        origin: 'https://clinic.example',
        fetchRender: async (slug) => { seen.slug = slug; return { protocol: { version: { number: 3 } }, canvases: [] }; },
        build: async (render, options) => { seen.options = options; return new Uint8Array([37, 80, 68, 70]); },
        save: (bytes, base) => { seen.base = base; },
      });
      assert.equal(seen.slug, 'back-pain');
      assert.equal(seen.options.shareUrl, 'https://clinic.example/protocols/back-pain');
      assert.equal(seen.base, 'back-pain');
      assert.deepEqual([out.fileName, out.version], ['back-pain.pdf', 3]);
    });
    it('Download PDF is the existing published-snapshot download: the page hands it exactly { slug, name, displayName } and nothing else', () => {
      const page = read('pages/public/FindProtocolPage.jsx');
      assert.match(page, /downloadPublishedPdf\(\{ slug: protocol\.slug, name: protocol\.name, displayName: protocol\.name \}, options\)/);
    });
    it('and that download reads only the PUBLIC render endpoint through the API client, and produces a genuine PDF', async () => {
      api.handler = () => ({ data: { protocol: { name: 'back-pain', displayName: 'Back Pain', version: { number: 2, publishedAt: '2026-10-01T09:30:00Z' }, conditions: [], category: null }, canvases: [] } });
      let bytes;
      const rec = matchResult().protocol;
      await downloadPublishedPdf({ slug: rec.slug, name: rec.name, displayName: rec.name }, { save: (b) => { bytes = b; } });
      assert.deepEqual(api.calls.map((c) => c.url), ['/public/protocols/back-pain/render']);
      assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
    });
  });

  // ------------------------------------------------------------------------------------ 5. follow-up
  describe('the one clarifying question', () => {
    it('shows the question, an answer box limited to 300 characters, Continue (disabled until there is an answer) and Start over', () => {
      const props = { phase: 'clarification', result: clarificationResult(), onAnswer: noop, onAnswerSubmit: noop, onStartOver: noop };
      const html = render(FindProtocolView, props);
      assert.match(html, /Which part of the body, or what concern, would you like to find a protocol for\?/);
      assert.match(html.match(/<input[^>]*>/)[0], new RegExp(`maxLength="${ANSWER_MAX}"`));
      assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Continue<\/button>/);
      assert.doesNotMatch(render(FindProtocolView, { ...props, answer: 'my lower back' }), /<button type="submit"[^>]*disabled/);
      assert.match(html, />Start over</);
      assert.ok(html.includes(DISCLAIMER));
    });
  });

  // ------------------------------------------------------------------------------------ 6. no match
  describe('no match', () => {
    const view = (extra = {}) => render(FindProtocolView, { phase: 'no_match', result: noMatchResult(), onTryAgain: noop, ...extra });
    it('says "We couldn\'t find a suitable protocol", gives the plain explanation, and offers Try Again', () => {
      const html = view();
      assert.match(html, /<h2>We couldn(?:'|&#x27;)t find a suitable protocol<\/h2>/);
      assert.match(html, /We couldn(?:'|&#x27;)t find a published protocol that closely matches the information provided\./);
      assert.match(html, />Try Again</);
      assert.doesNotMatch(html, /Recommended Protocol|View Protocol/);
    });
    it('also offers to browse all protocols, and still shows the disclaimer', () => {
      const html = view();
      assert.match(html, /<a href="\/protocols"[^>]*>Browse all protocols<\/a>/);
      assert.ok(html.includes(DISCLAIMER));
    });
    it('uses the standard wording even if the server sent none', () => {
      assert.match(view({ result: { ...noMatchResult(), message: '' } }), /closely matches the information provided\./);
    });
  });

  // ------------------------------------------------------------------------------------ 7. error
  describe('errors', () => {
    const view = (errorKind) => render(FindProtocolView, { phase: 'error', errorKind, onTryAgain: noop });
    it('a failing assistant shows a clear alert, Try Again, and a way to browse', () => {
      for (const kind of ['unavailable', 'network', 'invalid']) {
        const html = view(kind);
        assert.match(html, /role="alert"/, kind);
        assert.ok(html.includes(ERROR_TEXT[kind].replace(/'/g, '&#x27;')) || html.includes(ERROR_TEXT[kind]), kind);
        assert.match(html, />Try Again</);
        assert.match(html, /<a href="\/protocols"[^>]*>Browse all protocols<\/a>/);
      }
    });
    it('the wording is calm and specific: unavailable mentions browsing, network mentions the connection', () => {
      assert.match(ERROR_TEXT.unavailable, /temporarily unavailable.*browse/i);
      assert.match(ERROR_TEXT.network, /connection/i);
      assert.match(ERROR_TEXT.invalid, /1 and 500 characters/);
    });
    it('an unknown error kind falls back to the "unavailable" message', () => {
      assert.ok(view('something-else').includes('temporarily unavailable'));
    });
    it('phaseForResult: each backend status leads to its own screen; "disabled" (switched off while the page was open) shows the unavailable state', () => {
      assert.deepEqual(phaseForResult({ status: 'disabled' }), { phase: 'disabled', result: null });
      const m = matchResult(); const c = clarificationResult(); const n = noMatchResult();
      assert.deepEqual(phaseForResult(m), { phase: 'match', result: m });
      assert.deepEqual(phaseForResult(c), { phase: 'clarification', result: c });
      assert.deepEqual(phaseForResult(n), { phase: 'no_match', result: n });
      assert.deepEqual(phaseForResult(null), { phase: 'disabled', result: null });
    });
    it('phaseForError: a 404-style "disabled" error switches the page to the disabled state; anything else is an error with its kind', () => {
      assert.deepEqual(phaseForError(new AssistantError('disabled')), { phase: 'disabled', errorKind: null });
      assert.deepEqual(phaseForError(new AssistantError('unavailable')), { phase: 'error', errorKind: 'unavailable' });
      assert.deepEqual(phaseForError(new AssistantError('network')), { phase: 'error', errorKind: 'network' });
      assert.deepEqual(phaseForError(new Error('boom')), { phase: 'error', errorKind: 'unavailable' });
      assert.deepEqual(phaseForError(undefined), { phase: 'error', errorKind: 'unavailable' });
    });
  });

  // ------------------------------------------------------------------------------------ 8. feature disabled
  describe('when the AI feature is disabled', () => {
    it('the page says the assistant is not available and offers the normal protocol browser — no form, no input, no recommendation', () => {
      const html = render(FindProtocolView, { phase: 'disabled' });
      assert.match(html, /The protocol assistant isn(?:'|&#x27;)t available right now\./);
      assert.match(html, /<a href="\/protocols"[^>]*>Browse Protocols<\/a>/);
      assert.doesNotMatch(html, /<form|<textarea|<input|Find Protocol|Recommended Protocol/);
    });
  });
});

// =============================================================================================== the client
describe('[DETERMINISTIC] the browser-side client', () => {
  beforeEach(() => { api.reset(); resetAssistantStatusCache(); });

  describe('status (is the assistant switched on?)', () => {
    it('asks GET /public/ai/status and is true only for { enabled: true }', async () => {
      api.handler = () => ({ data: { enabled: true } });
      assert.equal(await fetchAssistantStatus({ force: true }), true);
      assert.deepEqual(api.calls.map((c) => [c.method, c.url]), [['get', STATUS_PATH]]);
    });
    it('is false for { enabled: false }, for anything else, and for any failure (the entry point just stays hidden)', async () => {
      for (const data of [{ enabled: false }, {}, null, 'yes', { enabled: 'true' }, { enabled: 1 }]) {
        api.reset(); resetAssistantStatusCache(); api.handler = () => ({ data });
        assert.equal(await fetchAssistantStatus(), false, JSON.stringify(data));
      }
      for (const status of [404, 500, undefined]) {
        api.reset(); resetAssistantStatusCache(); api.handler = () => { throw Object.assign(new Error('x'), { status }); };
        assert.equal(await fetchAssistantStatus(), false, String(status));
      }
    });
    it('is asked ONCE per page load however many components need it (and again only when forced)', async () => {
      api.handler = () => ({ data: { enabled: true } });
      await Promise.all([fetchAssistantStatus(), fetchAssistantStatus(), fetchAssistantStatus()]);
      assert.equal(api.calls.length, 1);
      await fetchAssistantStatus({ force: true });
      assert.equal(api.calls.length, 2);
    });
  });

  describe('asking the assistant', () => {
    it('POSTs { message } to /public/ai/protocol-assistant, trimmed, and nothing else', async () => {
      api.handler = () => ({ data: matchResult() });
      await askProtocolAssistant({ message: '  I want the Back Pain protocol  ' });
      assert.equal(api.calls.length, 1);
      assert.deepEqual([api.calls[0].method, api.calls[0].url], ['post', ASSISTANT_PATH]);
      assert.deepEqual(api.calls[0].body, { message: 'I want the Back Pain protocol' });
    });
    it('sends followUpAnswer only for the clarifying question, together with the ORIGINAL message', async () => {
      api.handler = () => ({ data: matchResult() });
      await askProtocolAssistant({ message: 'I have some discomfort', followUpAnswer: ' my lower back ' });
      assert.deepEqual(api.calls[0].body, { message: 'I have some discomfort', followUpAnswer: 'my lower back' });
      api.reset(); api.handler = () => ({ data: matchResult() });
      await askProtocolAssistant({ message: 'x', followUpAnswer: '   ' });
      assert.deepEqual(api.calls[0].body, { message: 'x' }, 'a blank answer is not sent');
    });
    it('the request goes only to the documented public endpoint — never an authenticated, admin or Studio route', async () => {
      api.handler = () => ({ data: noMatchResult() });
      await askProtocolAssistant({ message: 'anything' });
      api.calls.forEach((c) => { assert.match(c.url, /^\/public\/ai\//); assert.doesNotMatch(c.url, /admin|protocols\/|builder/); });
    });
    it('returns a normalised MATCH', async () => {
      api.handler = () => ({ data: matchResult() });
      const r = await askProtocolAssistant({ message: 'm' });
      assert.equal(r.status, 'match');
      assert.deepEqual(r.protocol, { slug: 'back-pain', name: 'Back Pain', description: 'A gentle routine for the lower back.' });
      assert.deepEqual(r.actions, ACTIONS);
      assert.equal(r.message, REASON);
      assert.equal(r.disclaimer, DISCLAIMER);
    });
    it('returns a normalised CLARIFICATION, NO-MATCH and DISABLED', async () => {
      api.handler = () => ({ data: clarificationResult() });
      const f = await askProtocolAssistant({ message: 'm' });
      assert.deepEqual(f, { status: 'clarification', question: QUESTION, disclaimer: DISCLAIMER });
      api.handler = () => ({ data: noMatchResult() });
      assert.deepEqual(await askProtocolAssistant({ message: 'm' }), { status: 'no_match', message: NO_MATCH_TEXT, disclaimer: DISCLAIMER });
      api.handler = () => ({ data: { status: 'disabled' } });
      assert.deepEqual(await askProtocolAssistant({ message: 'm' }), { status: 'disabled' });
    });
    it('maps HTTP failures to what the page can act on: 404 disabled, 400/413 invalid, 503/5xx unavailable, no response network', async () => {
      const expect = { 404: 'disabled', 400: 'invalid', 413: 'invalid', 503: 'unavailable', 500: 'unavailable', 502: 'unavailable', undefined: 'network' };
      for (const [status, kind] of Object.entries(expect)) {
        api.reset();
        api.handler = () => { throw Object.assign(new Error('server said something'), { status: status === 'undefined' ? undefined : Number(status) }); };
        await assert.rejects(() => askProtocolAssistant({ message: 'm' }), (e) => e instanceof AssistantError && e.kind === kind, status);
      }
    });
    it('an error never carries the server\'s text or what the person typed (only a kind)', async () => {
      api.handler = () => { throw Object.assign(new Error('echoed: my-private-text-123'), { status: 503 }); };
      await assert.rejects(() => askProtocolAssistant({ message: 'my-private-text-123' }), (e) => { assert.ok(!e.message.includes('private')); assert.equal(e.message, 'unavailable'); return true; });
    });
    it('an answer that is not well-formed is treated as unavailable, never shown', async () => {
      const bad = [null, undefined, 'text', 5, [], {}, { status: 'weird' }, { outcome: 'recommendation' }, { status: 'match' }, { status: 'match', protocol: {} }, { status: 'match', protocol: { slug: '' } },
        { status: 'match', protocol: { slug: '../etc/passwd' } }, { status: 'match', protocol: { slug: 'Back Pain' } }, { status: 'match', protocol: { slug: 'javascript:alert(1)' } },
        { status: 'clarification' }, { status: 'clarification', question: '' }, { status: 'clarification', question: 5 }, { status: 'clarification', followUp: { question: 'old shape' } }];
      for (const data of bad) {
        api.reset(); api.handler = () => ({ data });
        await assert.rejects(() => askProtocolAssistant({ message: 'm' }), (e) => e instanceof AssistantError && e.kind === 'unavailable', JSON.stringify(data));
      }
    });
    it('drops anything it does not know (scores, ids, candidates a server might add by mistake)', () => {
      const out = normalizeAssistantResponse({ ...matchResult(), score: 99, rank: 1, intent: 'X', html: '<b>x</b>', url: 'https://evil.example', candidates: [{ slug: 'secret' }], protocol: { ...matchResult().protocol, id: 'p-1', score: 5, url: 'https://evil.example' } });
      assert.doesNotMatch(JSON.stringify(out), /score|rank|intent|candidates|secret|"id"|p-1|evil|html|<b>/);
      assert.deepEqual(Object.keys(out).sort(), ['actions', 'disclaimer', 'message', 'protocol', 'status']);
    });
    it('defaults missing optional fields safely', () => {
      const out = normalizeAssistantResponse({ status: 'match', protocol: { slug: 's' } });
      assert.deepEqual(out.protocol, { slug: 's', name: 's', description: '' });
      assert.deepEqual([out.message, out.actions], ['', []]);
    });
    it('keeps only actions of a known type with a short label, and never a URL', () => {
      const out = normalizeAssistantResponse(matchResult({ actions: [
        { type: 'view_protocol', label: 'View Protocol', href: 'https://evil.example' }, { type: 'run_script', label: 'x' }, { type: 'copy_link', label: '' }, { type: 'download_pdf', label: 'L'.repeat(41) }, null, 'view_protocol', { type: 'download_pdf', label: 'Download PDF' },
      ] }));
      assert.deepEqual(out.actions, [{ type: 'view_protocol', label: 'View Protocol' }, { type: 'download_pdf', label: 'Download PDF' }]);
    });
    it('the limits match the backend: 500 characters for the request, 300 for the answer', () => {
      assert.equal(MESSAGE_MAX, 500);
      assert.equal(ANSWER_MAX, 300);
    });
  });
});

// ======================================================================================= privacy and secrets
describe('[DETERMINISTIC] privacy and secrets in the browser code', () => {
  const files = ['ai/aiAssistantClient.js', 'pages/public/FindProtocolPage.jsx', 'pages/public/FindProtocolLink.jsx'];
  it('nothing the person types is stored in the browser: no localStorage, sessionStorage, IndexedDB, cookies or history state', () => {
    files.forEach((f) => assert.doesNotMatch(code(f), /localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|navigator\.sendBeacon/, f));
  });
  it('the request text never goes into a URL: no query strings or links are built from it', () => {
    const page = code('pages/public/FindProtocolPage.jsx');
    assert.doesNotMatch(page, /\?message=|\?q=|encodeURIComponent\(message|navigate\(|useNavigate|useSearchParams/);
    assert.doesNotMatch(code('ai/aiAssistantClient.js'), /params:/, 'the client sends a POST body, not query parameters');
  });
  it('no AI key, provider name or SDK appears anywhere in the frontend source (the key lives only on the backend)', () => {
    const all = [];
    (function walk(d) { readdirSync(d).forEach((n) => { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(n)) all.push(p); }); }(SRC));
    all.forEach((p) => assert.doesNotMatch(readFileSync(p, 'utf8'), /AI_API_KEY|VITE_AI|openai|anthropic|sk-[A-Za-z0-9]{10,}/i, p));
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    assert.doesNotMatch(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' '), /openai|anthropic|generative-ai|langchain/i);
  });
  it('the page reuses the existing public protocol page, PDF and share code instead of building a second one', () => {
    const page = read('pages/public/FindProtocolPage.jsx');
    assert.match(page, /from '\.\.\/\.\.\/viewer\/pdf\/publishedPdf'/);
    assert.match(page, /from '\.\.\/\.\.\/viewer\/shareLink'/);
    assert.match(page, /to=\{`\/protocols\/\$\{r\.slug\}`\}/);
    assert.doesNotMatch(page, /renderMarkings|HandViewsViewer|buildPdf'/, 'no second renderer');
  });
});
