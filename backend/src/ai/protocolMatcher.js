const { phraseInfo, containsPhrase, GENERIC_TERMS, QUALIFIERS, contentTokens, snapToLexicon } = require('./text');

/**
 * The deterministic, backend-owned matcher: given the person's words and the PUBLISHED catalogue, rank the protocols.
 *
 * No randomness, no model, no network: the same input always gives the same ranking. It never sees a draft (the
 * catalogue it is handed is built only from published snapshots — see assistantService.loadCatalogue), and it cannot
 * return anything that is not in that catalogue, so a protocol can never be invented.
 *
 * How a protocol scores. The request and each piece of protocol text are reduced to their meaningful words (see
 * text.js), then compared field by field:
 *
 *   protocol name / display name   the user typed the name, or a name's words, or most of them
 *   search terms                   the curated phrases doctors/admins attach to a protocol
 *   condition names                the conditions linked to the protocol when it was published
 *   condition synonyms             alternative names an admin recorded for those conditions
 *   category name                  a weak hint only
 *   descriptions                   a weak hint only (a few shared meaningful words)
 *
 * Within a field the best-matching phrase counts. Strong evidence is an exact phrase, a phrase contained in the other,
 * or every word of a multi-word name/term appearing in the request in any order ("discomfort around my lower back"
 * meets "Back Pain"). A single generic word ("pain", "problem") never identifies a protocol on its own. The fields
 * are then combined: the best field dominates and others add a little, so independent agreement (a name AND a
 * condition) ranks above one weak signal. The numbers below are internal; they are never exposed to the public.
 *
 * Stage 2 adds, still with no model and no network:
 *   - an explicit evidence ladder for EXACT matches: protocol name > condition > search term > condition synonym
 *     (each exact tier outranks every looser match of the next tier down);
 *   - typo tolerance against the catalogue's own words ("lumber" meets "lumbar", "shoulde" meets "shoulder");
 *   - a "concept" signal that reads a protocol's whole vocabulary (name, conditions, synonyms, search terms) so a
 *     request whose meaningful words all appear in that vocabulary, even spread over several phrases, matches — while
 *     a request that only shares one word among several unrelated ones does not. A word that appears in the
 *     vocabulary of only one published protocol is more telling than one shared by several.
 * Nothing here is specific to any condition: the words come from the published protocols themselves, so a new
 * protocol, condition, synonym or search term is matched the moment it is published, with no code change.
 */

const THRESHOLDS = Object.freeze({
  STRONG: 70, //          a clearly relevant protocol
  WEAK: 30, //            related at best — never recommended on its own
  AMBIGUITY_MARGIN: 12, // a runner-up this close to the leader (and itself strong enough) means "more than one fits"
  AMBIGUITY_FLOOR: 60,
});

// Exact tiers are deliberately spaced: name 100 > condition 94 > search term 90 > synonym 86, and no non-exact score
// of a higher tier (e.g. a name merely contained in the request, 90) is allowed to look like a lower tier's exact match.
const WEIGHTS = Object.freeze({
  name: { exact: 100, contained: 90, queryIn: 70, allTokens: 80, querySubset: 70, singleLong: 60, singleShort: 0, partialMax: 40 },
  condition: { exact: 94, contained: 84, queryIn: 74, allTokens: 80, querySubset: 74, singleLong: 72, singleShort: 52, partialMax: 28 },
  term: { exact: 90, contained: 82, queryIn: 76, allTokens: 80, querySubset: 76, singleLong: 72, singleShort: 55, partialMax: 30 },
  synonym: { exact: 86, contained: 80, queryIn: 75, allTokens: 78, querySubset: 75, singleLong: 72, singleShort: 54, partialMax: 28 },
});
// The "concept" signal (see conceptScore). Full coverage of the request's meaningful words by a protocol's vocabulary:
// A single shared word is never enough to recommend (it stays in the "weak" band and, at most, earns the one clarifying
// question): "shoulder" appearing in "Neck & Shoulder Relief" must not answer a request for a "Shoulder Pain protocol".
const CONCEPT = Object.freeze({ MULTI: 78, SINGLE_UNIQUE: 64, SINGLE_UNIQUE_SHORT: 56, SINGLE_SHARED: 50, PARTIAL: 55, TRACE_MAX: 25 });
const FUZZY_PENALTY = 4; // a request that needed a spelling correction ranks just under the same request spelt correctly
const CATEGORY_HINT = 20;
const DESCRIPTION_PER_WORD = 5;
const DESCRIPTION_MAX = 20;

/** Score of one request against one candidate phrase, using a field's weights. 0 = unrelated. */
function phraseScore(q, c, w) {
  if (!c.tokens.length || !q.tokens.length) return 0;
  if (q.phrase === c.phrase) return w.exact;
  const qSet = new Set(q.tokens);
  const cSet = new Set(c.tokens);
  const candidateInQuery = c.tokens.every((t) => qSet.has(t)); // every word of the candidate is in the request (any order)
  const queryInCandidate = q.tokens.every((t) => cSet.has(t)); // every word of the request is in the candidate

  if (c.tokens.length === 1) {
    if (!candidateInQuery) return 0;
    const t = c.tokens[0];
    if (GENERIC_TERMS.has(t)) return 0;
    if (t.length >= 5) return w.singleLong;
    return t.length >= 4 ? w.singleShort : 0;
  }
  if (candidateInQuery) return containsPhrase(q.phrase, c.phrase) ? w.contained : w.allTokens;
  if (queryInCandidate && q.tokens.length >= 2) return containsPhrase(c.phrase, q.phrase) ? w.queryIn : w.querySubset;
  if (queryInCandidate && q.tokens.length === 1) {
    const t = q.tokens[0];
    if (GENERIC_TERMS.has(t)) return 0;
    if (t.length >= 5) return Math.round(w.singleLong * 0.9);
    return t.length >= 4 ? Math.round(w.singleShort * 0.9) : 0;
  }
  const shared = c.tokens.filter((t) => qSet.has(t) && !GENERIC_TERMS.has(t)).length;
  return shared > 0 ? Math.round((w.partialMax * shared) / Math.max(c.tokens.length, q.tokens.length)) : 0;
}

const bestOf = (q, candidates, w) => candidates.reduce((m, c) => Math.max(m, phraseScore(q, c, w)), 0);

/** One published protocol (public fields only) prepared for matching. */
function prepareEntry(p) {
  const nameTexts = [...new Set([p.displayName, p.name].filter(Boolean))];
  return {
    slug: p.slug,
    names: nameTexts.map(phraseInfo),
    terms: (p.searchTerms || []).map((t) => phraseInfo(typeof t === 'string' ? t : t && t.term)),
    conditions: (p.conditions || []).map((c) => phraseInfo(c.name)),
    synonyms: (p.conditions || []).flatMap((c) => (c.synonyms || []).map(phraseInfo)),
    category: p.categoryName ? phraseInfo(p.categoryName) : null,
    vocab: new Set(),
    descriptionTokens: new Set(contentTokens(`${p.shortDescription || ''} ${p.description || ''}`).filter((t) => !GENERIC_TERMS.has(t))),
  };
}

/** A protocol's identifying vocabulary: the meaningful words of its names, conditions, synonyms and search terms (never its description). */
function withVocabulary(entry) {
  const phrases = [...entry.names, ...entry.terms, ...entry.conditions, ...entry.synonyms];
  phrases.forEach((p) => p.tokens.forEach((t) => { if (!GENERIC_TERMS.has(t) && !QUALIFIERS.has(t) && t.length >= 3) entry.vocab.add(t); }));
  return entry;
}

/**
 * How well does the request, read as a bag of meaningful words, fit a protocol's whole vocabulary?
 * Only the words that identify something count (generic words like "pain" and describing words like "lower" or
 * "after" are skipped on the request side). Full coverage matches; partial coverage is never enough to recommend.
 * `docFreq` counts, for each word, how many published protocols have it in their vocabulary.
 */
function conceptScore(q, entry, docFreq) {
  const informative = q.tokens.filter((t) => !GENERIC_TERMS.has(t) && !QUALIFIERS.has(t) && t.length >= 3);
  if (!informative.length) return 0;
  const matched = informative.filter((t) => entry.vocab.has(t));
  if (!matched.length) return 0;
  if (matched.length === informative.length) {
    if (matched.length >= 2) return CONCEPT.MULTI;
    const t = matched[0];
    const unique = (docFreq.get(t) || 0) === 1;
    if (unique && t.length >= 4) return CONCEPT.SINGLE_UNIQUE;
    if (unique) return CONCEPT.SINGLE_UNIQUE_SHORT;
    return t.length >= 4 ? CONCEPT.SINGLE_SHARED : 0;
  }
  if (matched.length >= 2 && matched.length / informative.length >= 0.5) return CONCEPT.PARTIAL;
  return Math.min(CONCEPT.TRACE_MAX, 10 + 5 * matched.length);
}

const EXACT_TIERS = Object.freeze({ name: 'name_exact', condition: 'condition_exact', term: 'term_exact', synonym: 'synonym_exact' });

function scoreEntry(q, e, docFreq = new Map()) {
  const fields = {
    name: bestOf(q, e.names, WEIGHTS.name),
    condition: bestOf(q, e.conditions, WEIGHTS.condition),
    term: bestOf(q, e.terms, WEIGHTS.term),
    synonym: bestOf(q, e.synonyms, WEIGHTS.synonym),
    category: e.category && e.category.tokens.length && e.category.tokens.every((t) => q.tokens.includes(t)) ? CATEGORY_HINT : 0,
    description: Math.min(DESCRIPTION_MAX, DESCRIPTION_PER_WORD * q.tokens.filter((t) => !GENERIC_TERMS.has(t) && e.descriptionTokens.has(t)).length),
  };
  const ordered = Object.entries(fields).sort((a, b) => b[1] - a[1]);
  const phrasal = ordered[0][1] + 0.35 * ordered[1][1] + 0.15 * ordered[2][1];
  const concept = conceptScore(q, e, docFreq);
  const useConcept = concept > phrasal;
  const penalty = q.corrected ? FUZZY_PENALTY : 0;
  const score = Math.max(0, (useConcept ? concept : phrasal) - penalty);

  let tier = 'none';
  let field = null;
  if (useConcept) { tier = 'concept'; field = 'concept'; } else if (ordered[0][1] > 0) {
    [field] = ordered[0];
    const exactWeight = WEIGHTS[field] && WEIGHTS[field].exact;
    if (exactWeight !== undefined && ordered[0][1] === exactWeight && !q.corrected) tier = EXACT_TIERS[field];
    else tier = ordered[0][1] >= THRESHOLDS.STRONG ? 'phrase' : 'token';
  }
  return { score: Math.round(score * 10) / 10, field, tier };
}

/**
 * @param {string[]} queries   the person's words (and any extra search phrases a provider suggested); a protocol's score is its best over these
 * @param {object[]} catalogue published protocols, each { slug, name, displayName, shortDescription, description, categoryName, conditions: [{ name, synonyms }], searchTerms }
 * @param {number} [limit]
 * @returns {{ slug: string, score: number, field: string|null }[]} best first; ties broken by name then slug so the order is stable
 */
function rank(queries, catalogue, limit = 5) {
  return rankDetailed(queries, catalogue, limit).map(({ slug, score, field }) => ({ slug, score, field }));
}

/** Like rank(), plus the kind of evidence behind each score (`tier`): name_exact | condition_exact | term_exact | synonym_exact | phrase | concept | token. Internal use only. */
function rankDetailed(queries, catalogue, limit = 5) {
  const rawQueries = queries.map(phraseInfo).filter((q) => q.tokens.length > 0);
  if (!rawQueries.length) return [];
  const entries = catalogue.map((raw) => ({ raw, entry: withVocabulary(prepareEntry(raw)) }));

  // The catalogue's own words: what a misspelt request word can be corrected to, and how common each word is.
  const lexicon = new Set();
  const docFreq = new Map();
  entries.forEach(({ entry }) => {
    entry.vocab.forEach((t) => { lexicon.add(t); docFreq.set(t, (docFreq.get(t) || 0) + 1); });
    // Generic words ("pain") are not identifying, but a misspelling of one ("pian") should still be recognised as that word.
    [...entry.names, ...entry.terms, ...entry.conditions, ...entry.synonyms].forEach((p) => p.tokens.forEach((t) => { if (t.length >= 4) lexicon.add(t); }));
  });
  const qs = rawQueries.map((q) => {
    const { tokens, corrected } = snapToLexicon(q.tokens, lexicon);
    return corrected ? { tokens, phrase: tokens.join(' '), corrected } : { ...q, corrected: 0 };
  });

  const results = [];
  for (const { raw, entry } of entries) {
    let best = { score: 0, field: null, tier: 'none' };
    for (const q of qs) {
      const s = scoreEntry(q, entry, docFreq);
      if (s.score > best.score) best = s;
    }
    if (best.score > 0) results.push({ slug: raw.slug, sortName: String(raw.displayName || raw.name || '').toLowerCase(), ...best });
  }
  results.sort((a, b) => b.score - a.score || (a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0) || (a.slug < b.slug ? -1 : 1));
  return results.slice(0, limit).map(({ slug, score, field, tier }) => ({ slug, score, field, tier }));
}

module.exports = { rank, rankDetailed, THRESHOLDS, WEIGHTS, CONCEPT, phraseScore, prepareEntry, scoreEntry, conceptScore, withVocabulary };
