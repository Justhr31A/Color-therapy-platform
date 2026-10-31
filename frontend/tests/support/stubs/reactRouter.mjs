// Test double for the small slice of `react-router-dom` the public pages actually use: `Link`, `useParams`,
// `useSearchParams`. Real client-side navigation needs a browser; this only lets a page render to static HTML
// against test-controlled route params / query string, the same one-shot-render approach every other render
// test in this suite already uses (see stubs/reactKonva.mjs).
import { createElement, forwardRef } from 'react';

let testParams = {};
let testSearch = new URLSearchParams();

/** Call before rendering a page that reads route params (e.g. ProtocolDetailsPage's `:slug`). */
export function __setRouteParams(params) { testParams = params || {}; }
/** Call before rendering a page that reads the query string (e.g. ProtocolBrowserPage's ?q=&category=). */
export function __setSearch(search) { testSearch = new URLSearchParams(search || ''); }
export function __reset() { testParams = {}; testSearch = new URLSearchParams(); }

export const Link = forwardRef(function LinkStub({ to, children, ...rest }, ref) {
  return createElement('a', { href: to, ref, ...rest }, children);
});

export function useParams() { return testParams; }

// The setter is recorded so a test can assert what a filter change WOULD have asked for, even though a static
// render can't actually re-render with the new query string (see the test file for how this is used).
export function useSearchParams() {
  const setSearchParams = (next) => {
    testSearch = next instanceof URLSearchParams ? next : new URLSearchParams(next);
    useSearchParams.lastSet = testSearch;
  };
  return [testSearch, setSearchParams];
}

// Added for the camera pages: navigation hooks/components a static render can't perform. `Navigate` renders a marker
// element so a test can assert where the page WOULD have redirected; `useNavigate` records requested destinations.
export const navigateCalls = [];
export function useNavigate() { return (to) => navigateCalls.push(to); }
export function useLocation() { return { pathname: '/', search: '', state: null }; }
export function Navigate({ to, replace }) {
  return createElement('meta', { 'data-navigate-to': to, 'data-replace': replace ? 'true' : 'false' });
}
