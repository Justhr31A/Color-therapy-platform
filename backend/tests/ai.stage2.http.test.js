/**
 * [DETERMINISTIC SOFTWARE TESTS — HTTP level, real server.js + real SQLite]
 * AI Stage 2 matching driven by metadata that doctors and admins enter through the real APIs: protocol names,
 * conditions, condition synonyms (admin) and protocol search terms (doctor). Nothing is stubbed.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { HTTP_SKIP, bootstrap, dot } = require('./helpers/httpHarness');

const ASK = '/api/public/ai/protocol-assistant';
const A = '/api/admin';

describe('[DETERMINISTIC · HTTP] AI Stage 2 matching from real protocol metadata', { skip: HTTP_SKIP }, () => {
  let h; const ids = {}; let conds = {};
  const ask = (message, followUpAnswer) => h.anon.post(ASK, followUpAnswer ? { message, followUpAnswer } : { message });
  const slugOf = (r) => (r.json && r.json.protocol ? r.json.protocol.slug : null);

  async function makeProtocol(key, { name, shortDescription, terms = [], conditionIds = [], publish = true }) {
    const p = (await h.doctor.post('/api/protocols', { name, protocolType: 'hand' })).json;
    ids[key] = p.id;
    await h.doctor.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects: [dot({ id: `obj-${key}` })] }] });
    if (shortDescription) assert.equal((await h.doctor.put(`/api/protocols/${p.id}/details`, { shortDescription })).status, 200);
    for (const term of terms) assert.equal((await h.doctor.post(`/api/protocols/${p.id}/search-terms`, { term })).status, 201);
    for (const cid of conditionIds) assert.equal((await h.doctor.post(`/api/protocols/${p.id}/conditions`, { conditionId: cid })).status, 201);
    if (publish) assert.equal((await h.doctor.post(`/api/protocols/${p.id}/publish`, {})).status, 201);
    return p;
  }

  before(async () => {
    h = await bootstrap();
    const cond = async (name, synonyms = []) => (await h.admin.post(`${A}/conditions`, { name, synonyms })).json;
    conds = {
      back: await cond('Back Pain', ['lower back pain', 'lumbar pain', 'back ache', 'back stiffness']),
      neck: await cond('Neck Pain'),
      shoulder: await cond('Shoulder Pain'),
      elbow: await cond('Elbow Pain'),
      hip: await cond('Hip Pain'),
    };
    await makeProtocol('back', { name: 'Back Pain', shortDescription: 'A gentle routine for the back.', terms: ['pain after sitting', 'lower back discomfort', 'stiff lower back'], conditionIds: [conds.back.id] });
    await makeProtocol('neck', { name: 'Neck Pain', conditionIds: [conds.neck.id] });
    await makeProtocol('shoulder', { name: 'Shoulder Pain', conditionIds: [conds.shoulder.id] });
    await makeProtocol('elbow', { name: 'Elbow Pain', terms: ['tennis elbow'], conditionIds: [conds.elbow.id], publish: false }); // a draft
    const hip = await makeProtocol('hip', { name: 'Hip Pain', terms: ['hip ache'], conditionIds: [conds.hip.id] });
    assert.equal((await h.admin.post(`${A}/protocols/${hip.id}/archive`, {})).status, 200);
    const { createFeatureFlagService } = require('../src/services/featureFlags'); // eslint-disable-line global-require
    await createFeatureFlagService(h.db).setFlag('AI_ASSESSMENT', true);
  });
  after(async () => { if (h) await h.stop(); });

  it('the three natural-language examples find Back Pain', async () => {
    for (const m of ['my lower back hurts', 'I have discomfort around my lumbar area', 'pain after sitting for long hours']) {
      const r = await ask(m);
      assert.equal(r.status, 200);
      assert.equal(r.json.status, 'match', m);
      assert.equal(slugOf(r), 'back-pain', m);
      assert.deepEqual(Object.keys(r.json).sort(), ['actions', 'disclaimer', 'message', 'protocol', 'status']);
    }
  });
  it('conditions, synonyms and search terms each work', async () => {
    assert.equal(slugOf(await ask('Back Pain')), 'back-pain');
    assert.equal(slugOf(await ask('lumbar pain')), 'back-pain');
    assert.equal(slugOf(await ask('back ache')), 'back-pain');
    assert.equal(slugOf(await ask('stiff lower back')), 'back-pain');
    assert.equal(slugOf(await ask('my neck hurts')), 'neck-pain');
  });
  it('"I have pain." asks one question; "lower back" then gives the best published match', async () => {
    const first = await ask('I have pain.');
    assert.deepEqual(first.json, { status: 'clarification', question: 'Which part of the body, or what concern, would you like to find a protocol for?', disclaimer: first.json.disclaimer });
    assert.equal(slugOf(await ask('I have pain.', 'lower back')), 'back-pain');
    assert.equal(slugOf(await ask('I have pain.', 'my shoulder')), 'shoulder-pain');
    assert.equal((await ask('I have pain.', 'not sure')).json.status, 'no_match', 'never a second question');
  });
  it('"rocket engines" is a clean no-match', async () => {
    const r = await ask('rocket engines');
    assert.deepEqual(r.json, { status: 'no_match', message: r.json.message, disclaimer: r.json.disclaimer });
  });
  it('a draft and an archived protocol are never returned, by name, search term or condition', async () => {
    for (const m of ['Elbow Pain', 'I want the Elbow Pain protocol', 'tennis elbow', 'my elbow hurts', 'Hip Pain', 'hip ache', 'my hip hurts']) {
      const r = await ask(m);
      assert.notEqual(r.json.status, 'match', m);
      assert.doesNotMatch(r.text, /elbow-pain|hip-pain|Elbow Pain|Hip Pain/);
    }
    for (const a of ['my elbow', 'my hip']) assert.notEqual((await ask('I have pain.', a)).json.status, 'match', a);
  });
  it('a synonym an administrator adds is used straight away; one on an archived condition is not', async () => {
    assert.notEqual(slugOf(await ask('tailbone soreness')), 'back-pain');
    assert.equal((await h.admin.put(`${A}/conditions/${conds.back.id}`, { synonyms: ['lower back pain', 'lumbar pain', 'back ache', 'back stiffness', 'tailbone soreness'] })).status, 200);
    assert.equal(slugOf(await ask('tailbone soreness')), 'back-pain');
    assert.equal((await h.admin.post(`${A}/conditions/${conds.back.id}/deactivate`, {})).status, 200);
    assert.notEqual(slugOf(await ask('tailbone soreness')), 'back-pain', 'an archived condition no longer contributes synonyms');
    assert.equal((await h.admin.post(`${A}/conditions/${conds.back.id}/activate`, {})).status, 200);
    assert.equal(slugOf(await ask('tailbone soreness')), 'back-pain');
  });
  it('a search term a doctor adds appears only once published', async () => {
    assert.equal((await h.doctor.post(`/api/protocols/${ids.neck}/search-terms`, { term: 'desk hunch' })).status, 201);
    assert.notEqual(slugOf(await ask('desk hunch')), 'neck-pain', 'draft change is invisible');
    assert.equal((await h.doctor.post(`/api/protocols/${ids.neck}/publish`, {})).status, 201);
    assert.equal(slugOf(await ask('desk hunch')), 'neck-pain');
  });
  it('the matched protocol opens on the existing public page, and nothing else about it leaks', async () => {
    const r = await ask('my lower back hurts');
    assert.equal((await h.anon.get(`/api/public/protocols/${r.json.protocol.slug}`)).status, 200);
    assert.doesNotMatch(r.text, /"id"|owner|doctor|draft|version|score|tier/i);
  });
});
