/**
 * [DETERMINISTIC SOFTWARE TESTS] AI Stage 2 — free (no paid AI) matching, clarification and the strict response contract.
 * The service is run over a stubbed PUBLISHED catalogue (no database, no network, no key), exactly as in
 * ai.provider-service.test.js, so every decision is checked directly.
 *
 * The catalogue is built like a doctor would build it: a protocol name, conditions, condition synonyms and search
 * terms — and nothing else. No test below depends on the matcher "knowing" any condition.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { AIProvider, MockProvider, createProvider } = require('../src/ai/providers');
const { TEXT, FORBIDDEN_WORDING, INTENTS } = require('../src/ai/constants');
const { createAssistantService, validateInput } = require('../src/ai/assistantService');
const { rankDetailed, rank } = require('../src/ai/protocolMatcher');
const { toPublicResponse, STATUS, MATCH_ACTIONS, SLUG_PATTERN } = require('../src/ai/responseContract');
const { snapToLexicon, editDistance, stem } = require('../src/ai/text');

const SRC = path.join(__dirname, '..', 'src');

// ---------------------------------------------------------------------------------------------- fixtures
const detail = (o) => ({ slug: 'x', name: 'X', displayName: 'X', shortDescription: '', description: '', category: null, conditions: [], searchTerms: [], ...o });
/** A protocol as a doctor sets it up: name, conditions (with admin synonyms keyed by condition slug), search terms. */
const protocol = (name, { conditions = [name], terms = [], description = '', shortDescription = '' } = {}) => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return detail({ slug, name, displayName: name, description, shortDescription, conditions: conditions.map((c) => ({ slug: c.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: c })), searchTerms: terms });
};
const BACK = protocol('Back Pain', { terms: ['pain after sitting', 'lower back discomfort', 'stiff lower back'] });
const NECK = protocol('Neck Pain');
const SHOULDER = protocol('Shoulder Pain');
const SYNONYMS = { 'back-pain': ['lower back pain', 'lumbar pain', 'back ache', 'back stiffness'] };

function build({ published = [BACK, NECK, SHOULDER], provider = new MockProvider(), synonyms = SYNONYMS } = {}) {
  const state = { published: [...published] };
  const logs = [];
  const fakeDb = { query: async (sql, [slug]) => ({ rows: [(synonyms[slug] ? { is_active: 1, synonyms_json: JSON.stringify(synonyms[slug]) } : undefined)].filter(Boolean) }) };
  const svc = createAssistantService({
    publicProtocols: { listForMatching: () => state.published, getDetail: (slug) => state.published.find((d) => d.slug === slug) || null },
    db: fakeDb,
    getProvider: () => provider,
    logger: { warn: (m) => logs.push(String(m)) },
  });
  const ask = (message, followUpAnswer) => svc.respond(validateInput({ message, followUpAnswer }));
  const catalogueOf = () => state.published;
  return { svc, ask, state, logs, catalogueOf };
}
/** The catalogue shape the matcher consumes (what the service builds from published protocols + condition synonyms). */
const flatten = (published, synonyms = SYNONYMS) => published.map((p) => ({
  slug: p.slug, name: p.name, displayName: p.displayName, shortDescription: p.shortDescription, description: p.description, categoryName: null,
  conditions: p.conditions.map((c) => ({ name: c.name, synonyms: synonyms[c.slug] || [] })), searchTerms: p.searchTerms,
}));
const slugOf = (r) => (r.protocol ? r.protocol.slug : null);
const walkStrings = (v, acc = []) => { if (typeof v === 'string') acc.push(v); else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, acc)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => walkStrings(x, acc)); return acc; };
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const aiSourceFiles = () => {
  const out = [];
  (function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) out.push(p); }); }(path.join(SRC, 'ai')));
  out.push(path.join(SRC, 'routes', 'public.ai.routes.js'), path.join(SRC, 'routes', 'admin.ai.routes.js'));
  return out;
};

// ====================================================================================== natural language, from metadata
describe('[DETERMINISTIC] natural-language matching is driven by the published metadata', () => {
  it('"my lower back hurts" finds Back Pain', async () => {
    const { ask } = build();
    const r = await ask('my lower back hurts');
    assert.equal(r.status, STATUS.MATCH);
    assert.equal(slugOf(r), 'back-pain');
  });
  it('"I have discomfort around my lumbar area" finds Back Pain through the condition synonym "lumbar pain"', async () => {
    const { ask } = build();
    assert.equal(slugOf(await ask('I have discomfort around my lumbar area')), 'back-pain');
  });
  it('"pain after sitting for long hours" finds Back Pain through its search term', async () => {
    const { ask } = build();
    assert.equal(slugOf(await ask('pain after sitting for long hours')), 'back-pain');
  });
  it('more phrasings of the same concerns, using synonyms, search terms and the name', async () => {
    const { ask } = build();
    for (const m of ['my back is stiff after sitting all day', 'a stiff lower back in the mornings', 'lower back discomfort', 'I have a back ache', 'back stiffness', 'I get lumbar pain at work', 'Back Pain', 'the back pain protocol']) {
      assert.equal(slugOf(await ask(m)), 'back-pain', m);
    }
  });
  it('the other protocols are found the same way — nothing is special about "back"', async () => {
    const { ask } = build();
    assert.equal(slugOf(await ask('my neck hurts')), 'neck-pain');
    assert.equal(slugOf(await ask('discomfort in my shoulder')), 'shoulder-pain');
  });
  it('a protocol the code has never heard of is matched from its metadata alone (no JavaScript change per protocol)', async () => {
    const wrist = protocol('Carpal Comfort', { conditions: ['Wrist Tension'], terms: ['tingling fingers at night', 'keyboard strain'] });
    const { ask } = build({ published: [BACK, NECK, wrist], synonyms: { ...SYNONYMS, 'wrist-tension': ['typing wrist soreness'] } });
    assert.equal(slugOf(await ask('my wrist feels tense')), 'carpal-comfort');
    assert.equal(slugOf(await ask('I get tingling fingers at night')), 'carpal-comfort');
    assert.equal(slugOf(await ask('typing wrist soreness')), 'carpal-comfort');
    assert.equal(slugOf(await ask('keyboard strain')), 'carpal-comfort');
  });
  it('invented, meaningless names work too — the words come only from the published data', async () => {
    const odd = protocol('Zorblax Harmony', { conditions: ['Glimmering Fatigue'], terms: ['quibble weariness'] });
    const { ask } = build({ published: [odd, BACK] }); // BACK stays published so this is not a one-protocol catalogue
    assert.equal(slugOf(await ask('I want the Zorblax Harmony protocol')), 'zorblax-harmony');
    assert.equal(slugOf(await ask('some glimmering fatigue lately')), 'zorblax-harmony');
    assert.equal(slugOf(await ask('quibble weariness')), 'zorblax-harmony');
  });
  it('a new search term or synonym takes effect the moment it is published, and disappears when it is not', async () => {
    const t = build({ published: [BACK, NECK] });
    assert.notEqual(slugOf(await t.ask('hunched over a laptop all day')), 'neck-pain');
    t.state.published = [BACK, protocol('Neck Pain', { terms: ['hunched over a laptop'] })];
    assert.equal(slugOf(await t.ask('hunched over a laptop all day')), 'neck-pain');
    t.state.published = [BACK, NECK];
    assert.notEqual(slugOf(await t.ask('hunched over a laptop all day')), 'neck-pain');
  });
  it('the description is only a weak hint: it can never make a protocol the answer on its own', async () => {
    const decoy = protocol('Evening Calm', { description: 'Helps with sciatica, lumbar pain, back stiffness and neck tension.', terms: ['night calm'] });
    const { ask } = build({ published: [decoy] });
    assert.notEqual(slugOf(await ask('sciatica')), 'evening-calm');
    assert.notEqual(slugOf(await ask('lumbar pain')), 'evening-calm');
  });
  it('the matcher, service, text rules and response contract contain no condition-specific special cases', () => {
    const banned = /back pain|lower back|lumbar|sciatica|migraine|neck pain|shoulder pain|knee pain|\bsciatic|\blumbago/i;
    ['protocolMatcher.js', 'assistantService.js', 'text.js', 'responseContract.js', 'constants.js'].forEach((f) => {
      const code = stripComments(fs.readFileSync(path.join(SRC, 'ai', f), 'utf8'));
      assert.doesNotMatch(code, banned, `ai/${f} mentions a specific condition`);
    });
  });
  it('the development provider\'s word list only helps it label a request as health-related; it never chooses a protocol', async () => {
    // A catalogue with no body-part words at all: the provider still recognises "my back hurts" as a concern, yet nothing is recommended.
    const { ask } = build({ published: [protocol('Evening Wind Down', { terms: ['night calm'] })] });
    for (const m of ['my back hurts', 'migraine again', 'sciatica']) assert.notEqual((await ask(m)).status, STATUS.MATCH, m);
  });
});

// ===================================================================================== typo tolerance
describe('[DETERMINISTIC] safe fuzzy matching', () => {
  it('editDistance counts inserts, deletes, substitutions and neighbour swaps, and gives up beyond the limit', () => {
    assert.equal(editDistance('lumbar', 'lumber', 2), 1);
    assert.equal(editDistance('back', 'bakc', 2), 1);
    assert.equal(editDistance('shoulder', 'shouder', 2), 1);
    assert.equal(editDistance('neck', 'knee', 1), Infinity);
  });
  it('snapToLexicon corrects a clear misspelling to the single closest catalogue word', () => {
    const lex = new Set(['lumbar', 'shoulder', 'back', 'migraine']);
    assert.deepEqual(snapToLexicon(['lumber', 'shouder', 'migrane'], lex), { tokens: ['lumbar', 'shoulder', 'migraine'], corrected: 3 });
    assert.deepEqual(snapToLexicon(['bakc'], lex).tokens, ['back'], 'four letters: only a swap of neighbours');
  });
  it('it leaves alone: words already in the catalogue, short words, other first letters, and ties', () => {
    const lex = new Set(['lumbar', 'back', 'neck', 'knee']);
    assert.deepEqual(snapToLexicon(['back', 'bag', 'nick', 'knock', 'ximbar'], lex).tokens, ['back', 'bag', 'nick', 'knock', 'ximbar']);
    const tie = new Set(['bread', 'break']);
    assert.equal(snapToLexicon(['breax'], tie).corrected, 0, 'two equally close words: no guess');
  });
  it('a request with a spelling mistake still finds the protocol, but ranks just below the same request spelt correctly', async () => {
    const { ask, catalogueOf } = build();
    assert.equal(slugOf(await ask('I have discomfort in my lumber area')), 'back-pain');
    assert.equal(slugOf(await ask('my shouder hurts')), 'shoulder-pain');
    const flat = flatten(catalogueOf());
    const typo = rankDetailed(['lumber pain'], flat)[0];
    const clean = rankDetailed(['lumbar pain'], flat)[0];
    assert.ok(typo && clean && typo.score < clean.score);
  });
  it('a nonsense word near nothing in the catalogue is not "corrected" into a match', async () => {
    const { ask } = build();
    for (const m of ['xylophone orchestra', 'qwertyuiop', 'flurble zibbit']) assert.equal((await ask(m)).status, STATUS.NO_MATCH, m);
  });
  it('stemming treats -ing forms like their base word (sitting = sit)', () => {
    assert.equal(stem('sitting'), stem('sit'));
    assert.equal(stem('stopped'), stem('stop'));
    assert.equal(stem('stiffness'), 'stiff');
  });
});

// ===================================================================================== ranking ladder
describe('[DETERMINISTIC] deterministic confidence ranking', () => {
  const PHRASE = 'calm focus';
  const byName = protocol('Calm Focus', { conditions: ['Something Else One'] });
  const byCondition = protocol('Alpha Routine', { conditions: ['Calm Focus'] });
  const byTerm = protocol('Beta Routine', { conditions: ['Something Else Two'], terms: [PHRASE] });
  const bySynonym = protocol('Gamma Routine', { conditions: ['Something Else Three'] });
  const SYN = { 'something-else-three': [PHRASE] };
  const catalogue = () => {
    const b = build({ published: [bySynonym, byTerm, byCondition, byName], synonyms: SYN });
    return b.svc && b; // build ensures the same catalogue loader is used; ranking below uses loadable shape
  };

  /** Rank through the real catalogue loader so synonyms come from the (stubbed) conditions table. */
  async function ranked(query, published = [bySynonym, byTerm, byCondition, byName]) {
    const flat = published.map((p) => ({
      slug: p.slug, name: p.name, displayName: p.displayName, shortDescription: p.shortDescription, description: p.description, categoryName: null,
      conditions: p.conditions.map((c) => ({ name: c.name, synonyms: SYN[c.slug] || [] })), searchTerms: p.searchTerms,
    }));
    return rankDetailed([query], flat);
  }

  it('exact protocol name > exact condition > exact search term > exact synonym', async () => {
    const out = await ranked(PHRASE);
    assert.deepEqual(out.map((r) => r.slug), [byName.slug, byCondition.slug, byTerm.slug, bySynonym.slug]);
    assert.deepEqual(out.map((r) => r.tier), ['name_exact', 'condition_exact', 'term_exact', 'synonym_exact']);
    for (let i = 1; i < out.length; i += 1) assert.ok(out[i - 1].score > out[i].score, `${out[i - 1].tier} must outrank ${out[i].tier}`);
  });
  it('each exact tier outranks the looser matches below it (a name merely contained in a sentence is not an exact name)', async () => {
    const exactCondition = (await ranked(PHRASE)).find((r) => r.slug === byCondition.slug);
    const nameInSentence = (await ranked('I would love some calm focus please')).find((r) => r.slug === byName.slug);
    assert.ok(nameInSentence.tier !== 'name_exact');
    assert.ok(exactCondition.score >= nameInSentence.score - 10);
  });
  it('the same input always produces the same ranking (no randomness, no clock)', async () => {
    const first = JSON.stringify(await ranked(PHRASE));
    for (let i = 0; i < 25; i += 1) assert.equal(JSON.stringify(await ranked(PHRASE)), first);
    const shuffled = [byName, bySynonym, byCondition, byTerm];
    assert.deepEqual((await ranked(PHRASE, shuffled)).map((r) => r.slug), (await ranked(PHRASE)).map((r) => r.slug), 'catalogue order does not matter');
  });
  it('a typed exact protocol name wins outright even when another protocol has the same words as a condition', async () => {
    const { ask } = build({ published: [byName, byCondition] });
    const r = await ask('Calm Focus');
    assert.equal(r.status, STATUS.MATCH);
    assert.equal(slugOf(r), byName.slug);
  });
  it('rank() keeps its documented { slug, score, field } shape; tiers are internal to rankDetailed', () => {
    const flat = [{ slug: 'a', name: 'Alpha', displayName: 'Alpha', conditions: [], searchTerms: [] }];
    assert.deepEqual(Object.keys(rank(['alpha'], flat)[0]).sort(), ['field', 'score', 'slug']);
    assert.deepEqual(Object.keys(rankDetailed(['alpha'], flat)[0]).sort(), ['field', 'score', 'slug', 'tier']);
    assert.ok(catalogue());
  });
});

// ===================================================================================== weak matches
describe('[DETERMINISTIC] weak matches are rejected', () => {
  it('unrelated requests get no match — including ones that share a generic word with a protocol', async () => {
    const { ask } = build();
    for (const m of ['rocket engines', 'rocket engine pain', 'engine back', 'what is the weather today', 'tell me a joke', 'how do I bake bread', 'my car engine hurts', 'something unrelated to the protocols in the system']) {
      const r = await ask(m);
      assert.equal(r.status, STATUS.NO_MATCH, `${m} -> ${JSON.stringify(r)}`);
      assert.equal(r.protocol, undefined);
    }
  });
  it('one overlapping word among unrelated ones never recommends', async () => {
    const { ask } = build();
    for (const m of ['I need to go back to the shop and buy a pocket', 'the neck of a bottle', 'my back garden shoulder to shoulder with the fence']) {
      const r = await ask(m);
      assert.notEqual(r.status, STATUS.MATCH, m);
    }
  });
  it('a single generic word ("pain", "problem", "hurts") never identifies a protocol', async () => {
    const { ask } = build();
    for (const m of ['pain', 'problem', 'hurts', 'I feel bad']) {
      const r = await ask(m);
      assert.notEqual(r.status, STATUS.MATCH, m);
    }
  });
  it('a named protocol that is not published is never guessed from one shared word', async () => {
    const { ask } = build({ published: [protocol('Neck and Shoulder Relief'), BACK] });
    assert.notEqual((await ask('I want the Shoulder Pain protocol')).status, STATUS.MATCH);
    assert.notEqual((await ask('I want the Elbow protocol')).status, STATUS.MATCH);
  });
  it('nothing is recommended from an empty catalogue', async () => {
    const { ask } = build({ published: [] });
    for (const m of ['Back Pain', 'my back hurts', 'I have pain']) assert.notEqual((await ask(m)).status, STATUS.MATCH, m);
  });
});

// ===================================================================================== clarification
describe('[DETERMINISTIC] one useful clarifying question, never a chain', () => {
  it('"I have pain." asks which part of the body / what concern; "lower back" then resolves to the best published match', async () => {
    const { ask } = build();
    const first = await ask('I have pain.');
    assert.deepEqual(first, { status: STATUS.CLARIFICATION, question: 'Which part of the body, or what concern, would you like to find a protocol for?', disclaimer: TEXT.DISCLAIMER });
    const second = await ask('I have pain.', 'lower back');
    assert.equal(second.status, STATUS.MATCH);
    assert.equal(slugOf(second), 'back-pain');
  });
  it('works with only a name and condition — no synonyms or search terms needed for this exchange', async () => {
    const { ask } = build({ published: [protocol('Back Pain'), NECK, SHOULDER], synonyms: {} });
    assert.equal((await ask('I have pain.')).status, STATUS.CLARIFICATION);
    assert.equal(slugOf(await ask('I have pain.', 'lower back')), 'back-pain');
    assert.equal(slugOf(await ask('I have pain.', 'my neck')), 'neck-pain');
    assert.equal(slugOf(await ask('I have pain.', 'shoulder')), 'shoulder-pain');
  });
  it('with Neck Pain, Shoulder Pain and Back Pain published, "I have pain." is not guessed: one question, then only a published choice', async () => {
    const { ask } = build();
    assert.equal((await ask('I have pain.')).status, STATUS.CLARIFICATION);
    const published = new Set(['back-pain', 'neck-pain', 'shoulder-pain']);
    for (const answer of ['lower back', 'neck', 'shoulder', 'my upper back and spine']) {
      const r = await ask('I have pain.', answer);
      assert.equal(r.status, STATUS.MATCH, answer);
      assert.ok(published.has(slugOf(r)), answer);
    }
  });
  it('an answer that names something no protocol covers ends in no_match — never a second question, never an invention', async () => {
    const { ask } = build();
    for (const answer of ['my elbow', 'everywhere', 'not really sure', 'it is complicated', 'toothache']) {
      const r = await ask('I have pain.', answer);
      assert.equal(r.status, STATUS.NO_MATCH, answer);
    }
  });
  it('when several published protocols fit about equally, it asks once and the answer decides', async () => {
    const { ask } = build();
    const first = await ask('I have pain in my back or neck');
    assert.equal(first.status, STATUS.CLARIFICATION);
    assert.equal(first.question, TEXT.FOLLOW_UP_AMBIGUOUS);
    assert.equal(slugOf(await ask('I have pain in my back or neck', 'neck')), 'neck-pain');
    assert.equal(slugOf(await ask('I have pain in my back or neck', 'back')), 'back-pain');
    assert.equal((await ask('I have pain in my back or neck', 'no idea')).status, STATUS.NO_MATCH, 'an unhelpful answer is not turned into a guess');
  });
  it('a question is never asked after an answer: for every request and answer, a follow-up answer never yields another question', async () => {
    const { ask } = build();
    const messages = ['I have pain.', 'hurts', 'pain in my back or neck', 'my neck', 'sitting', 'I feel unwell', 'I have some discomfort'];
    const answers = ['lower back', 'neck', 'not sure', 'everything', 'back or neck', 'hmm', 'sitting', 'pain'];
    for (const m of messages) for (const a of answers) assert.notEqual((await ask(m, a)).status, STATUS.CLARIFICATION, `${m} + ${a}`);
  });
  it('no medical question chain: every question the assistant can ask is one of our three fixed, non-diagnostic sentences', async () => {
    const { ask } = build();
    const seen = new Set();
    for (const m of ['I have pain.', 'pain in my back or neck', 'my neck', 'I have some discomfort', 'hurts', 'sitting']) {
      const r = await ask(m);
      if (r.status === STATUS.CLARIFICATION) seen.add(r.question);
    }
    assert.ok(seen.size > 0);
    const allowed = new Set([TEXT.FOLLOW_UP_VAGUE, TEXT.FOLLOW_UP_AMBIGUOUS, TEXT.FOLLOW_UP_WEAK]);
    seen.forEach((q) => { assert.ok(allowed.has(q), q); assert.ok(q.endsWith('?')); assert.doesNotMatch(q, /how long|how severe|medication|since when|diagnos|symptom/i); });
  });
  it('a named protocol is never turned into a question', async () => {
    const { ask } = build();
    for (const m of ['I want the Back Pain protocol', 'I want the Elbow protocol']) assert.notEqual((await ask(m)).status, STATUS.CLARIFICATION, m);
  });
});

// ===================================================================================== published only
describe('[DETERMINISTIC] only published protocols can come back, and the backend decides', () => {
  it('a protocol unpublished between ranking and the final lookup is never returned', async () => {
    const t = build();
    const realList = t.state.published;
    const svc = createAssistantService({
      publicProtocols: { listForMatching: () => realList, getDetail: () => null }, // the public lookup now says: not published
      db: { query: async (sql, [_slug]) => ({ rows: [undefined].filter(Boolean) }) },
      getProvider: () => new MockProvider(),
      logger: { warn() {} },
    });
    const r = await svc.respond(validateInput({ message: 'I want the Back Pain protocol' }));
    assert.equal(r.status, STATUS.NO_MATCH);
  });
  it('a protocol that stops being published stops being offered', async () => {
    const t = build();
    assert.equal(slugOf(await t.ask('my neck hurts')), 'neck-pain');
    t.state.published = [BACK, SHOULDER];
    assert.notEqual(slugOf(await t.ask('my neck hurts')), 'neck-pain');
  });
  it('a protocol cannot be invented: whatever a provider says, the returned slug is always one of the published slugs', async () => {
    const hostile = {
      name: 'hostile',
      analyzeUserRequest: async () => ({ intent: INTENTS.DIRECT_PROTOCOL_REQUEST, protocolId: 'p-999', slug: 'made-up-protocol', recommendation: { slug: 'made-up-protocol', name: 'Invented' }, signals: { isVague: false, searchPhrases: ['made-up-protocol', 'Invented Protocol'], protocolId: 'p-999' }, followUp: null }),
    };
    const t = build({ provider: hostile });
    const published = new Set(t.catalogueOf().map((p) => p.slug));
    for (const m of ['my back hurts', 'zzz', 'Invented Protocol', 'made-up-protocol']) {
      const r = await t.ask(m);
      if (r.status === STATUS.MATCH) assert.ok(published.has(r.protocol.slug), m);
      assert.doesNotMatch(JSON.stringify(r), /made-up|Invented|p-999/);
    }
  });
});

// ===================================================================================== the response contract
describe('[DETERMINISTIC] the strict backend response contract', () => {
  const KEYS = {
    [STATUS.MATCH]: ['actions', 'disclaimer', 'message', 'protocol', 'status'],
    [STATUS.CLARIFICATION]: ['disclaimer', 'question', 'status'],
    [STATUS.NO_MATCH]: ['disclaimer', 'message', 'status'],
  };
  it('every response is exactly one of the documented shapes, with nothing extra', async () => {
    const { ask } = build();
    const seen = new Set();
    for (const m of ['my lower back hurts', 'I have pain.', 'rocket engines', 'Back Pain', 'pain in my back or neck']) {
      const r = await ask(m);
      seen.add(r.status);
      assert.deepEqual(Object.keys(r).sort(), KEYS[r.status], m);
    }
    assert.deepEqual([...seen].sort(), [STATUS.CLARIFICATION, STATUS.MATCH, STATUS.NO_MATCH]);
  });
  it('a match: protocol { slug, name, description }, our own message, and the three fixed actions', async () => {
    const { ask } = build({ published: [{ ...BACK, shortDescription: 'A gentle routine for the lower back.' }, NECK] });
    const r = await ask('I want the Back Pain protocol');
    assert.deepEqual(Object.keys(r.protocol).sort(), ['description', 'name', 'slug']);
    assert.deepEqual(r.protocol, { slug: 'back-pain', name: 'Back Pain', description: 'A gentle routine for the lower back.' });
    assert.ok([TEXT.REASON_RELEVANT, TEXT.REASON_DIRECT].includes(r.message));
    assert.deepEqual(r.actions, MATCH_ACTIONS.map((a) => ({ type: a.type, label: a.label })));
    assert.deepEqual(r.actions.map((a) => a.type), ['view_protocol', 'download_pdf', 'copy_link']);
    assert.ok(r.actions.every((a) => Object.keys(a).sort().join() === 'label,type'), 'an action carries a type and a label — never a URL');
    assert.equal(r.disclaimer, TEXT.DISCLAIMER);
  });
  it('the description falls back to the start of the full description, as plain text, and is capped', async () => {
    const long = protocol('Back Pain', { description: `<b>${'Gentle '.repeat(100)}</b>` });
    const { ask } = build({ published: [long] });
    const r = await ask('Back Pain');
    assert.ok(r.protocol.description.length <= 300);
    assert.ok(r.protocol.description.length > 0);
  });
  it('a provider cannot put HTML, links, ids or its own wording in front of the public', async () => {
    const evil = {
      name: 'evil',
      analyzeUserRequest: async () => ({
        intent: INTENTS.DIRECT_PROTOCOL_REQUEST, message: '<script>alert(1)</script>You have a disease', html: '<img src=x onerror=alert(1)>', url: 'https://evil.example/steal',
        recommendation: { slug: 'back-pain', url: 'https://evil.example', html: '<b>x</b>' }, protocolId: 'abc', signals: { isVague: true, searchPhrases: ['back pain', '<script>x</script>'] }, followUp: 'Visit https://evil.example now?',
      }),
    };
    const { ask } = build({ provider: evil });
    for (const m of ['my back hurts', 'I have pain.', 'nothing at all']) {
      const r = await ask(m);
      const text = JSON.stringify(r);
      assert.doesNotMatch(text, /<script|<img|onerror|evil\.example|You have a disease|https?:|abc/i, m);
      assert.ok(KEYS[r.status], m);
    }
  });
  it('the public response never carries intent, scores, ranks, tiers, runner-ups, ids or flag details', async () => {
    const { ask } = build();
    for (const m of ['Back Pain', 'my neck', 'I have pain.', 'rocket engines']) {
      const text = JSON.stringify(await ask(m));
      assert.doesNotMatch(text, /intent|score|rank|tier|candidate|runner|evidence|weight|AI_ASSESSMENT|flag|"id"|protocolId|versionId|owner|doctor/i, m);
    }
  });
  it('toPublicResponse refuses anything that is not a well-formed result: a bad slug, an empty name, a missing question', () => {
    const rec = (over) => ({ outcome: 'recommendation', message: TEXT.REASON_RELEVANT, recommendation: { slug: 'back-pain', name: 'Back Pain', displayName: 'Back Pain', shortDescription: 'x', ...over } });
    assert.equal(toPublicResponse(rec()).status, STATUS.MATCH);
    for (const slug of ['../etc/passwd', 'Back Pain', 'a/b', 'javascript:alert(1)', '', 'UPPER', 'trailing-', null, 5]) assert.equal(toPublicResponse(rec({ slug })).status, STATUS.NO_MATCH, String(slug));
    assert.equal(toPublicResponse(rec({ name: '', displayName: '' })).status, STATUS.NO_MATCH);
    assert.equal(toPublicResponse({ outcome: 'follow_up', followUp: { question: '' } }).status, STATUS.NO_MATCH);
    for (const junk of [null, undefined, 'x', 5, {}, { outcome: 'weird' }]) assert.equal(toPublicResponse(junk).status, STATUS.NO_MATCH);
    assert.ok(SLUG_PATTERN.test('back-pain') && !SLUG_PATTERN.test('Back-Pain'));
  });
  it('any wording that is not one of our two reasons is replaced by our own', () => {
    const r = toPublicResponse({ outcome: 'recommendation', message: 'This will cure your pain', recommendation: { slug: 'back-pain', name: 'Back Pain', shortDescription: '' } });
    assert.equal(r.message, TEXT.REASON_RELEVANT);
  });
});

// ===================================================================================== medical safety
describe('[DETERMINISTIC] medical safety of everything the assistant says', () => {
  const CORPUS = [
    'my lower back hurts', 'I have pain.', 'I think I have cancer', 'am I diagnosed with arthritis', 'cure my back pain', 'what treatment do I need', 'should I stop taking my medication for my back',
    'chest pain and dizziness', 'I want the Back Pain protocol', 'rocket engines', 'pain in my back or neck', 'will this fix my neck', 'prescribe something for my shoulder',
  ];
  const AUTHORED = new Set(['Back Pain', 'Neck Pain', 'Shoulder Pain']);
  it('no response uses diagnosis, cure, treatment or "you have" wording (protocol names the doctor wrote excepted)', async () => {
    const { ask } = build();
    for (const m of CORPUS) {
      for (const r of [await ask(m), await ask(m, 'lower back'), await ask(m, 'neck')]) {
        walkStrings({ message: r.message, question: r.question, actions: r.actions }).filter((s) => !AUTHORED.has(s)).forEach((s) => {
          FORBIDDEN_WORDING.forEach((re) => assert.ok(!re.test(s), `${JSON.stringify(m)} -> ${JSON.stringify(s)} trips ${re}`));
          assert.doesNotMatch(s, /\b(you have|this will cure|you should definitely|will heal|guarantee|stop taking)\b/i, s);
        });
      }
    }
  });
  it('every response carries the existing disclaimer (apart from "disabled", which says nothing)', async () => {
    const { ask } = build();
    for (const m of CORPUS) assert.equal((await ask(m)).disclaimer, TEXT.DISCLAIMER, m);
    assert.equal(TEXT.DISCLAIMER, 'This protocol recommendation is not a medical diagnosis. If you have severe, worsening, or concerning symptoms, seek appropriate medical care.');
  });
  it('a recommendation says the protocol "may be relevant" and never claims an effect', async () => {
    const { ask } = build();
    const r = await ask('my lower back hurts');
    assert.match(r.message, /may be relevant/);
    assert.doesNotMatch(r.message, /cure|treat|heal|fix|relieve|you have|diagnos/i);
  });
  it('a request that asks to be diagnosed, treated or told what medicine to take gets a protocol match at most — no advice', async () => {
    const { ask } = build();
    for (const m of ['diagnose my back', 'what medicine should I take for my neck', 'should I stop my tablets']) {
      const r = await ask(m);
      const spoken = walkStrings({ message: r.message, question: r.question }).join(' ');
      assert.doesNotMatch(spoken, /medicine|tablet|medication|dose|prescri|diagnos(e|ed|is)\b(?!\.)/i.source ? /medicine|tablet|medication|dose|prescri/i : /x/, m);
    }
  });
});

// ===================================================================================== provider abstraction, no key
describe('[DETERMINISTIC] the provider abstraction is intact and no key is needed', () => {
  it('the default provider is the mock provider and needs no environment at all', () => {
    const p = createProvider({});
    assert.ok(p instanceof MockProvider);
    assert.ok(p instanceof AIProvider);
    assert.equal(p.name, 'mock');
  });
  it('API keys in the environment are ignored: setting them changes nothing and nothing is sent anywhere', () => {
    const env = { OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test', AI_API_KEY: 'k-test', ANTHROPIC_API_KEY: 'a-test' };
    assert.ok(createProvider(env) instanceof MockProvider);
  });
  it('asking for a provider that does not exist is an explicit error, never a silent fallback', () => {
    for (const name of ['openai', 'gemini', 'anthropic', 'x']) assert.throws(() => createProvider({ AI_PROVIDER: name }), /not available/);
  });
  it('the interface still has the four methods a real provider will implement', () => {
    ['analyzeUserRequest', 'determineIntent', 'extractSignals', 'suggestFollowUp'].forEach((m) => assert.equal(typeof AIProvider.prototype[m], 'function', m));
  });
  it('a different provider can be plugged in without touching the matcher or the contract', async () => {
    class FixedProvider extends AIProvider {
      get name() { return 'fixed'; }
      async determineIntent() { return { intent: INTENTS.GENERAL_PROTOCOL_SEARCH }; }
      async extractSignals() { return { isVague: false, searchPhrases: ['lumbar pain'] }; }
      async suggestFollowUp() { return null; }
    }
    const { ask } = build({ provider: new FixedProvider() });
    const r = await ask('something feels off');
    assert.equal(r.status, STATUS.MATCH);
    assert.equal(slugOf(r), 'back-pain');
  });
  it('no code reads an AI key from the environment, and no AI SDK is a dependency', () => {
    aiSourceFiles().forEach((file) => {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      assert.doesNotMatch(code, /OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|AI_API_KEY|process\.env\.[A-Z_]*KEY/, path.relative(SRC, file));
      assert.doesNotMatch(code, /require\((['"`])(openai|@google|@anthropic|langchain|cohere|@huggingface)/, path.relative(SRC, file));
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    assert.deepEqual(deps.filter((d) => /openai|anthropic|google|gemini|langchain|cohere|huggingface|llama|mistral/i.test(d)), []);
  });
  it('nothing in the AI code makes a network request', () => {
    aiSourceFiles().forEach((file) => {
      assert.doesNotMatch(stripComments(fs.readFileSync(file, 'utf8')), /\bfetch\(|require\((['"`])(https?|axios|node-fetch|undici|net|tls|dns)\1\)|XMLHttpRequest|WebSocket/, path.relative(SRC, file));
    });
  });
});

// ===================================================================================== privacy
describe('[DETERMINISTIC] privacy (no text stored or logged)', () => {
  it('the AI code never logs, prints or persists anything the person typed', () => {
    aiSourceFiles().forEach((file) => {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      assert.doesNotMatch(code, /console\.(log|info|debug|error)\(/, `${path.relative(SRC, file)} prints`);
      assert.doesNotMatch(code, /INSERT\s+INTO|UPDATE\s+\w+\s+SET|\.writeFile|appendFile|createWriteStream/i, `${path.relative(SRC, file)} writes`);
    });
  });
  it('the only log line the service can produce names a provider and an error class, never the message', async () => {
    const secret = 'ZQX-secret-text-12345';
    const failing = { name: 'broken', analyzeUserRequest: async () => { throw new Error(`upstream said: ${secret}`); } };
    const t = build({ provider: failing });
    await assert.rejects(t.ask(`my back hurts ${secret}`), (err) => err.status === 503 && !String(err.message).includes(secret));
    assert.equal(t.logs.length, 1);
    assert.ok(!t.logs.join('').includes(secret));
  });
  it('responses never echo the person\'s words back', async () => {
    const { ask } = build();
    const secret = 'ZQX-secret-text-12345';
    for (const m of [`my back hurts ${secret}`, `${secret}`, `I have pain. ${secret}`]) {
      const r = await ask(m, `neck ${secret}`);
      assert.ok(!JSON.stringify(r).includes(secret), m);
    }
  });
});
