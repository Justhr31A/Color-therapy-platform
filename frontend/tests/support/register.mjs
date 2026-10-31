// Loaded with `node --import ./tests/support/register.mjs` (see package.json "test").
import { register } from 'node:module';

register('./resolve-hook.mjs', import.meta.url);
