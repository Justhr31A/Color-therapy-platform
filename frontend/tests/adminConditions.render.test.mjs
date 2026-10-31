/**
 * [DETERMINISTIC · rendering] the Admin Conditions/Diseases page. As with the public pages, the markup is split
 * into a plain, prop-driven `AdminConditionsView` and a thin data-fetching wrapper — `useEffect` never runs
 * during a static render, so only the View half can be rendered directly and inspected here; the wrapper gets
 * one smoke test that it mounts against the real API client and shows the initial loading state.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import api from './support/stubs/apiClient.mjs';
import { loadComponent, RENDER_SKIP } from './support/renderJsx.mjs';

const count = (html, needle) => html.split(needle).length - 1;
const noop = () => {};

const condition = (over = {}) => ({
  id: 'c1', name: 'Migraine', slug: 'migraine', description: 'Recurring headaches, often one-sided.',
  categoryId: null, isActive: true, synonyms: ['sick headache'], protocolCount: 2,
  createdAt: '2026-09-01 00:00:00', updatedAt: '2026-09-01 00:00:00', ...over,
});

let AdminConditionsView; let AdminConditionsPage; let filterConditions; let parseSynonyms; let toFormFromCondition; let emptyForm;
const render = (props) => renderToStaticMarkup(h(AdminConditionsView, {
  conditions: [], loading: false, error: null, query: '', onQueryChange: noop,
  formOpen: false, formMode: 'create', form: emptyForm, formError: null, saving: false,
  onOpenCreate: noop, onOpenEdit: noop, onCancelForm: noop, onFormChange: noop, onSubmit: noop, onToggleActive: noop,
  ...props,
}));

describe('[DETERMINISTIC] pure logic (no rendering)', { skip: RENDER_SKIP }, () => {
  // Even a plain, JSX-free export has to go through the esbuild loader here: the file also contains real JSX
  // elsewhere, and Node cannot parse JSX syntax at all — not even enough to skip past it to reach an unrelated
  // export — so a plain `import()` of this file fails outright, same as it would for the View component itself.
  before(async () => {
    ({ filterConditions, parseSynonyms, toFormFromCondition, emptyForm } = await loadComponent('src/pages/admin/AdminConditionsPage.jsx'));
  });

  it('filterConditions matches by name, description, or any synonym, case-insensitively; empty query returns everything', () => {
    const list = [condition({ id: 'a', name: 'Migraine', description: 'Head pain', synonyms: ['sick headache'] }), condition({ id: 'b', name: 'Sciatica', description: 'Nerve pain', synonyms: ['lumbago'] })];
    assert.deepEqual(filterConditions(list, ''), list);
    assert.deepEqual(filterConditions(list, '  ').map((c) => c.id), ['a', 'b']);
    assert.deepEqual(filterConditions(list, 'MIGRA').map((c) => c.id), ['a']);
    assert.deepEqual(filterConditions(list, 'nerve').map((c) => c.id), ['b']);
    assert.deepEqual(filterConditions(list, 'lumbago').map((c) => c.id), ['b']);
    assert.deepEqual(filterConditions(list, 'no match'), []);
  });

  it('parseSynonyms trims each entry and drops empties; does not deduplicate (the server is the source of truth for that)', () => {
    assert.deepEqual(parseSynonyms(' lower back pain , lumbago ,, '), ['lower back pain', 'lumbago']);
    assert.deepEqual(parseSynonyms(''), []);
  });

  it('toFormFromCondition maps a condition onto the edit form fields, joining synonyms back into the comma-separated text field', () => {
    const form = toFormFromCondition(condition({ synonyms: ['a', 'b'] }));
    assert.deepEqual(form, { name: 'Migraine', description: 'Recurring headaches, often one-sided.', synonymsText: 'a, b', isActive: true });
  });

  it('toFormFromCondition handles a condition with no description and no synonyms', () => {
    const form = toFormFromCondition(condition({ description: null, synonyms: [] }));
    assert.deepEqual(form, { name: 'Migraine', description: '', synonymsText: '', isActive: true });
  });
});

describe('[DETERMINISTIC · rendering] Admin Conditions page', { skip: RENDER_SKIP }, () => {
  before(async () => {
    ({ default: AdminConditionsPage, AdminConditionsView, filterConditions, parseSynonyms, toFormFromCondition, emptyForm } = await loadComponent('src/pages/admin/AdminConditionsPage.jsx'));
  });

  it('shows the page title, search box, and Add Condition button', () => {
    const html = render({});
    assert.match(html, /<h1>Conditions \/ Diseases<\/h1>/);
    assert.match(html, /aria-label="Search conditions"/);
    assert.match(html, />\+ Add Condition</);
  });

  it('a link back to the dashboard is present', () => {
    assert.match(render({}), /href="\/dashboard"/);
  });

  it('loading state shows a loading message and no table', () => {
    const html = render({ loading: true });
    assert.match(html, /Loading conditions/);
    assert.doesNotMatch(html, /<table/);
  });

  it('an API error shows a usable error message', () => {
    const html = render({ error: 'Network error' });
    assert.match(html, /role="alert"/);
    assert.match(html, /Network error/);
  });

  it('no conditions and no search query: a clean "add the first one" empty state', () => {
    const html = render({ conditions: [] });
    assert.match(html, /add the first one above/);
  });

  it('no conditions WITH a search query: a "no matches" empty state, distinct from the truly-empty one', () => {
    const html = render({ conditions: [], query: 'xyz' });
    assert.match(html, /No conditions match your search/);
    assert.doesNotMatch(html, /add the first one above/);
  });

  it('the table shows name, description, status pill, protocol count, and Edit/Archive actions per condition', () => {
    const html = render({ conditions: [condition()] });
    assert.match(html, /<td>Migraine<\/td>/);
    assert.match(html, /Recurring headaches, often one-sided\./);
    assert.match(html, /class="pill status">Active</);
    assert.match(html, /<td>2<\/td>/, 'protocol count');
    assert.match(html, />Edit</);
    assert.match(html, />Archive</);
  });

  it('an inactive condition shows an "Archived" pill and an "Activate" action instead', () => {
    const html = render({ conditions: [condition({ isActive: false })] });
    assert.match(html, /class="pill warn">Archived</);
    assert.match(html, />Activate</);
    assert.doesNotMatch(html, />Archive</);
  });

  it('a condition with no description shows a plain placeholder instead of an empty cell', () => {
    const html = render({ conditions: [condition({ description: '' })] });
    assert.match(html, /<span class="muted">—<\/span>/);
  });

  it('multiple conditions each get their own row', () => {
    const html = render({ conditions: [condition({ id: 'a', name: 'Migraine' }), condition({ id: 'b', name: 'Sciatica' })] });
    assert.equal(count(html, '<tr>') - 1, 2, 'one header row plus one per condition (minus the thead tr)');
    assert.match(html, /Migraine/);
    assert.match(html, /Sciatica/);
  });

  it('the create form shows Name, Description, Search terms/synonyms, and an Active checkbox, with "Add Condition" as the title', () => {
    const html = render({ formOpen: true, formMode: 'create', form: emptyForm });
    assert.match(html, /Add Condition<\/h2>/);
    assert.match(html, /<span>Name<\/span>/);
    assert.match(html, /<span>Description<\/span>/);
    assert.match(html, /Search terms \/ synonyms/);
    assert.match(html, /type="checkbox"/);
    assert.match(html, />Create Condition</);
  });

  it('the edit form is titled "Edit Condition", pre-filled from the given condition, and offers "Save Changes"', () => {
    const html = render({ formOpen: true, formMode: 'edit', form: toFormFromCondition(condition({ synonyms: ['sick headache', 'hemicrania'] })) });
    assert.match(html, /Edit Condition<\/h2>/);
    assert.match(html, /value="Migraine"/);
    assert.match(html, /value="sick headache, hemicrania"/);
    assert.match(html, /checked=""/, 'the Active checkbox reflects isActive: true');
    assert.match(html, />Save Changes</);
  });

  it('a form error is shown, and Save/Create disables while saving', () => {
    const html = render({ formOpen: true, formError: 'That name is already in use.', saving: true });
    assert.match(html, /That name is already in use\./);
    assert.match(html, /disabled=""[^>]*>Saving…</);
  });

  it('the form is hidden until Add Condition or Edit is used', () => {
    assert.doesNotMatch(render({ formOpen: false }), /<form/);
  });

  it('has no protocol-editing or publishing controls anywhere on the page — this manages conditions only', () => {
    const html = render({ conditions: [condition()], formOpen: true });
    ['Publish', 'Duplicate protocol', 'Save Protocol', 'Delete protocol'].forEach((label) => assert.doesNotMatch(html, new RegExp(label)));
  });

  it('the real wrapper mounts and shows the initial loading state without throwing', () => {
    // React never runs a component's effects during a static/server render (see the other page test files'
    // identical smoke test), so this proves the wrapper's INITIAL state renders safely — not that a fetch
    // happened. A never-resolving handler keeps that true regardless of timing.
    api.reset();
    api.handler = () => new Promise(() => {});
    const html = renderToStaticMarkup(h(AdminConditionsPage));
    assert.match(html, /Loading conditions/);
  });
});
