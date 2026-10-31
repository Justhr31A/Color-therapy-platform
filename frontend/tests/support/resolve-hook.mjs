
/**
 * Module-resolution hook for running app source files under Node tests.
 * Supports extensionless relative imports and Windows absolute file paths.
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const API_CLIENT_STUB = new URL('./stubs/apiClient.mjs', import.meta.url).href;
const ZUSTAND_STUB = new URL('./stubs/zustandServerState.mjs', import.meta.url).href;

const isRelative = (s) => s.startsWith('./') || s.startsWith('../');
const hasExtension = (s) => /\.[a-z0-9]+$/i.test(s);

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === 'zustand' &&
    context.parentURL &&
    context.parentURL.endsWith('/src/builder/store.js')
  ) {
    return { url: ZUSTAND_STUB, format: 'module', shortCircuit: true };
  }

  let normalizedSpecifier = specifier;

  // Convert Windows absolute filesystem paths into valid file URLs.
  if (path.isAbsolute(specifier) && /^[a-z]:[\\/]/i.test(specifier)) {
    normalizedSpecifier = pathToFileURL(specifier).href;
  }

  let result;

  try {
    result = await nextResolve(normalizedSpecifier, context);
  } catch (err) {
    const missing =
      err.code === 'ERR_MODULE_NOT_FOUND' ||
      err.code === 'ERR_UNSUPPORTED_DIR_IMPORT';

    if (missing && isRelative(normalizedSpecifier) && !hasExtension(normalizedSpecifier)) {
      result = await nextResolve(`${normalizedSpecifier}.js`, context).catch(() => null);
      if (!result) throw err;
    } else {
      throw err;
    }
  }

  if (result.url.endsWith('/src/api/client.js')) {
    return { ...result, url: API_CLIENT_STUB, shortCircuit: true };
  }

  return result;
}
