/**
 * [DETERMINISTIC SOFTWARE TESTS] the Studio's wiring for the DOCTOR workflow — the parts a static render cannot show.
 *
 *  - which API each kind of user gets (metaModeFor / metaEndpoints);
 *  - CONTRACT: every endpoint the Protocol tab calls exists on the backend, with that HTTP method, and a doctor's
 *    endpoints never touch /api/admin — so the UI can never be wired to a route the server would refuse;
 *  - the Studio passes the doctor through to the panel (it is no longer admin-gated) and refreshes after saving.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { metaModeFor, metaEndpoints } from '../src/builder/useProtocolMeta.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const BACKEND = '../../backend/src/';

describe('[DETERMINISTIC] who gets which API', () => {
  it('admins use the admin API, doctors the owner-scoped one; anyone else gets none', () => {
    assert.equal(metaModeFor({ role: 'admin' }), 'admin');
    assert.equal(metaModeFor({ role: 'doctor' }), 'doctor');
    [null, undefined, {}, { role: 'patient' }, { role: 'ADMIN' }, { role: '' }, { role: 'superuser' }].forEach((u) => assert.equal(metaModeFor(u), null, JSON.stringify(u)));
  });

  it('a DOCTOR\'s endpoints never touch /api/admin, and have no version history, restore, archive or status', () => {
    const E = metaEndpoints('doctor', 'P1');
    const all = JSON.stringify([E.details, E.categories, E.conditions, E.saveDetails, E.searchTerms, E.searchTerm('T'), E.attach('C'), E.detach('C'), E.publish]);
    assert.doesNotMatch(all, /admin/);
    assert.equal(E.versions, null);
    assert.deepEqual(Object.keys(E).sort(), ['attach', 'categories', 'conditions', 'detach', 'details', 'publish', 'saveDetails', 'searchTerm', 'searchTerms', 'versions']);
  });

  it('a doctor publishes through the existing owner-scoped publish endpoint; an admin through the existing admin one (there is no second endpoint)', () => {
    assert.equal(metaEndpoints('doctor', 'P1').publish, '/protocols/P1/publish');
    assert.equal(metaEndpoints('admin', 'P1').publish, '/admin/protocols/P1/publish');
  });

  it('the ADMIN endpoints are exactly what they were before (no regression for administrators)', () => {
    const E = metaEndpoints('admin', 'P1');
    assert.deepEqual(
      { details: E.details, categories: E.categories, conditions: E.conditions, versions: E.versions, saveDetails: E.saveDetails, searchTerms: E.searchTerms, searchTerm: E.searchTerm('T1'), attach: E.attach('C1'), detach: E.detach('C1'), publish: E.publish },
      {
        details: '/admin/protocols/P1', categories: '/admin/categories', conditions: '/admin/conditions', versions: '/admin/protocols/P1/versions', saveDetails: '/admin/protocols/P1',
        searchTerms: '/admin/protocols/P1/search-terms', searchTerm: '/admin/protocols/P1/search-terms/T1',
        attach: { url: '/admin/conditions/C1/protocols', body: { protocolId: 'P1' } }, detach: '/admin/conditions/C1/protocols/P1', publish: '/admin/protocols/P1/publish',
      },
    );
  });

  it('attaching a condition sends the condition id in the body for a doctor, and the protocol id for an admin (matching each backend route)', () => {
    assert.deepEqual(metaEndpoints('doctor', 'P1').attach('C1'), { url: '/protocols/P1/conditions', body: { conditionId: 'C1' } });
    assert.deepEqual(metaEndpoints('admin', 'P1').attach('C1').body, { protocolId: 'P1' });
  });
});

// ------------------------------------------------------------------------------- CONTRACT with the backend
/** Every `METHOD path` the backend registers, with route parameters normalised to `:p`. Mount prefixes come from server.js. */
function backendRoutes() {
  const server = read(`${BACKEND}server.js`);
  const files = {};
  [...server.matchAll(/const (\w+) = require\('\.\/routes\/([\w.]+)'\)/g)].forEach((m) => { files[m[1]] = m[2]; });
  const routes = new Set();
  [...server.matchAll(/app\.use\('(\/api\/[\w/]+)',\s*(\w+)\)/g)].forEach(([, prefix, variable]) => {
    if (!files[variable]) return;
    const src = read(`${BACKEND}routes/${files[variable]}.js`);
    [...src.matchAll(/router\.(get|post|put|delete)\(\s*'([^']*)'/g)].forEach(([, method, p]) => {
      routes.add(`${method.toUpperCase()} ${prefix}${p === '/' ? '' : p}`.replace(/:[A-Za-z]+/g, ':p'));
    });
  });
  return routes;
}

describe('[DETERMINISTIC] CONTRACT: every endpoint the Protocol tab calls exists on the backend, with that method', () => {
  const routes = backendRoutes();
  const asRoute = (method, url) => `${method} /api${url}`.replace(/\/\$\{[^}]+\}/g, '/:p');

  it('the backend route table was actually read (guards against this test passing on an empty table)', () => {
    assert.ok(routes.size > 40, `read ${routes.size} routes`);
    assert.ok(routes.has('POST /api/protocols/:p/publish'));
    assert.ok(routes.has('POST /api/admin/protocols/:p/publish'));
    assert.ok(routes.has('GET /api/catalog/categories'));
  });

  it('DOCTOR mode: every endpoint is a registered owner-scoped / catalog route', () => {
    const E = metaEndpoints('doctor', ':p');
    const calls = [
      ['GET', E.details], ['PUT', E.saveDetails], ['GET', E.categories], ['GET', E.conditions], ['POST', E.searchTerms],
      ['DELETE', E.searchTerm(':p')], ['POST', E.attach(':p').url], ['DELETE', E.detach(':p')], ['POST', E.publish],
    ];
    calls.forEach(([method, url]) => assert.ok(routes.has(`${method} /api${url}`.replace(/:[A-Za-z]+/g, ':p')), `${method} /api${url} is not a backend route`));
  });

  it('ADMIN mode: every endpoint is still a registered admin route', () => {
    const E = metaEndpoints('admin', ':p');
    const calls = [
      ['GET', E.details], ['GET', E.categories], ['GET', E.conditions], ['GET', E.versions], ['PUT', E.saveDetails], ['POST', E.searchTerms],
      ['DELETE', E.searchTerm(':p')], ['POST', E.attach(':p').url], ['DELETE', E.detach(':p')], ['POST', E.publish],
    ];
    calls.forEach(([method, url]) => assert.ok(routes.has(`${method} /api${url}`.replace(/:[A-Za-z]+/g, ':p')), `${method} /api${url} is not a backend route`));
  });

  it('every API call written directly in the hook (create category/condition, status, archive, restore) is a registered admin route too', () => {
    const hook = read('../src/builder/useProtocolMeta.js');
    const literal = [...hook.matchAll(/api\.(get|post|put|delete)\(\s*[`']([^`']+)[`']/g)].map((m) => asRoute(m[1].toUpperCase(), m[2]));
    assert.ok(literal.length >= 5, `found ${literal.length} literal calls`);
    literal.forEach((r) => {
      assert.ok(routes.has(r), `${r} is not a backend route`);
      assert.match(r, /\/api\/admin\//, 'and these are the admin-only actions: a doctor session never reaches them (the hook refuses before calling)');
    });
  });

  it('the hook refuses the admin-only actions in doctor mode instead of sending them to the server', () => {
    const hook = read('../src/builder/useProtocolMeta.js');
    ['createCondition', 'createCategory', 'changeStatus', 'archive', 'restoreVersion'].forEach((name) => {
      assert.match(hook, new RegExp(`${name}: adminOnly\\(`), `${name} must be wrapped in adminOnly()`);
    });
    assert.match(hook, /Only an administrator can do that\./);
  });

  it('the Studio/panel never call a route outside the owner/admin API: no other api calls hide in the panel', () => {
    const panel = read('../src/builder/ProtocolMetadataPanel.jsx');
    assert.doesNotMatch(panel, /api\.(get|post|put|delete)\(/, 'the panel talks to the server only through `meta` and the published-PDF helper');
  });
});

// -------------------------------------------------------------------------------- the Studio passes the doctor through
describe('[DETERMINISTIC] the Studio is no longer admin-gated for the doctor workflow (source wiring)', () => {
  const studio = read('../src/builder/ProtocolStudio.jsx');

  it('the metadata hook is enabled for any user with a mode (doctor or admin), not just admins', () => {
    assert.match(studio, /const metaMode = metaModeFor\(user\);/);
    assert.match(studio, /useProtocolMeta\(protocolId, Boolean\(metaMode\), \{ mode: metaMode \|\| 'admin'/);
    assert.doesNotMatch(studio, /useProtocolMeta\(protocolId, isAdmin/);
  });

  it('no part of the Studio still refreshes details only for admins', () => {
    assert.doesNotMatch(studio, /if \(isAdmin\) meta\.reload\(\)/);
    assert.equal((studio.match(/if \(metaMode\) meta\.reload\(\)/g) || []).length, 2, 'rename and legacy status refresh for doctors too');
  });

  it('the panel gets everything the doctor flow needs: canManage, onPublish, onSave, hasChanges, saving', () => {
    const tag = studio.match(/<ProtocolMetadataPanel[^>]*\/>/)[0];
    ['isAdmin={isAdmin}', 'canManage={Boolean(metaMode)}', 'onPublish={handlePublish}', 'onSave={handleSave}', 'hasChanges={hasChanges}', 'saving='].forEach((s) => assert.ok(tag.includes(s), s));
  });

  it('saving the markings refreshes the server picture, so "unpublished changes" is accurate straight after an edit of a published protocol', () => {
    const save = studio.match(/const handleSave = async \(\) => \{[\s\S]*?\n  \};/)[0];
    assert.match(save, /await save\(\);\s*\n\s*\/\/[^\n]*\n\s*if \(metaMode\) await meta\.reload\(\);/);
  });

  it('publishing saves first, then calls the ONE publish action, then syncs the top bar from the server\'s answer', () => {
    const publish = studio.match(/const handlePublish = async \(note\) => \{[\s\S]*?\n  \};/)[0];
    const saveAt = publish.indexOf('await handleSave()');
    const publishAt = publish.indexOf('meta.publish(note)');
    assert.ok(saveAt >= 0, 'publishing must save the latest edits first');
    assert.ok(publishAt >= 0, 'and then call the publish action');
    assert.ok(saveAt < publishAt, 'save before publish');
    assert.match(publish, /if \(!\(await handleSave\(\)\)\) return false;/, 'and if saving fails, nothing is published');
    assert.match(publish, /result\.data\.protocol/);
    assert.match(publish, /status: published\.status, currentVersion: published\.currentVersion/);
    assert.doesNotMatch(publish, /api\.post\(/, 'no second publishing call exists in the Studio');
  });

  it('a doctor publishing for the first time is asked to confirm (it makes the protocol visible to anyone with the link); admin behaviour is unchanged', () => {
    const publish = studio.match(/const handlePublish = async \(note\) => \{[\s\S]*?\n  \};/)[0];
    assert.match(publish, /!hasChanges && !isAdmin && firstPublish && !window\.confirm\('Publish this protocol\? Anyone with its link will be able to view it\.'\)/);
    assert.match(publish, /if \(hasChanges && !window\.confirm\('Save your latest edits and publish them as a new version\?'\)\) return false;/);
  });

  it('the old misleading sentence is gone from the whole frontend source', () => {
    const panel = read('../src/builder/ProtocolMetadataPanel.jsx');
    assert.doesNotMatch(panel, /and publishing are managed by an administrator/);
    assert.doesNotMatch(studio, /managed by an administrator/);
  });
});
