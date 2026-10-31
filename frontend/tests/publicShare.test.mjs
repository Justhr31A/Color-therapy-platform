/**
 * [DETERMINISTIC SOFTWARE TESTS] sharing a published protocol (src/viewer/shareLink.js) and the public route it points to.
 * The link is the EXISTING public route /protocols/:slug — nothing is generated or stored — so these tests pin down the URL,
 * the clipboard behaviour, and that the route a shared link opens is really public and read-only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publicProtocolPath, publicProtocolUrl, copyText } from '../src/viewer/shareLink.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const setGlobal = (name, value) => { const prev = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); return () => { if (prev) Object.defineProperty(globalThis, name, prev); else delete globalThis[name]; }; };

describe('[DETERMINISTIC] the shareable link is the existing public protocol route', () => {
  it('the path is /protocols/:slug using the protocol\'s stable slug', () => {
    assert.equal(publicProtocolPath('back-pain-website-test-protocol'), '/protocols/back-pain-website-test-protocol');
  });
  it('the absolute URL is the site origin + that path, with no doubled slash', () => {
    assert.equal(publicProtocolUrl('knee-pain', 'https://clinic.example'), 'https://clinic.example/protocols/knee-pain');
    assert.equal(publicProtocolUrl('knee-pain', 'https://clinic.example/'), 'https://clinic.example/protocols/knee-pain');
    assert.equal(publicProtocolUrl('knee-pain', 'http://localhost:5173'), 'http://localhost:5173/protocols/knee-pain');
  });
  it('defaults to the page\'s own origin, so the link points at whichever site the doctor is signed in to', () => {
    const restore = setGlobal('window', { location: { origin: 'https://app.example' } });
    try { assert.equal(publicProtocolUrl('x'), 'https://app.example/protocols/x'); } finally { restore(); }
  });
  it('with no page origin available it still returns a usable relative path rather than "undefined"', () => {
    const restore = setGlobal('window', undefined);
    try { assert.equal(publicProtocolUrl('x'), '/protocols/x'); } finally { restore(); }
  });
  it('a slug is URL-encoded so it can never break out of the path', () => {
    assert.equal(publicProtocolPath('a b/c?d'), '/protocols/a%20b%2Fc%3Fd');
    assert.doesNotMatch(publicProtocolUrl('../admin', 'https://x.test'), /\/protocols\/\.\.\/admin/);
  });
  it('the Studio and the public page build the link with the SAME function (one definition of "the public URL")', () => {
    assert.match(read('../src/builder/ProtocolMetadataPanel.jsx'), /publicProtocolUrl\(/);
    assert.match(read('../src/pages/public/ProtocolDetailsPage.jsx'), /publicProtocolUrl\(/);
  });
});

describe('[DETERMINISTIC] the route a shared link opens is public, and has no way to edit', () => {
  const app = read('../src/App.jsx');
  it('/protocols/:slug is a route, and it is declared OUTSIDE every ProtectedRoute (no login needed to open a shared link)', () => {
    const route = app.indexOf('path="/protocols/:slug"');
    assert.ok(route > -1, 'the route exists');
    assert.ok(route < app.indexOf('<ProtectedRoute'), 'declared before any protected block');
    assert.match(app, /path="\/protocols\/:slug" element=\{<ProtocolDetailsPage \/>\}/);
  });
  it('the public details page imports no Studio / admin editing code and calls only /public API endpoints', () => {
    const page = read('../src/pages/public/ProtocolDetailsPage.jsx');
    assert.doesNotMatch(page, /builder\/store|ProtocolStudio|\/admin\//);
    const apiCalls = [...page.matchAll(/api\.(get|post|put|delete)\(`?['"]?([^'"`)]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.ok(apiCalls.length >= 2);
    apiCalls.forEach((c) => assert.match(c, /^get \/public\//, `only public reads: ${c}`));
  });
});

describe('[DETERMINISTIC] copying the link', () => {
  it('uses the async Clipboard API when it exists, and reports success', async () => {
    let written = null;
    const restore = setGlobal('navigator', { clipboard: { writeText: async (t) => { written = t; } } });
    try {
      assert.equal(await copyText('https://clinic.example/protocols/x'), true);
      assert.equal(written, 'https://clinic.example/protocols/x');
    } finally { restore(); }
  });
  it('falls back to a hidden textarea + execCommand when the Clipboard API is missing or rejects', async () => {
    const calls = [];
    const ta = { style: {}, setAttribute() {}, select() { calls.push('select'); }, remove() { calls.push('remove'); } };
    const restoreDoc = setGlobal('document', { createElement: () => ta, body: { appendChild: () => calls.push('append') }, execCommand: (c) => { calls.push(c); return true; } });
    const restoreNav = setGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    try {
      assert.equal(await copyText('hello'), true);
      assert.equal(ta.value, 'hello');
      assert.deepEqual(calls, ['append', 'select', 'copy', 'remove']);
    } finally { restoreDoc(); restoreNav(); }
  });
  it('reports failure (false) — never throws — when nothing can copy', async () => {
    const restoreNav = setGlobal('navigator', undefined);
    const restoreDoc = setGlobal('document', undefined);
    try { assert.equal(await copyText('x'), false); } finally { restoreNav(); restoreDoc(); }
    const restoreDoc2 = setGlobal('document', { createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }), body: { appendChild() {} }, execCommand: () => false });
    const restoreNav2 = setGlobal('navigator', {});
    try { assert.equal(await copyText('x'), false); } finally { restoreDoc2(); restoreNav2(); }
  });
});
