/**
 * [DETERMINISTIC SOFTWARE TESTS] the AI provider layer and the assistant service (src/ai/providers/*, assistantService.js).
 * The service is exercised with a stubbed published catalogue and fake providers — including hostile and failing ones —
 * so every decision it makes is checked without a database or network.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AIProvider, MockProvider, createProvider } = require('../src/ai/providers');
const { INTENTS, OUTCOMES, LIMITS, TEXT, FORBIDDEN_WORDING } = require('../src/ai/constants');
const { createAssistantService, validateInput, sanitizeFollowUp, normalizeAnalysis } = require('../src/ai/assistantService');
const { HttpError } = require('../src/utils/errors');

const SRC = path.join(__dirname, '..', 'src');
const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const aiFiles = () => {
  const out = [];
  (function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) out.push(p); }); }(path.join(SRC, 'ai')));
  out.push(path.join(SRC, 'routes', 'public.ai.routes.js'));
  return out;
};

// ---------------------------------------------------------------------------------------------- fixtures
const detail = (o) => ({
  slug: 'x', name: 'X', displayName: 'X', shortDescription: '', description: '', protocolType: 'hand', category: null, conditions: [], searchTerms: [], metadata: {}, version: { number: 1 }, views: [], links: {}, ...o,
});
const FIXTURE = [
  detail({ slug: 'back-pain', name: 'Back Pain — Website Test Protocol', displayName: 'Back Pain', shortDescription: 'A gentle routine for the lower back.', category: { slug: 'msk', name: 'Musculoskeletal' }, conditions: [{ slug: 'back-pain', name: 'Back pain' }], searchTerms: ['backache', 'sore back'] }),
  detail({ slug: 'knee-pain', name: 'Knee Pain', displayName: 'Knee Pain', shortDescription: 'Support for sore knees.', conditions: [{ slug: 'knee-pain', name: 'Knee pain' }], searchTerms: ['knee ache'] }),
  detail({ slug: 'migraine-relief', name: 'Migraine Relief', displayName: 'Migraine Relief', shortDescription: 'For recurring headaches.', conditions: [{ slug: 'migraine', name: 'Migraine' }], searchTerms: ['headache'] }),
  detail({ slug: 'neck-shoulder', name: 'Neck and Shoulder Tension', displayName: 'Neck and Shoulder Tension', conditions: [{ slug: 'neck-tension', name: 'Neck tension' }] }),
];
const SYNONYMS = { 'back-pain': ['lower back stiffness', 'lumbago'], migraine: ['sick headache'] };

/** An assistant over a stubbed catalogue. `published` can be changed during a test to simulate (un)publishing. */
function build({ published = FIXTURE, provider = new MockProvider(), timeoutMs, getProvider } = {}) {
  const state = { published: [...published] };
  const logs = [];
  const fakeDb = { query: async (sql, [slug]) => ({ rows: [(SYNONYMS[slug] ? { is_active: 1, synonyms_json: JSON.stringify(SYNONYMS[slug]) } : undefined)].filter(Boolean) }) };
  const publicProtocols = {
    listForMatching: () => state.published,
    getDetail: (slug) => state.published.find((d) => d.slug === slug) || null,
  };
  const svc = createAssistantService({ publicProtocols, db: fakeDb, getProvider: getProvider || (() => provider), logger: { warn: (m) => logs.push(String(m)) }, timeoutMs });
  const ask = (message, followUpAnswer) => svc.handle(validateInput({ message, followUpAnswer }));
  return { svc, ask, state, logs };
}
const fakeProvider = (impl, name = 'fake') => ({ name, analyzeUserRequest: impl });
const allStrings = (value, acc = []) => {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, acc));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { acc.push(k); allStrings(v, acc); });
  return acc;
};

// =================================================================================================== providers
describe('[DETERMINISTIC] the development (mock) provider', () => {
  const vocabulary = { protocolNames: ['Back Pain', 'Knee Pain'], conditionNames: ['Back pain', 'Migraine'], searchPhrases: ['lumbago', 'lower back stiffness'] };
  const provider = new MockProvider();
  const intentOf = async (message) => (await provider.analyzeUserRequest({ message, vocabulary })).intent;

  it('recognises a DIRECT protocol request', async () => {
    for (const m of ['I want the Back Pain protocol', 'Back Pain', 'the back pain protocol', 'show me the Knee Pain protocol', 'Do you have the Back Pain protocol?', 'I want the Knee Replacement protocol']) {
      assert.equal(await intentOf(m), INTENTS.DIRECT_PROTOCOL_REQUEST, m);
    }
  });
  it('recognises a GENERAL concern search', async () => {
    for (const m of ['Do you have something for back stiffness?', 'I have lower back stiffness. Which protocol would be relevant?', 'I need something for back pain', 'is there anything for migraines', 'my knees ache']) {
      assert.equal(await intentOf(m), INTENTS.GENERAL_PROTOCOL_SEARCH, m);
    }
  });
  it('recognises a GUIDED request (the person says they are unsure)', async () => {
    for (const m of ["I have been having discomfort around my lower back and I don't know which protocol I should use.", "I have pain in my lower back but I'm not sure which protocol I need.", 'no idea what to pick, help me choose']) {
      assert.equal(await intentOf(m), INTENTS.GUIDED_REQUEST, m);
    }
  });
  it('says UNKNOWN for anything unrelated to the protocols or to how someone feels', async () => {
    for (const m of ['what is the weather today', 'tell me a joke', 'I want a pizza', 'who won the match', '']) assert.equal(await intentOf(m), INTENTS.UNKNOWN, JSON.stringify(m));
  });
  it('reports how specific the request is: a vague one has no specific terms', async () => {
    const sig = async (message) => (await provider.analyzeUserRequest({ message, vocabulary })).signals;
    assert.equal((await sig('I have some discomfort')).isVague, true);
    assert.equal((await sig('I feel unwell')).isVague, true);
    assert.equal((await sig('lower back stiffness')).isVague, false);
  });
  it('its optional clarifying question is safe, short and a question', async () => {
    for (const message of ['I have some discomfort', 'lower back stiffness']) {
      const { followUp } = await provider.analyzeUserRequest({ message, vocabulary });
      assert.ok(sanitizeFollowUp(followUp), `${message} -> ${followUp}`);
    }
  });
  it('never returns ids or protocol choices — only intent, signals and a question', async () => {
    const out = await provider.analyzeUserRequest({ message: 'I want the Back Pain protocol', vocabulary });
    assert.deepEqual(Object.keys(out).sort(), ['followUp', 'intent', 'signals']);
    assert.deepEqual(Object.keys(out.signals).sort(), ['isVague', 'searchPhrases']);
  });
  it('is deterministic: the same input always gives the same answer', async () => {
    const a = await provider.analyzeUserRequest({ message: 'I have lower back stiffness', vocabulary });
    const b = await provider.analyzeUserRequest({ message: 'I have lower back stiffness', vocabulary });
    assert.deepEqual(a, b);
  });
  it('works with no vocabulary at all', async () => {
    assert.equal((await provider.analyzeUserRequest({ message: 'my back hurts' })).intent, INTENTS.GENERAL_PROTOCOL_SEARCH);
  });
});

describe('[DETERMINISTIC] the provider interface and factory', () => {
  it('the base class defines analyzeUserRequest / determineIntent / extractSignals / suggestFollowUp, and an unimplemented method fails loudly', async () => {
    const p = new AIProvider();
    for (const m of ['determineIntent', 'extractSignals', 'suggestFollowUp']) await assert.rejects(() => p[m]({}), /not implemented/);
    assert.equal(typeof p.analyzeUserRequest, 'function');
  });
  it('the default analyzeUserRequest composes the three smaller methods in order, passing earlier results on', async () => {
    const calls = [];
    class Spy extends AIProvider {
      async determineIntent() { calls.push('intent'); return { intent: INTENTS.GENERAL_PROTOCOL_SEARCH }; }
      async extractSignals(i) { calls.push(`signals(intent=${i.intent})`); return { isVague: false }; }
      async suggestFollowUp(i) { calls.push(`followUp(isVague=${i.signals.isVague})`); return null; }
    }
    const out = await new Spy().analyzeUserRequest({ message: 'x' });
    assert.deepEqual(calls, ['intent', 'signals(intent=GENERAL_PROTOCOL_SEARCH)', 'followUp(isVague=false)']);
    assert.deepEqual(out, { intent: INTENTS.GENERAL_PROTOCOL_SEARCH, signals: { isVague: false }, followUp: null });
  });
  it('a real provider can be plugged in by overriding analyzeUserRequest alone', async () => {
    class OneCall extends AIProvider { async analyzeUserRequest() { return { intent: INTENTS.UNKNOWN, signals: { isVague: true }, followUp: null }; } }
    const { ask } = build({ provider: new OneCall() });
    assert.equal((await ask('anything')).outcome, OUTCOMES.NO_MATCH);
  });
  it('the factory defaults to the mock provider, which needs no key; the name is case/space-insensitive', () => {
    assert.ok(createProvider({}) instanceof MockProvider);
    assert.ok(createProvider({ AI_PROVIDER: ' MOCK ' }) instanceof MockProvider);
    assert.ok(createProvider({ AI_PROVIDER: '' }) instanceof MockProvider);
  });
  it('asking for a provider that is not available is an explicit error — never a silent fallback', () => {
    assert.throws(() => createProvider({ AI_PROVIDER: 'openai' }), /not available in this version/);
    assert.throws(() => createProvider({ AI_PROVIDER: 'x'.repeat(500) }), (e) => e.message.length < 120);
  });
  it('an API key in the environment is never read, echoed or put into an error by Stage 1', () => {
    const secret = 'sk-test-SECRET-VALUE-123';
    assert.ok(createProvider({ AI_API_KEY: secret }) instanceof MockProvider);
    try { createProvider({ AI_PROVIDER: 'nope', AI_API_KEY: secret }); assert.fail('should throw'); } catch (e) { assert.ok(!e.message.includes(secret)); }
    assert.ok(!readSrc('ai/providers/index.js').match(/process\.env\.AI_API_KEY|env\.AI_API_KEY/), 'no code path reads the key yet');
  });
  it('the mock provider uses no network, no file system and no AI SDK', () => {
    const src = readSrc('ai/providers/mockProvider.js') + readSrc('ai/providers/index.js') + readSrc('ai/providers/AIProvider.js');
    assert.doesNotMatch(src, /require\(['"](http|https|net|tls|dns|fs|child_process|axios|node-fetch|openai|@anthropic-ai\/sdk|@google\/generative-ai)['"]\)|\bfetch\(/);
  });
  it('no AI SDK was added to the backend dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ');
    assert.doesNotMatch(names, /openai|anthropic|generative-ai|langchain|llama|cohere|gemini/i);
  });
});

// =========================================================================================== input validation
describe('[DETERMINISTIC] validating what the person typed', () => {
  const rejects = (body) => assert.throws(() => validateInput(body), (e) => e instanceof HttpError && e.status === 400 && e.code === 'INVALID_INPUT');
  it('trims, collapses whitespace and strips control characters', () => {
    assert.deepEqual(validateInput({ message: '  hello \n\t world\u0000\u0007  ' }), { message: 'hello world', followUpAnswer: null });
  });
  it('accepts 1 to 500 characters and nothing else', () => {
    assert.equal(validateInput({ message: 'a' }).message, 'a');
    assert.equal(validateInput({ message: 'a'.repeat(LIMITS.MESSAGE_MAX) }).message.length, 500);
    rejects({ message: 'a'.repeat(LIMITS.MESSAGE_MAX + 1) });
    rejects({ message: '' });
    rejects({ message: '   \n\t  ' });
  });
  it('rejects a missing body, a non-object body, and a message that is not text', () => {
    [undefined, null, 'text', 42, [], ['message'], {}, { message: undefined }, { message: null }, { message: 123 }, { message: ['x'] }, { message: { a: 1 } }, { message: true }].forEach(rejects);
  });
  it('a huge input is refused cheaply and its text never appears in the error', () => {
    const huge = 'back pain '.repeat(200000);
    const started = Date.now();
    assert.throws(() => validateInput({ message: huge }), (e) => e.status === 400 && !e.message.includes('back pain'));
    assert.ok(Date.now() - started < 500);
  });
  it('error messages are fixed text: they never echo what was typed', () => {
    const typed = 'my-private-health-concern-XYZ'.repeat(30);
    try { validateInput({ message: typed }); assert.fail('should throw'); } catch (e) { assert.equal(e.message, TEXT.INVALID_INPUT); assert.ok(!JSON.stringify(e).includes('XYZ')); }
  });
  it('the follow-up answer is optional (empty / null count as absent) but limited to 300 characters of text', () => {
    assert.equal(validateInput({ message: 'm' }).followUpAnswer, null);
    assert.equal(validateInput({ message: 'm', followUpAnswer: '' }).followUpAnswer, null);
    assert.equal(validateInput({ message: 'm', followUpAnswer: null }).followUpAnswer, null);
    assert.equal(validateInput({ message: 'm', followUpAnswer: ' lower back ' }).followUpAnswer, 'lower back');
    assert.equal(validateInput({ message: 'm', followUpAnswer: 'a'.repeat(300) }).followUpAnswer.length, 300);
    [{ followUpAnswer: 'a'.repeat(301) }, { followUpAnswer: 5 }, { followUpAnswer: ['x'] }, { followUpAnswer: '   ' }, { followUpAnswer: {} }].forEach((extra) => {
      assert.throws(() => validateInput({ message: 'm', ...extra }), (e) => e.status === 400 && e.message === TEXT.INVALID_ANSWER);
    });
  });
});

describe('[DETERMINISTIC] treating a provider\'s answer as untrusted', () => {
  it('a clarifying question is used only if it is a short, plain, safely-worded question', () => {
    assert.equal(sanitizeFollowUp('Which area of the body is it?'), 'Which area of the body is it?');
    ['', 'ok?', 'No question mark here', 'x'.repeat(250) + '?', 'Do you have a serious illness?', 'Are you diagnosed with anything?', 'This confirms it?', 'Visit <b>this</b> site?', 'See https://evil.example now?', 'Try www.evil.example?', 42, null, undefined, {}, []].forEach((bad) => assert.equal(sanitizeFollowUp(bad), null, JSON.stringify(bad)));
  });
  it('keeps only the fields it knows: ids, slugs and any other field are dropped', () => {
    const out = normalizeAnalysis({ intent: INTENTS.GUIDED_REQUEST, signals: { isVague: true, searchPhrases: ['lumbago'], protocolId: 'p1' }, followUp: 'Which area is it?', slug: 'secret-draft', protocolId: 'p1', recommendation: { slug: 'secret-draft' } });
    assert.deepEqual(Object.keys(out).sort(), ['followUp', 'intent', 'isVague', 'searchPhrases']);
    assert.equal(JSON.stringify(out).includes('secret-draft'), false);
    assert.equal(JSON.stringify(out).includes('p1'), false);
  });
  it('an unknown intent becomes UNKNOWN; garbage becomes a safe default', () => {
    assert.equal(normalizeAnalysis({ intent: 'DELETE_EVERYTHING' }).intent, INTENTS.UNKNOWN);
    [null, undefined, 'x', 5, [], {}].forEach((g) => assert.deepEqual(normalizeAnalysis(g), { intent: INTENTS.UNKNOWN, isVague: false, searchPhrases: [], followUp: null }));
  });
  it('search phrases are filtered to text, truncated, de-junked and capped', () => {
    const phrases = ['ok phrase', 5, null, '', '   ', '!!!', 'x'.repeat(500), ...Array.from({ length: 30 }, (_, i) => `phrase ${i}`)];
    const out = normalizeAnalysis({ signals: { searchPhrases: phrases } }).searchPhrases;
    assert.ok(out.length <= LIMITS.SEARCH_PHRASES_MAX);
    out.forEach((p) => { assert.equal(typeof p, 'string'); assert.ok(p.length <= LIMITS.SEARCH_PHRASE_CHARS_MAX); });
    assert.equal(out[0], 'ok phrase');
    assert.ok(!out.includes('!!!'));
  });
  it('isVague is true only for a real boolean true', () => {
    ['yes', 1, 'true', [], {}].forEach((v) => assert.equal(normalizeAnalysis({ signals: { isVague: v } }).isVague, false));
    assert.equal(normalizeAnalysis({ signals: { isVague: true } }).isVague, true);
  });
});

// ==================================================================================================== decisions
describe('[DETERMINISTIC] what the assistant does with a request', () => {
  const expectRecommendation = async (ask, message, slug, intent) => {
    const r = await ask(message);
    assert.equal(r.outcome, OUTCOMES.RECOMMENDATION, message);
    assert.equal(r.recommendation.slug, slug, message);
    if (intent) assert.equal(r.intent, intent, message);
    return r;
  };

  it('DIRECT request: finds the named published protocol and says it matches the name given', async () => {
    const { ask } = build();
    const r = await expectRecommendation(ask, 'I want the Back Pain protocol', 'back-pain', INTENTS.DIRECT_PROTOCOL_REQUEST);
    assert.equal(r.message, TEXT.REASON_DIRECT);
    assert.equal(r.followUp, null);
  });
  it('GENERAL search: a concern, search term, condition or synonym finds the protocol and uses the "may be relevant" wording', async () => {
    const { ask } = build();
    const cases = [
      ['Do you have something for back stiffness?', 'back-pain'], ['I have a sore back', 'back-pain'], ['lumbago', 'back-pain'], ['I get bad migraines at night', 'migraine-relief'],
      ['my knees ache', 'knee-pain'], ['I keep getting a sick headache', 'migraine-relief'],
    ];
    for (const [m, slug] of cases) {
      const r = await expectRecommendation(ask, m, slug, INTENTS.GENERAL_PROTOCOL_SEARCH);
      assert.equal(r.message, TEXT.REASON_RELEVANT, m);
    }
  });
  it('GUIDED request that does say where: recommends without needing a question', async () => {
    const { ask } = build();
    await expectRecommendation(ask, "I have been having discomfort around my lower back and I don't know which protocol I should use.", 'back-pain', INTENTS.GUIDED_REQUEST);
  });
  it('NO MATCH: unrelated requests and protocols that do not exist get the plain no-match answer (and no recommendation)', async () => {
    const { ask } = build();
    for (const m of ['tell me a joke', 'what is the weather', 'toothache', 'I want the Knee Replacement protocol', 'I want the Shoulder Pain protocol']) {
      const r = await ask(m);
      assert.equal(r.outcome, OUTCOMES.NO_MATCH, m);
      assert.equal(r.recommendation, null);
      assert.equal(r.message, TEXT.NO_MATCH);
    }
  });
  it('a request that only barely overlaps a protocol (below "weak") is declined cleanly: never recommended, never asked about', async () => {
    const { ask } = build();
    for (const m of ['knee replacement surgery recovery plan', 'my knee replacement', 'back surgery recovery exercises']) {
      const r = await ask(m);
      assert.equal(r.outcome, OUTCOMES.NO_MATCH, m);
      assert.equal(r.recommendation, null, m);
      assert.equal(r.followUp, null, m);
    }
  });
  it('a vague request is asked ONE question; after the answer it resolves; it is never asked twice', async () => {
    const { ask } = build();
    const first = await ask('I have some discomfort');
    assert.equal(first.outcome, OUTCOMES.FOLLOW_UP);
    assert.equal(first.followUp.question, TEXT.FOLLOW_UP_VAGUE);
    assert.equal(first.recommendation, null);
    const second = await ask('I have some discomfort', 'it is my lower back');
    assert.equal(second.outcome, OUTCOMES.RECOMMENDATION);
    assert.equal(second.recommendation.slug, 'back-pain');
    const third = await ask('I have some discomfort', 'not really sure');
    assert.equal(third.outcome, OUTCOMES.NO_MATCH, 'still vague after the one question: no second question');
  });
  it('a related-but-not-clear match is asked about once (not for a named protocol), then resolved or declined', async () => {
    const { ask } = build();
    const first = await ask('my neck');
    assert.equal(first.outcome, OUTCOMES.FOLLOW_UP);
    assert.equal(first.followUp.question, TEXT.FOLLOW_UP_WEAK);
    const resolved = await ask('my neck', 'tension in my neck');
    assert.equal(resolved.outcome, OUTCOMES.RECOMMENDATION);
    assert.equal(resolved.recommendation.slug, 'neck-shoulder');
    const declined = await ask('my neck', 'it is annoying');
    assert.equal(declined.outcome, OUTCOMES.NO_MATCH, 'asked once already');
  });
  it('a NAMED protocol that is only weakly matched is never guessed at and never asked about', async () => {
    const { ask } = build();
    const r = await ask('I want the Neck protocol');
    assert.notEqual(r.outcome, OUTCOMES.FOLLOW_UP);
    assert.notEqual(r.outcome, OUTCOMES.RECOMMENDATION);
  });
  it('when more than one protocol fits equally, it asks once, uses the answer to choose, and never guesses between near-equals', async () => {
    const twins = [
      detail({ slug: 'neck-relief', name: 'Neck Tension Relief', displayName: 'Neck Tension Relief', conditions: [{ slug: 'nt', name: 'Neck tension' }] }),
      detail({ slug: 'neck-desk', name: 'Neck Tension for Desk Workers', displayName: 'Neck Tension for Desk Workers', conditions: [{ slug: 'nt', name: 'Neck tension' }] }),
    ];
    const { ask } = build({ published: twins });
    const first = await ask('neck tension');
    assert.equal(first.outcome, OUTCOMES.FOLLOW_UP);
    assert.equal(first.followUp.question, TEXT.FOLLOW_UP_AMBIGUOUS);
    const chosen = await ask('neck tension', 'I am one of the desk workers');
    assert.equal(chosen.outcome, OUTCOMES.RECOMMENDATION);
    assert.equal(chosen.recommendation.slug, 'neck-desk');
    // A looser answer ("work at a desk" vs the name "Desk Workers") may not be decisive — but it must NEVER yield the wrong protocol.
    const loose = await ask('neck tension', 'I work at a desk');
    assert.notEqual(loose.recommendation && loose.recommendation.slug, 'neck-relief');
    const stillTied = await ask('neck tension', 'not sure');
    assert.equal(stillTied.outcome, OUTCOMES.NO_MATCH, 'a tie after the one question is not resolved by guessing');
  });
  it('the backend has the last word on the label: a strong catalogue match is never reported as UNKNOWN', async () => {
    const { ask } = build({ provider: fakeProvider(async () => ({ intent: INTENTS.UNKNOWN, signals: { isVague: false } })) });
    const r = await ask('Back Pain');
    assert.equal(r.outcome, OUTCOMES.RECOMMENDATION);
    assert.equal(r.intent, INTENTS.GENERAL_PROTOCOL_SEARCH);
  });
  it('the winner is re-resolved through the public lookup: if it was unpublished a moment ago it is NOT shown', async () => {
    const { svc, state } = build();
    const original = state.published;
    const spyList = () => original; // the catalogue still lists it, but the final lookup no longer finds it (race)
    const racing = createAssistantService({ publicProtocols: { listForMatching: spyList, getDetail: () => null }, db: { query: async (sql, [_slug]) => ({ rows: [undefined].filter(Boolean) }) }, getProvider: () => new MockProvider(), logger: { warn() {} } });
    const r = await racing.handle(validateInput({ message: 'I want the Back Pain protocol' }));
    assert.equal(r.outcome, OUTCOMES.NO_MATCH);
    assert.equal(r.recommendation, null);
    assert.ok(svc);
  });
  it('only what is in the published catalogue can be returned: with nothing published, nothing is recommended', async () => {
    const { ask } = build({ published: [] });
    for (const m of ['I want the Back Pain protocol', 'back pain', 'my knees ache']) assert.equal((await ask(m)).outcome, OUTCOMES.NO_MATCH, m);
  });
  it('un-publishing takes effect on the very next request (the catalogue is read fresh every time)', async () => {
    const { ask, state } = build();
    assert.equal((await ask('I want the Back Pain protocol')).outcome, OUTCOMES.RECOMMENDATION);
    state.published = state.published.filter((d) => d.slug !== 'back-pain');
    assert.equal((await ask('I want the Back Pain protocol')).outcome, OUTCOMES.NO_MATCH);
  });
  it('a condition synonym recorded by an admin works, and is ignored once its condition is inactive', async () => {
    const SYN = { migraine: ['sick headache'] };
    const mk = (row) => createAssistantService({ publicProtocols: { listForMatching: () => FIXTURE, getDetail: (s) => FIXTURE.find((d) => d.slug === s) || null }, db: { query: async (sql, [slug]) => ({ rows: [(SYN[slug] ? row : undefined)].filter(Boolean) }) }, getProvider: () => new MockProvider(), logger: { warn() {} } });
    const active = await mk({ is_active: 1, synonyms_json: JSON.stringify(SYN.migraine) }).handle(validateInput({ message: 'i have a sick headache' }));
    assert.equal(active.recommendation.slug, 'migraine-relief');
    const inactiveSvc = mk({ is_active: 0, synonyms_json: JSON.stringify(['zzyzx']) });
    const none = await inactiveSvc.handle(validateInput({ message: 'zzyzx' }));
    assert.equal(none.outcome, OUTCOMES.NO_MATCH);
  });
  it('corrupt synonym data is ignored rather than breaking the assistant', async () => {
    const svc = createAssistantService({ publicProtocols: { listForMatching: () => FIXTURE, getDetail: (s) => FIXTURE.find((d) => d.slug === s) || null }, db: { query: async (sql, [_slug]) => ({ rows: [({ is_active: 1, synonyms_json: '{not json' })].filter(Boolean) }) }, getProvider: () => new MockProvider(), logger: { warn() {} } });
    assert.equal((await svc.handle(validateInput({ message: 'I want the Back Pain protocol' }))).recommendation.slug, 'back-pain');
  });
});

// ============================================================================== provider misbehaviour
describe('[DETERMINISTIC] a provider that misbehaves cannot change which protocol is returned or what is said', () => {
  it('ids, slugs and recommendations in a provider\'s answer are ignored; the answer is the backend\'s', async () => {
    const hostile = fakeProvider(async () => ({
      intent: INTENTS.GENERAL_PROTOCOL_SEARCH, signals: { isVague: false, searchPhrases: ['zzz nothing'], protocolId: 'p-secret' },
      slug: 'secret-draft', protocolId: 'p-secret', recommendation: { slug: 'secret-draft', name: 'SECRET DRAFT' }, message: 'You have a serious disease. Take this protocol.',
    }));
    const { ask } = build({ provider: hostile });
    const r = await ask('I want the Back Pain protocol');
    assert.equal(r.recommendation.slug, 'back-pain');
    const json = JSON.stringify(r);
    ['secret-draft', 'SECRET DRAFT', 'p-secret', 'serious disease'].forEach((s) => assert.ok(!json.includes(s), s));
  });
  it('a provider cannot make something up: pointing at an unpublished slug leads nowhere', async () => {
    const liar = fakeProvider(async () => ({ intent: INTENTS.DIRECT_PROTOCOL_REQUEST, signals: { isVague: false }, slug: 'hip-pain-draft', recommendation: { slug: 'hip-pain-draft' } }));
    const { ask } = build({ provider: liar });
    const r = await ask('I want the Hip Pain Draft protocol');
    assert.equal(r.outcome, OUTCOMES.NO_MATCH);
    assert.equal(r.recommendation, null);
  });
  it('a diagnosis-style clarifying question from a provider is discarded and replaced with our own wording', async () => {
    const bad = fakeProvider(async () => ({ intent: INTENTS.GENERAL_PROTOCOL_SEARCH, signals: { isVague: true }, followUp: 'You have arthritis, correct?' }));
    const { ask } = build({ provider: bad });
    const r = await ask('I have some discomfort');
    assert.equal(r.outcome, OUTCOMES.FOLLOW_UP);
    assert.equal(r.followUp.question, TEXT.FOLLOW_UP_VAGUE);
  });
  it('a safe question from a provider IS used', async () => {
    const good = fakeProvider(async () => ({ intent: INTENTS.GENERAL_PROTOCOL_SEARCH, signals: { isVague: true }, followUp: 'Which part of your body is bothering you?' }));
    const { ask } = build({ provider: good });
    assert.equal((await ask('I have some discomfort')).followUp.question, 'Which part of your body is bothering you?');
  });
  it('extra search phrases from a provider are used only as words to search with (they can help find a published protocol, nothing more)', async () => {
    const helper = fakeProvider(async () => ({ intent: INTENTS.GENERAL_PROTOCOL_SEARCH, signals: { isVague: false, searchPhrases: ['lumbago'] } }));
    const { ask } = build({ provider: helper });
    assert.equal((await ask('my spine feels locked up')).recommendation.slug, 'back-pain');
  });
  it('a provider that returns nothing, or rubbish, is treated as UNKNOWN: no crash, no invented answer', async () => {
    for (const value of [undefined, null, 'text', 42, [], {}, { intent: 'x' }]) {
      const { ask } = build({ provider: fakeProvider(async () => value) });
      const r = await ask('tell me a joke');
      assert.equal(r.outcome, OUTCOMES.NO_MATCH);
      assert.equal(r.intent, INTENTS.UNKNOWN);
    }
  });
  it('FAILURE: a provider that throws becomes a fixed 503; neither the response nor the log contains what the person typed', async () => {
    const secret = 'my-very-private-lower-back-condition-9f3a';
    const failing = fakeProvider(async ({ message }) => { throw new Error(`upstream rejected input: ${message}`); }, 'real-model');
    const { ask, logs } = build({ provider: failing });
    await assert.rejects(() => ask(secret), (e) => {
      assert.ok(e instanceof HttpError);
      assert.equal(e.status, 503);
      assert.equal(e.message, TEXT.UNAVAILABLE);
      assert.equal(e.code, 'AI_UNAVAILABLE');
      assert.ok(!JSON.stringify({ message: e.message, stack: e.stack, code: e.code }).includes(secret), 'not in the error the central handler will log');
      assert.equal(e.cause, undefined);
      return true;
    });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[ai\] provider "real-model" failed \(Error\)\.$/);
    assert.ok(!logs.join(' ').includes(secret));
  });
  it('FAILURE: a slow provider is cut off by the time limit', async () => {
    const slow = fakeProvider(() => new Promise(() => {}), 'slow');
    const { ask, logs } = build({ provider: slow, timeoutMs: 25 });
    await assert.rejects(() => ask('back pain'), (e) => e.status === 503 && e.message === TEXT.UNAVAILABLE);
    assert.match(logs[0], /provider "slow" failed/);
  });
  it('FAILURE: a provider that cannot even be created (bad configuration) fails only this request, safely', async () => {
    const { ask, logs } = build({ getProvider: () => { throw new Error('AI provider "secret-name" is not available'); } });
    await assert.rejects(() => ask('back pain'), (e) => e.status === 503 && e.message === TEXT.UNAVAILABLE);
    assert.ok(!logs.join(' ').includes('secret-name'));
    assert.match(logs[0], /provider "unavailable" failed/);
  });
  it('a provider throwing a non-Error value is still handled', async () => {
    const { ask } = build({ provider: fakeProvider(async () => { throw 'a string'; }) }); // eslint-disable-line no-throw-literal
    await assert.rejects(() => ask('back pain'), (e) => e.status === 503);
  });
});

// ===================================================================================== response and wording
describe('[DETERMINISTIC] what a response looks like, and how it is worded', () => {
  const CORPUS = [
    'I want the Back Pain protocol', 'Do you have something for back stiffness?', 'lumbago', 'I get bad migraines', 'my knees ache', 'I have some discomfort', 'my neck',
    "I have been having discomfort around my lower back and I don't know which protocol I should use.", 'tell me a joke', 'I want the Knee Replacement protocol', 'pain', 'I feel unwell',
    'back', 'headache', 'I am anxious and cannot sleep', 'chest pain and dizziness', 'I think I have cancer', 'am I diagnosed with arthritis', 'cure my migraine', 'what treatment do I need for back pain',
  ];

  it('every response has exactly the documented shape, always includes the disclaimer, and exposes no scores, ranks or ids', async () => {
    const { ask } = build();
    for (const m of CORPUS) {
      for (const r of [await ask(m), await ask(m, 'lower back')]) {
        assert.deepEqual(Object.keys(r).sort(), ['disclaimer', 'followUp', 'intent', 'message', 'outcome', 'recommendation'], m);
        assert.equal(r.disclaimer, TEXT.DISCLAIMER);
        assert.ok(Object.values(INTENTS).includes(r.intent));
        assert.ok(Object.values(OUTCOMES).includes(r.outcome));
        if (r.recommendation) assert.deepEqual(Object.keys(r.recommendation).sort(), ['category', 'conditions', 'displayName', 'name', 'shortDescription', 'slug']);
        if (r.followUp) assert.deepEqual(Object.keys(r.followUp), ['question']);
        const keys = allStrings(r).join(' ');
        assert.doesNotMatch(JSON.stringify(Object.keys(r)) + JSON.stringify(r.recommendation ? Object.keys(r.recommendation) : []), /score|rank|candidate|evidence|field|weight/i);
        assert.ok(keys.length > 0);
      }
    }
  });
  it('the outcome and its fields agree: recommendation <=> recommendation object; follow_up <=> question; no_match <=> neither', async () => {
    const { ask } = build();
    for (const m of CORPUS) {
      const r = await ask(m);
      assert.equal(Boolean(r.recommendation), r.outcome === OUTCOMES.RECOMMENDATION, m);
      assert.equal(Boolean(r.followUp), r.outcome === OUTCOMES.FOLLOW_UP, m);
      if (r.outcome === OUTCOMES.NO_MATCH) assert.equal(r.message, TEXT.NO_MATCH);
      if (r.outcome === OUTCOMES.FOLLOW_UP) assert.equal(r.message, null);
    }
  });
  it('SAFETY: nothing the assistant says (apart from the disclaimer, which says there is no diagnosis) uses diagnosis or treatment wording', async () => {
    const { ask } = build();
    for (const m of CORPUS) {
      for (const r of [await ask(m), await ask(m, 'lower back'), await ask(m, 'not sure')]) {
        const spoken = allStrings({ message: r.message, followUp: r.followUp, recommendation: r.recommendation }).filter((s) => !FIXTURE.some((d) => [d.name, d.displayName, d.shortDescription].includes(s)));
        spoken.forEach((s) => FORBIDDEN_WORDING.forEach((re) => assert.ok(!re.test(s), `${JSON.stringify(m)} -> ${JSON.stringify(s)} trips ${re}`)));
      }
    }
  });
  it('SAFETY: the wording is exactly the approved wording', () => {
    assert.equal(TEXT.DISCLAIMER, 'This protocol recommendation is not a medical diagnosis. If you have severe, worsening, or concerning symptoms, seek appropriate medical care.');
    assert.equal(TEXT.REASON_RELEVANT, 'Based on the information you provided, this protocol may be relevant to the concern you described.');
    assert.equal(TEXT.NO_MATCH, "We couldn't find a published protocol that closely matches the information provided.");
    Object.entries(TEXT).filter(([k]) => k !== 'DISCLAIMER').forEach(([k, s]) => FORBIDDEN_WORDING.forEach((re) => assert.ok(!re.test(s), `${k} trips ${re}`)));
    assert.match(TEXT.REASON_RELEVANT, /may be relevant/);
  });
  it('SAFETY: a medical-sounding request gets a protocol match or a no-match — never advice, diagnosis or a cure', async () => {
    const { ask } = build();
    for (const m of ['I think I have cancer', 'am I diagnosed with arthritis', 'cure my migraine', 'what treatment do I need for back pain', 'chest pain and dizziness']) {
      const r = await ask(m);
      assert.ok([OUTCOMES.RECOMMENDATION, OUTCOMES.NO_MATCH, OUTCOMES.FOLLOW_UP].includes(r.outcome));
      assert.equal(r.disclaimer, TEXT.DISCLAIMER);
    }
  });
});

// =========================================================================================== privacy by design
describe('[DETERMINISTIC] privacy: nothing the person writes is stored or logged', () => {
  it('no log line is ever produced from a successful request, whatever was typed', async () => {
    const { ask, logs } = build();
    for (const m of ['my-private-token-abc123 back pain', 'I want the Back Pain protocol', 'tell me a joke']) await ask(m);
    assert.deepEqual(logs, []);
  });
  it('the AI code and its route contain no persistence and no console logging', () => {
    aiFiles().forEach((file) => {
      const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(src, /console\.(log|info|debug|error|warn)\(/, `${path.relative(SRC, file)}: console output`);
      assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)?|writeFile|appendFile|createWriteStream|localStorage|sessionStorage/i, `${path.relative(SRC, file)}: persistence`);
      assert.doesNotMatch(src, /\.run\(|\.exec\(/, `${path.relative(SRC, file)}: database write`);
    });
  });
  it('the route reads the person\'s words only from the POST body — never the URL or query string', () => {
    const route = readSrc('routes/public.ai.routes.js');
    assert.match(route, /assistant\.validateInput\(req\.body\)/);
    assert.doesNotMatch(route, /req\.(query|params|url|originalUrl)/);
  });
});
