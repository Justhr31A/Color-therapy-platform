// Loads a .jsx component for tests. Node cannot import JSX, so it is compiled with esbuild (a dependency of Vite, so always present with the project).
//  - the Studio STORE is kept external so the component and the test share the one real store instance;
//  - `react-konva` is replaced by tests/support/stubs/reactKonva.mjs, and src/api/client.js by the API stub (same as the other tests).
// Everything else is the real, shipped code.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(here, '../..');
const STORE = join(FRONTEND, 'src/builder/store.js');
const KONVA_STUB = join(here, 'stubs/reactKonva.mjs');
const API_STUB = join(here, 'stubs/apiClient.mjs');
const ROUTER_STUB = join(here, 'stubs/reactRouter.mjs');
// Canonical form of the one store file every test and every compiled component must share (see the
// onResolve plugin below). realpathSync resolves symlinks and, importantly, normalizes a path to the
// casing the filesystem actually has for it; on a case-insensitive filesystem (Windows, default macOS)
// two strings that *look* different (e.g. a drive letter typed as "c:\" vs "C:\", or a resolved path
// built with ".js" vs one built with a different case) can refer to the very same file, so comparing
// the raw strings is unreliable there. A plain string compare only ever happens to work when every path
// component's original casing already matches by coincidence, which is exactly the kind of thing that
// differs between environments.
const STORE_REAL = realpathSync(STORE);
const canonical = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
const STORE_URL = pathToFileURL(STORE_REAL).href;
const OUT = join(FRONTEND, 'node_modules/.cache/studio-render-tests');

const require = createRequire(import.meta.url);
function findEsbuild() {
  for (const attempt of [() => require('esbuild'), () => createRequire(require.resolve('vite'))('esbuild')]) {
    try { return attempt(); } catch (e) { /* try the next place */ }
  }
  return null;
}
export const esbuild = findEsbuild();
export const RENDER_SKIP = esbuild ? false : 'esbuild is not installed (it ships with Vite; run npm install in frontend/)';

let counter = 0;
export async function loadComponent(relativePath) {
  if (!esbuild) throw new Error(RENDER_SKIP);
  const plugin = {
    name: 'studio-test-resolver',
    setup(build) {
      build.onResolve({ filter: /^react-konva$/ }, () => ({ path: KONVA_STUB }));
      build.onResolve({ filter: /(^|\/)api\/client$/ }, () => ({ path: API_STUB }));
      build.onResolve({ filter: /^react-router-dom$/ }, () => ({ path: ROUTER_STUB }));
      // Every component that reads the Studio's Zustand store must resolve to the exact SAME module
      // instance the test itself imported (`import useProtocolStore from '../src/builder/store.js'`) —
      // otherwise `S().loadProtocol(...)` in the test writes to one store while the rendered component
      // reads from an unrelated, still-empty one, and the component silently renders as if nothing had
      // ever been loaded (this is exactly what produced the 26 failures: a workspace with zero canvases,
      // no active tool, no selection — every symptom traces back to this one thing). So this match is
      // NOT a style preference; getting it wrong breaks nearly everything that reads the store, silently
      // and without a thrown error, which is why it needs to be robust rather than "usually right".
      build.onResolve({ filter: /^\.\.?\/(.*\/)?store$/ }, (args) => {
        const attempted = `${resolve(args.resolveDir, args.path)}.js`;
        let real;
        try { real = realpathSync(attempted); } catch { return undefined; } // not a real file here; let esbuild's default resolution report the error
        return canonical(real) === canonical(STORE_REAL) ? { path: STORE_URL, external: true } : undefined;
      });
    },
  };
  const result = await esbuild.build({
    entryPoints: [join(FRONTEND, relativePath)], bundle: true, write: false, format: 'esm', platform: 'node',
    packages: 'external', jsx: 'automatic', loader: { '.js': 'jsx', '.css': 'empty' }, plugins: [plugin], logLevel: 'silent',
    define: { 'import.meta.env': '{}' },
  });
  mkdirSync(OUT, { recursive: true });
  counter += 1;
  const file = join(OUT, `${relativePath.replace(/[^a-z0-9]+/gi, '_')}.${process.pid}.${counter}.mjs`);
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}
