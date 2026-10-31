/**
 * [DETERMINISTIC SOFTWARE TESTS — HTTP level, real server.js + real PostgreSQL]
 * The AI Protocol Assistant (Stage 1 behaviour, Stage 2 response contract) end to end: POST /api/public/ai/protocol-assistant and GET /api/public/ai/status.
 *
 * Covers: the AI_ASSESSMENT flag (off by default), exact / name / search-term / condition / synonym / natural-language
 * matching against PUBLISHED protocols, that drafts / in-review / archived protocols are never returned, that only the
 * published snapshot is ever used, no-match, input validation, provider failure, that nothing the person wrote is stored
 * or logged, safe wording, and that the existing public site and doctor workflow are untouched.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { HTTP_SKIP, startServer, bootstrap, dot } = require('./helpers/httpHarness');
const { TEXT, FORBIDDEN_WORDING } = require('../src/ai/constants');
const { STATUS: ST } = require('../src/ai/responseContract');

const ASK = '/api/public/ai/protocol-assistant';
const STATUS = '/api/public/ai/status';
const A = '/api/admin';

describe('[DETERMINISTIC · HTTP] AI Protocol Assistant', { skip: HTTP_SKIP }, () => {
  let h; const ids = {}; // protocol ids by key

  // ----------------------------------------------------------------------------------------------- helpers
  const setFlag = async (key, enabled) => {
    const { createFeatureFlagService } = require('../src/services/featureFlags'); // eslint-disable-line global-require
    await createFeatureFlagService(h.db).setFlag(key, enabled);
  };
  const ask = (message, extra) => h.anon.post(ASK, { message, ...extra });
  const slugOf = (r) => (r.json && r.json.protocol ? r.json.protocol.slug : null);
  const DISABLED = { status: 'disabled' };
  const spoken = (json) => {
    const out = [];
    const walk = (v) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk({ message: json.message, question: json.question, actions: json.actions });
    return out;
  };
  const publicTables = async () => (await h.rows("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).map((r) => r.name);
  const tableCounts = async () => {
    const out = {};
    for (const name of await publicTables()) out[name] = (await h.row(`SELECT COUNT(*)::integer AS c FROM "${name}"`)).c;
    return out;
  };
  /** Every row of every table, rendered as text, searched for `needle` (the PostgreSQL equivalent of scanning the SQLite file). */
  const databaseContains = async (needle) => {
    for (const name of await publicTables()) {
      if ((await h.row(`SELECT COUNT(*)::integer AS c FROM "${name}" t WHERE strpos(t::text, $1) > 0`, needle)).c > 0) return name;
    }
    return null;
  };

  /** A doctor creates a protocol with markings, details, search terms and conditions; optionally publishes. */
  async function makeProtocol(key, { name, shortDescription, categoryId, terms = [], conditionIds = [], publish = true }) {
    const p = (await h.doctor.post('/api/protocols', { name, protocolType: 'hand' })).json;
    ids[key] = p.id;
    await h.doctor.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects: [dot({ id: `obj-${key}-${p.slug}` })] }] });
    const details = {}; if (shortDescription) details.shortDescription = shortDescription; if (categoryId) details.categoryId = categoryId;
    if (Object.keys(details).length) assert.equal((await h.doctor.put(`/api/protocols/${p.id}/details`, details)).status, 200);
    for (const term of terms) assert.equal((await h.doctor.post(`/api/protocols/${p.id}/search-terms`, { term })).status, 201);
    for (const cid of conditionIds) assert.equal((await h.doctor.post(`/api/protocols/${p.id}/conditions`, { conditionId: cid })).status, 201);
    if (publish) assert.equal((await h.doctor.post(`/api/protocols/${p.id}/publish`, {})).status, 201);
    return p;
  }

  before(async () => {
    h = await bootstrap();
    const cat = (await h.admin.post(`${A}/categories`, { name: 'Musculoskeletal' })).json;
    const cond = async (name, synonyms = []) => (await h.admin.post(`${A}/conditions`, { name, synonyms })).json;
    const backPain = await cond('Back pain', ['lower back stiffness', 'lumbago']);
    const kneePain = await cond('Knee pain');
    const migraine = await cond('Migraine', ['sick headache']);
    const wrist = await cond('Wrist tension');

    await makeProtocol('back', { name: 'Back Pain', shortDescription: 'A gentle routine for the lower back.', categoryId: cat.id, terms: ['sore back'], conditionIds: [backPain.id] });
    await makeProtocol('knee', { name: 'Knee Pain', shortDescription: 'Support for sore knees.', terms: ['knee ache'], conditionIds: [kneePain.id] });
    await makeProtocol('migraine', { name: 'Migraine Relief', terms: ['headache'], conditionIds: [migraine.id] });
    await makeProtocol('calm', { name: 'Calm Evening', terms: ['night calm'] });
    await makeProtocol('wristA', { name: 'Wrist Tension Relief', conditionIds: [wrist.id] });
    await makeProtocol('wristB', { name: 'Wrist Tension for Typists', conditionIds: [wrist.id] });

    // never public: a draft, one in review, and one published and then archived
    await makeProtocol('hipDraft', { name: 'Hip Mobility Draft', terms: ['hip pain'], publish: false });
    const review = await makeProtocol('neckReview', { name: 'Neck Review Protocol', terms: ['neck review thing'], publish: false });
    assert.equal((await h.admin.post(`${A}/protocols/${review.id}/status`, { status: 'in_review' })).status, 200);
    const shoulder = await makeProtocol('shoulder', { name: 'Shoulder Archived', terms: ['shoulder strain'] });
    assert.equal((await h.admin.post(`${A}/protocols/${shoulder.id}/archive`, {})).status, 200);
  });
  after(async () => { if (h) await h.stop(); });

  // =============================================================================================== 1. feature flag
  describe('the AI_ASSESSMENT feature flag (OFF by default)', () => {
    it('is OFF in a fresh database: both the stored flag and the code default', async () => {
      const { FLAG_DEFINITIONS } = require('../src/services/featureFlagDefinitions'); // eslint-disable-line global-require
      assert.equal(FLAG_DEFINITIONS.AI_ASSESSMENT.default, false);
      assert.equal((await h.row("SELECT enabled FROM feature_flags WHERE key = 'AI_ASSESSMENT'")).enabled, 0);
    });
    it('OFF: the assistant answers exactly { status: "disabled" } whatever is sent — it does not even read the request', async () => {
      for (const body of [{ message: 'I want the Back Pain protocol' }, {}, { message: '' }, { message: 123 }, undefined]) {
        const r = await h.anon.post(ASK, body);
        assert.equal(r.status, 200, JSON.stringify(body));
        assert.deepEqual(r.json, DISABLED);
      }
      assert.equal((await h.anon.get(ASK)).status, 404, 'only POST exists');
    });
    it('OFF: the status endpoint says so (and reveals nothing else)', async () => {
      const r = await h.anon.get(STATUS);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { enabled: false });
    });
    it('OFF: the existing public website works exactly as before', async () => {
      const list = await h.anon.get('/api/public/protocols');
      assert.equal(list.status, 200);
      assert.ok(list.json.items.some((p) => p.slug === 'back-pain'));
      assert.equal((await h.anon.get('/api/public/protocols/back-pain')).status, 200);
      assert.equal((await h.anon.get('/api/public/protocols/back-pain/render')).status, 200);
      assert.ok((await h.anon.get('/api/public/categories')).json.some((c) => c.name === 'Musculoskeletal'));
    });
    it('enabling it turns the assistant on; no other flag is touched', async () => {
      const before = await h.rows('SELECT key, enabled FROM feature_flags ORDER BY key COLLATE "C"');
      await setFlag('AI_ASSESSMENT', true);
      const after_ = await h.rows('SELECT key, enabled FROM feature_flags ORDER BY key COLLATE "C"');
      const changed = after_.filter((row, i) => row.enabled !== before[i].enabled).map((row) => row.key);
      assert.deepEqual(changed, ['AI_ASSESSMENT']);
      assert.deepEqual((await h.anon.get(STATUS)).json, { enabled: true });
      assert.equal((await ask('I want the Back Pain protocol')).json.status, ST.MATCH);
    });
    it('it also needs the public website and the protocol browser (it only recommends pages those serve)', async () => {
      for (const key of ['WEBSITE', 'PROTOCOL_BROWSER']) {
        await setFlag(key, false);
        try {
          assert.deepEqual((await ask('I want the Back Pain protocol')).json, DISABLED, `${key} off`);
          assert.deepEqual((await h.anon.get(STATUS)).json, { enabled: false }, `${key} off`);
        } finally { await setFlag(key, true); }
      }
      assert.deepEqual((await h.anon.get(STATUS)).json, { enabled: true });
    });
    it('turning it OFF again switches it off immediately', async () => {
      await setFlag('AI_ASSESSMENT', false);
      assert.deepEqual((await ask('I want the Back Pain protocol')).json, DISABLED);
      await setFlag('AI_ASSESSMENT', true);
      assert.equal((await ask('I want the Back Pain protocol')).json.status, ST.MATCH);
    });
  });

  // ============================================================================================== 2. matching
  describe('finding the right published protocol', () => {
    it('EXACT protocol request: "I want the Back Pain protocol"', async () => {
      const r = await ask('I want the Back Pain protocol');
      assert.equal(r.status, 200);
      assert.equal(r.json.status, ST.MATCH);
      assert.equal(slugOf(r), 'back-pain');
      assert.equal(r.json.message, TEXT.REASON_DIRECT);
    });
    it('protocol NAME matching: case, punctuation, the word "protocol", the name alone', async () => {
      for (const m of ['Back Pain', 'back pain', 'BACK-PAIN!!', 'the back pain protocol', 'show me the Knee Pain protocol', 'Migraine Relief', 'I want the Calm Evening protocol']) {
        const r = await ask(m);
        assert.equal(r.json.status, ST.MATCH, m);
      }
      assert.equal(slugOf(await ask('BACK-PAIN!!')), 'back-pain');
      assert.equal(slugOf(await ask('show me the Knee Pain protocol')), 'knee-pain');
      assert.equal(slugOf(await ask('Migraine Relief')), 'migraine-relief');
      assert.equal(slugOf(await ask('I want the Calm Evening protocol')), 'calm-evening');
    });
    it('SEARCH-TERM matching', async () => {
      assert.equal(slugOf(await ask('sore back')), 'back-pain');
      assert.equal(slugOf(await ask('I have a knee ache')), 'knee-pain');
      assert.equal(slugOf(await ask('I want something for night calm')), 'calm-evening');
      assert.equal(slugOf(await ask('I get a headache every afternoon')), 'migraine-relief');
    });
    it('CONDITION matching', async () => {
      assert.equal(slugOf(await ask('I suffer from migraines')), 'migraine-relief');
      assert.equal(slugOf(await ask('Do you have something for knee pain?')), 'knee-pain');
    });
    it('SYNONYM matching (admin-recorded condition synonyms)', async () => {
      const r = await ask('lumbago');
      assert.equal(slugOf(r), 'back-pain');
      assert.equal(slugOf(await ask('I have lower back stiffness')), 'back-pain');
      assert.equal(slugOf(await ask('I have a sick headache')), 'migraine-relief');
    });
    it('NATURAL-LANGUAGE concerns — the three situations from the product spec', async () => {
      const general = await ask('Do you have something for back stiffness?');
      assert.equal(slugOf(general), 'back-pain');
      assert.equal(general.json.message, TEXT.REASON_RELEVANT);

      const stiff = await ask('I have lower back stiffness. Which protocol would be relevant?');
      assert.equal(slugOf(stiff), 'back-pain');

      const guided = await ask("I have been having discomfort around my lower back and I don't know which protocol I should use.");
      assert.equal(guided.json.status, ST.MATCH);
      assert.equal(slugOf(guided), 'back-pain');
      assert.equal(guided.json.message, TEXT.REASON_RELEVANT);
    });
    it('a PUBLISHED protocol is returned with its public fields, and it opens on the existing public page and PDF source', async () => {
      const r = await ask('I want the Back Pain protocol');
      const rec = r.json.protocol;
      assert.deepEqual(rec, { slug: 'back-pain', name: 'Back Pain', description: 'A gentle routine for the lower back.' });
      assert.deepEqual(r.json.actions, [{ type: 'view_protocol', label: 'View Protocol' }, { type: 'download_pdf', label: 'Download PDF' }, { type: 'copy_link', label: 'Copy Link' }]);
      assert.equal((await h.anon.get(`/api/public/protocols/${rec.slug}`)).status, 200, 'the existing public protocol page data');
      assert.equal((await h.anon.get(`/api/public/protocols/${rec.slug}/render`)).status, 200, 'the existing PDF/share source');
    });
    it('the response never contains internal ids, scores, ranks, runner-ups or unpublished data', async () => {
      const r = await ask('I want the Back Pain protocol');
      assert.deepEqual(Object.keys(r.json).sort(), ['actions', 'disclaimer', 'message', 'protocol', 'status']);
      assert.doesNotMatch(r.text, /score|rank|candidate|evidence|weight|owner|doctor|patient|"id"|protocolId|versionId/i);
      assert.ok(!r.text.includes(ids.back), 'the internal protocol id is not exposed');
    });
    it('NO MATCH: unrelated requests, unknown protocols and conditions that no published protocol covers', async () => {
      for (const m of ['tell me a joke', 'what is the weather today', 'I have a toothache', 'I want the Knee Replacement protocol', 'I want the Diabetes protocol', 'asdf qwerty zxcv', 'knee replacement surgery recovery plan', 'back surgery recovery exercises']) {
        const r = await ask(m);
        assert.equal(r.status, 200, m);
        assert.deepEqual(r.json, { status: ST.NO_MATCH, message: TEXT.NO_MATCH, disclaimer: TEXT.DISCLAIMER }, m);
      }
    });
  });

  // ===================================================================================== 3. only published data
  describe('only PUBLISHED protocols can ever be returned', () => {
    const unpublishedAsks = [
      ['draft, by name', 'I want the Hip Mobility Draft protocol'], ['draft, by search term', 'hip pain'], ['draft, by bare name', 'Hip Mobility Draft'],
      ['in review, by name', 'I want the Neck Review Protocol'], ['in review, by search term', 'neck review thing'],
      ['archived, by name', 'I want the Shoulder Archived protocol'], ['archived, by search term', 'shoulder strain'],
    ];
    for (const [label, message] of unpublishedAsks) {
      it(`a ${label} is never returned`, async () => {
        const r = await ask(message);
        assert.equal(r.status, 200);
        assert.notEqual(r.json.status, ST.MATCH);
        assert.equal(r.json.protocol, undefined);
        assert.doesNotMatch(r.text, /hip-mobility|neck-review|shoulder-archived|Hip Mobility|Neck Review|Shoulder Archived/);
      });
    }
    it('asking for an unpublished protocol looks exactly like asking for one that does not exist (nothing can be probed)', async () => {
      const real = await ask('I want the Hip Mobility Draft protocol');
      const fake = await ask('I want the Zebra Wizardry Tonic protocol');
      assert.deepEqual(real.json, fake.json);
    });
    it('a protocol that is archived disappears from the assistant on the very next request', async () => {
      const p = await makeProtocol('temp', { name: 'Temporary Test Protocol', terms: ['temp test thing'] });
      assert.equal(slugOf(await ask('I want the Temporary Test Protocol protocol')), 'temporary-test-protocol');
      assert.equal((await h.admin.post(`${A}/protocols/${p.id}/archive`, {})).status, 200);
      assert.equal((await ask('I want the Temporary Test Protocol protocol')).json.status, ST.NO_MATCH);
    });
    it('only the PUBLISHED snapshot is used: draft edits made after publishing are invisible until the doctor publishes again', async () => {
      assert.equal(slugOf(await ask('night calm')), 'calm-evening');
      // the doctor now edits the draft: renames it and adds a search term — NOT published
      assert.equal((await h.doctor.put(`/api/protocols/${ids.calm}/details`, { name: 'Renamed Draft Name' })).status, 200);
      assert.equal((await h.doctor.post(`/api/protocols/${ids.calm}/search-terms`, { term: 'zebra stripes' })).status, 201);
      assert.equal((await h.doctor.get(`/api/protocols/${ids.calm}/details`)).json.hasUnpublishedChanges, true);
      assert.equal(slugOf(await ask('night calm')), 'calm-evening', 'the published search term still works');
      assert.equal(slugOf(await ask('I want the Calm Evening protocol')), 'calm-evening', 'the published name still works');
      assert.notEqual((await ask('zebra stripes')).json.status, ST.MATCH, 'the draft-only term is invisible');
      assert.notEqual((await ask('I want the Renamed Draft Name protocol')).json.status, ST.MATCH, 'the draft-only name is invisible');
      // publish again: now the new version is the one that counts
      assert.equal((await h.doctor.post(`/api/protocols/${ids.calm}/publish`, {})).status, 201);
      assert.equal(slugOf(await ask('zebra stripes')), 'calm-evening');
    });
  });

  // ===================================================================================== 4. follow-up question
  describe('at most one clarifying question', () => {
    it('a vague request gets ONE question; answering it resolves; a second vague answer is not asked again', async () => {
      const first = await ask('I have some discomfort');
      assert.equal(first.json.status, ST.CLARIFICATION);
      assert.equal(first.json.question, TEXT.FOLLOW_UP_VAGUE);
      assert.equal(first.json.protocol, undefined);
      const answered = await ask('I have some discomfort', { followUpAnswer: 'it is my lower back' });
      assert.equal(answered.json.status, ST.MATCH);
      assert.equal(slugOf(answered), 'back-pain');
      const again = await ask('I have some discomfort', { followUpAnswer: 'not really sure' });
      assert.equal(again.json.status, ST.NO_MATCH);
    });
    it('when two published protocols fit equally, it asks once and uses the answer to choose', async () => {
      const first = await ask('I have wrist tension');
      assert.equal(first.json.status, ST.CLARIFICATION);
      assert.equal(first.json.question, TEXT.FOLLOW_UP_AMBIGUOUS);
      const chosen = await ask('I have wrist tension', { followUpAnswer: 'I spend all day typing, I am a typist' });
      assert.equal(chosen.json.status, ST.MATCH);
      assert.equal(slugOf(chosen), 'wrist-tension-for-typists');
    });
  });

  // ==================================================================================== 5. input validation
  describe('input validation', () => {
    it('empty, blank, missing and non-text messages are refused with 400 and a fixed message', async () => {
      for (const body of [{}, { message: '' }, { message: '   \n\t ' }, { message: null }, { message: 42 }, { message: ['back pain'] }, { message: { text: 'back pain' } }, { message: true }]) {
        const r = await h.anon.post(ASK, body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.json.error, TEXT.INVALID_INPUT);
        assert.equal(r.json.code, 'INVALID_INPUT');
      }
    });
    it('a body that is not an object is refused (array, text)', async () => {
      assert.equal((await h.anon.post(ASK, ['back pain'])).status, 400);
      const text = await fetch(h.base + ASK, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'I want the Back Pain protocol' });
      assert.equal(text.status, 400, 'text/plain is not read as a message');
      const noBody = await fetch(h.base + ASK, { method: 'POST' });
      assert.equal(noBody.status, 400);
    });
    it('500 characters are accepted, 501 are refused; control characters and extra spaces are cleaned', async () => {
      assert.equal((await ask(`back pain ${'x'.repeat(490)}`)).status, 200);
      assert.equal((await ask('b'.repeat(500))).status, 200);
      const tooLong = await ask('b'.repeat(501));
      assert.equal(tooLong.status, 400);
      assert.equal(tooLong.json.error, TEXT.INVALID_INPUT);
      assert.equal(slugOf(await ask('I\u0000 want\u0007   the \n Back   Pain\t protocol')), 'back-pain');
    });
    it('a follow-up answer longer than 300 characters or not text is refused', async () => {
      assert.equal((await ask('I have some discomfort', { followUpAnswer: 'a'.repeat(301) })).status, 400);
      assert.equal((await ask('I have some discomfort', { followUpAnswer: 12 })).status, 400);
      assert.equal((await ask('I have some discomfort', { followUpAnswer: 'a'.repeat(300) })).status, 200);
    });
    it('error responses never contain what the person typed', async () => {
      const token = `private-${crypto.randomBytes(6).toString('hex')}`;
      const r = await ask(`${token} ${'x'.repeat(600)}`);
      assert.equal(r.status, 400);
      assert.ok(!r.text.includes(token));
    });
    it('the message is read ONLY from the POST body: a query string is ignored', async () => {
      const r = await fetch(`${h.base}${ASK}?message=${encodeURIComponent('I want the Back Pain protocol')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 400);
    });
    it('other methods do not exist', async () => {
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) assert.equal((await h.anon.request(method, ASK, method === 'GET' || method === 'DELETE' ? undefined : { message: 'x' })).status, 404, method);
    });
  });

  // ================================================================================ 6. provider failure (real server)
  describe('when the AI provider fails', () => {
    it('an unavailable provider gives a fixed 503; the rest of the site keeps working; nothing the person typed is in the log or the response', async () => {
      const token = `ZQX-private-${crypto.randomBytes(5).toString('hex')}`;
      const broken = await startServer({ ...h.t.env, AI_PROVIDER: 'openai' }); // not available in Stage 1 -> provider cannot be created
      try {
        const post = await fetch(`${broken.base}${ASK}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `lower back ${token}` }) });
        const text = await post.text();
        assert.equal(post.status, 503);
        assert.equal(JSON.parse(text).error, TEXT.UNAVAILABLE);
        assert.ok(!text.includes(token));
        assert.ok(!broken.logs.join('').includes(token), 'not in the server log');
        assert.match(broken.logs.join(''), /\[ai\] provider "unavailable" failed/);
        // the server is alive and every other public page still works
        assert.equal((await fetch(`${broken.base}/api/health`)).status, 200);
        assert.equal((await fetch(`${broken.base}/api/public/protocols/back-pain`)).status, 200);
        assert.deepEqual(await (await fetch(`${broken.base}${STATUS}`)).json(), { enabled: true });
        // and it recovers by itself: a later request still gets the same clean answer, not a crash
        assert.equal((await fetch(`${broken.base}${ASK}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'back pain' }) })).status, 503);
      } finally { await broken.stop(); }
    });
    it('a mistyped AI_PROVIDER cannot stop the server starting', async () => {
      const s = await startServer({ ...h.t.env, AI_PROVIDER: 'definitely-not-a-provider' });
      try { assert.equal((await fetch(`${s.base}/api/health`)).status, 200); } finally { await s.stop(); }
    });
    it('the default provider (mock) needs no key and no network: no AI_PROVIDER, no AI_API_KEY set', async () => {
      const s = await startServer({ ...h.t.env, AI_PROVIDER: '', AI_API_KEY: '' });
      try {
        const r = await fetch(`${s.base}${ASK}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'I want the Back Pain protocol' }) });
        assert.equal(r.status, 200);
        assert.equal((await r.json()).protocol.slug, 'back-pain');
      } finally { await s.stop(); }
    });
  });

  // ======================================================================================== 7. privacy
  describe('nothing the person writes is stored or logged', () => {
    it('no database row is written: every table has the same number of rows before and after a run of requests', async () => {
      const before_ = await tableCounts();
      const token = `PRIVATE-${crypto.randomBytes(6).toString('hex')}`;
      for (const m of [`${token} back pain`, `I want the Back Pain protocol ${token}`, `tell me about ${token}`, token, 'I have some discomfort', `${token} `.repeat(40)]) await ask(m);
      await ask(`${token}`, { followUpAnswer: `${token} lower back` });
      await h.anon.post(ASK, { message: 123, extra: token });
      assert.deepEqual(await tableCounts(), before_);
    });
    it('the unique text is nowhere in the database afterwards (every column of every row of every table is searched)', async () => {
      const token = `NEEDLE-${crypto.randomBytes(8).toString('hex')}`;
      await ask(`${token} lower back stiffness`);
      await ask('I have some discomfort', { followUpAnswer: token });
      assert.equal(await databaseContains(token), null);
    });
    it('the unique text is nowhere in the server log — not for successes, validation errors, or malformed requests', async () => {
      const token = `NEEDLE-${crypto.randomBytes(8).toString('hex')}`;
      await ask(`${token} lower back stiffness`);
      await ask(`${token} ${'x'.repeat(600)}`);
      await ask('I have some discomfort', { followUpAnswer: token });
      await fetch(h.base + ASK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"message": ${token} oops` });
      await fetch(h.base + ASK, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: token });
      assert.equal(h.server.logs.join('').includes(token), false);
    });
    it('responses are marked no-store and set no cookies; the request is not authenticated and does not need to be', async () => {
      for (const r of [await fetch(h.base + STATUS), await fetch(h.base + ASK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'back pain' }) })]) {
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        assert.equal(r.headers.get('set-cookie'), null);
      }
    });
  });

  // ========================================================================================== 8. safe wording
  describe('safe wording', () => {
    const CORPUS = [
      'I want the Back Pain protocol', 'Do you have something for back stiffness?', 'lumbago', 'I suffer from migraines', 'I have wrist tension', 'I have some discomfort',
      "I have been having discomfort around my lower back and I don't know which protocol I should use.", 'tell me a joke', 'I want the Knee Replacement protocol',
      'I think I have cancer', 'am I diagnosed with arthritis', 'cure my migraine', 'what treatment do I need for back pain', 'chest pain and dizziness', 'I feel unwell', 'my knees ache',
    ];
    it('every answer carries the exact disclaimer', async () => {
      for (const m of CORPUS) assert.equal((await ask(m)).json.disclaimer, TEXT.DISCLAIMER, m);
    });
    it('nothing the assistant says (apart from protocol names/descriptions the doctor wrote) uses diagnosis or treatment wording', async () => {
      const authored = ['Back Pain', 'A gentle routine for the lower back.', 'Knee Pain', 'Support for sore knees.', 'Migraine Relief', 'Wrist Tension Relief', 'Wrist Tension for Typists'];
      for (const m of CORPUS) {
        for (const r of [await ask(m), await ask(m, { followUpAnswer: 'lower back' })]) {
          spoken(r.json).filter((s) => !authored.includes(s)).forEach((s) => FORBIDDEN_WORDING.forEach((re) => assert.ok(!re.test(s), `${JSON.stringify(m)} -> ${JSON.stringify(s)} trips ${re}`)));
        }
      }
    });
    it('recommendations use "may be relevant" wording', async () => {
      assert.match((await ask('Do you have something for back stiffness?')).json.message, /may be relevant/);
    });
  });

  // ===================================================================== 9. nothing else was disturbed
  describe('the existing public site and the doctor workflow are untouched', () => {
    it('the public APIs return the same data with the assistant ON as with it OFF', async () => {
      const read = async () => JSON.stringify([(await h.anon.get('/api/public/protocols')).json, (await h.anon.get('/api/public/categories')).json, (await h.anon.get('/api/public/protocols/back-pain')).json, (await h.anon.get('/api/public/protocols/back-pain/render')).json]);
      const on = await read();
      await setFlag('AI_ASSESSMENT', false);
      const off = await read();
      await setFlag('AI_ASSESSMENT', true);
      assert.equal(on, off);
    });
    it('the doctor workflow still works end to end, and the assistant follows what is published', async () => {
      const p = await makeProtocol('flow', { name: 'Doctor Flow Protocol', terms: ['flow thing xylophone'], publish: false });
      assert.equal((await ask('I want the Doctor Flow Protocol protocol')).json.status, ST.NO_MATCH, 'a draft is invisible');
      const v1 = await h.doctor.post(`/api/protocols/${p.id}/publish`, {});
      assert.equal(v1.status, 201, v1.text);
      assert.equal(slugOf(await ask('I want the Doctor Flow Protocol protocol')), 'doctor-flow-protocol');
      await h.doctor.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects: [dot({ id: 'second-object' })] }] });
      const v2 = await h.doctor.post(`/api/protocols/${p.id}/publish`, {});
      assert.equal(v2.status, 201);
      assert.ok(v2.json.version > v1.json.version, 'republishing still creates a newer version (numbers also count saved-draft checkpoints, so not necessarily +1)');
      assert.equal(slugOf(await ask('I want the Doctor Flow Protocol protocol')), 'doctor-flow-protocol');
    });
    it('authentication and ownership are unchanged: anonymous and patients stay out of the Studio, doctors stay out of admin', async () => {
      assert.equal((await h.anon.get('/api/protocols')).status, 401);
      assert.equal((await h.patient.get('/api/protocols')).status, 403);
      assert.equal((await h.doctor.get(`${A}/conditions`)).status, 403);
      assert.equal((await h.doctor.get('/api/auth/me')).json.role, 'doctor');
    });
    it('the assistant itself needs no login: a signed-in doctor, a patient and an anonymous visitor get the same answer', async () => {
      const [a, d, p] = await Promise.all([h.anon, h.doctor, h.patient].map((c) => c.post(ASK, { message: 'I want the Back Pain protocol' })));
      assert.deepEqual([a.json, d.json], [p.json, p.json]);
      assert.equal(a.status, 200);
    });
  });
});
