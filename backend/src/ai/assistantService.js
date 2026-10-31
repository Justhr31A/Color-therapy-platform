const { badRequest, HttpError } = require('../utils/errors');
const { createCatalogRepository } = require('../repositories/catalog.repo');
const { INTENTS, OUTCOMES, LIMITS, TEXT, FORBIDDEN_WORDING } = require('./constants');
const { rankDetailed, THRESHOLDS } = require('./protocolMatcher');
const { toPublicResponse } = require('./responseContract');
const { normalizeText } = require('./text');

/**
 * The AI Protocol Assistant, Stage 1.
 *
 *   person's words
 *     -> validate (length, type)                         this file
 *     -> provider.analyzeUserRequest()                   providers/*   (an intent + signals; no ids, untrusted)
 *     -> rank the PUBLISHED catalogue                    protocolMatcher.js (deterministic, backend-owned)
 *     -> decide: recommend / ask ONE question / no match this file
 *     -> resolve the winner through the SAME public lookup the public page uses (publicProtocols.getDetail)
 *     -> a response made of our own constants + that published protocol's public fields
 *
 * What this guarantees:
 *   - Only PUBLISHED protocols can ever be returned: the catalogue is built from published snapshots, and the winner
 *     is re-resolved through getDetail() (which answers null for draft / in review / archived / unknown).
 *   - A provider cannot pick or invent a protocol: it never sees ids, and any id-like field it returns is dropped.
 *   - Every sentence in the response is one of our constants (TEXT) — a provider's text is never shown, except one
 *     optional clarifying question that is length-limited and screened for diagnosis-style wording.
 *   - Nothing the person writes is stored, and nothing about it is logged: the only log lines name the provider and
 *     the error CLASS, never the message. (The central error handler logs 5xx errors in full, so provider failures
 *     are converted here into a fixed, text-free error before they reach it.)
 *   - Scores, ranks and runner-up candidates are internal and never part of the response.
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** A string cleaned for processing (control characters and runs of whitespace collapsed), or null if it is not a string. */
function cleanUserText(value) {
  if (typeof value !== 'string') return null;
  return value.slice(0, 2000).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** Validates and cleans a request body. Throws a 400 whose message never contains what the person typed. */
function validateInput(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const message = cleanUserText(b.message);
  if (message === null || message.length < 1 || message.length > LIMITS.MESSAGE_MAX) {
    throw badRequest(TEXT.INVALID_INPUT, { code: 'INVALID_INPUT' });
  }
  let followUpAnswer = null;
  if (b.followUpAnswer !== undefined && b.followUpAnswer !== null && b.followUpAnswer !== '') {
    const answer = cleanUserText(b.followUpAnswer);
    if (answer === null || answer.length < 1 || answer.length > LIMITS.FOLLOW_UP_ANSWER_MAX) {
      throw badRequest(TEXT.INVALID_ANSWER, { code: 'INVALID_INPUT' });
    }
    followUpAnswer = answer;
  }
  return { message, followUpAnswer };
}

/** A provider-suggested clarifying question is used only if it is a short, plain, safely-worded question. */
function sanitizeFollowUp(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 5 || text.length > LIMITS.FOLLOW_UP_QUESTION_MAX) return null;
  if (!text.endsWith('?')) return null;
  if (/[<>]|https?:|www\./i.test(text)) return null;
  if (FORBIDDEN_WORDING.some((re) => re.test(text))) return null;
  return text;
}

/** Treats a provider's answer as untrusted: keep only the fields we know, in a known shape. Everything else (ids, slugs, text) is dropped. */
function normalizeAnalysis(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const signals = r.signals && typeof r.signals === 'object' ? r.signals : {};
  const searchPhrases = Array.isArray(signals.searchPhrases)
    ? signals.searchPhrases
      .filter((s) => typeof s === 'string')
      .map((s) => s.replace(CONTROL_CHARS, ' ').slice(0, LIMITS.SEARCH_PHRASE_CHARS_MAX))
      .filter((s) => normalizeText(s).length > 0)
      .slice(0, LIMITS.SEARCH_PHRASES_MAX)
    : [];
  return {
    intent: Object.values(INTENTS).includes(r.intent) ? r.intent : INTENTS.UNKNOWN,
    isVague: signals.isVague === true,
    searchPhrases,
    followUp: sanitizeFollowUp(r.followUp),
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('provider timed out')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} deps
 *   publicProtocols  the existing public protocol service (adds nothing to what the public can already read)
 *   db               PostgreSQL app database, for condition synonyms (read-only)
 *   getProvider      () => AIProvider — resolved per request so a misconfigured provider fails THIS feature, never server start-up
 *   logger           { warn }  (never given user text)
 *   timeoutMs        provider time limit
 */
function createAssistantService({ publicProtocols, db, getProvider, logger = console, timeoutMs = LIMITS.PROVIDER_TIMEOUT_MS }) {
  const catalog = createCatalogRepository(db);

  /** Published protocols, public fields only, plus the admin-recorded synonyms of their (still active) conditions. */
  async function loadCatalogue() {
    const synonymCache = new Map();
    const synonymsFor = async (slug) => {
      if (!slug) return [];
      if (!synonymCache.has(slug)) {
        let list = [];
        try {
          const row = await catalog.findBySlug('condition', slug);
          if (row && row.is_active) {
            const parsed = JSON.parse(row.synonyms_json || '[]');
            if (Array.isArray(parsed)) list = parsed.filter((s) => typeof s === 'string').slice(0, 30);
          }
        } catch (e) { list = []; }
        synonymCache.set(slug, list);
      }
      return synonymCache.get(slug);
    };
    const out = [];
    for (const d of await publicProtocols.listForMatching()) {
      const conditions = [];
      for (const c of d.conditions) conditions.push({ name: c.name, synonyms: await synonymsFor(c.slug) });
      out.push({
        slug: d.slug,
        name: d.name,
        displayName: d.displayName,
        shortDescription: d.shortDescription,
        description: d.description,
        categoryName: d.category ? d.category.name : null,
        conditions,
        searchTerms: d.searchTerms,
      });
    }
    return out;
  }

  /** The published catalogue's own words, so a provider can recognise that a protocol was named. No ids, no drafts. */
  function vocabularyOf(catalogue) {
    const protocolNames = new Set(); const conditionNames = new Set(); const searchPhrases = new Set();
    catalogue.forEach((p) => {
      [p.displayName, p.name].filter(Boolean).forEach((n) => protocolNames.add(n));
      p.conditions.forEach((c) => { conditionNames.add(c.name); c.synonyms.forEach((s) => searchPhrases.add(s)); });
      p.searchTerms.forEach((t) => searchPhrases.add(t));
    });
    const cap = (set) => [...set].slice(0, LIMITS.VOCABULARY_MAX);
    return { protocolNames: cap(protocolNames), conditionNames: cap(conditionNames), searchPhrases: cap(searchPhrases) };
  }

  async function analyse(message, vocabulary, followUpAnswered) {
    let provider;
    try {
      provider = getProvider();
      const raw = await withTimeout(Promise.resolve(provider.analyzeUserRequest({ message, vocabulary, followUpAnswered })), timeoutMs);
      return normalizeAnalysis(raw);
    } catch (err) {
      // Name the provider and the error CLASS only. Never err.message (a real provider's error can quote its input).
      logger.warn(`[ai] provider "${provider && provider.name ? provider.name : 'unavailable'}" failed (${err && err.name ? err.name : 'Error'}).`);
      throw new HttpError(503, TEXT.UNAVAILABLE, { code: 'AI_UNAVAILABLE' });
    }
  }

  const respondInternal = (intent, outcome, parts = {}) => ({
    intent,
    outcome,
    message: parts.message || null,
    recommendation: parts.recommendation || null,
    followUp: parts.followUp ? { question: parts.followUp } : null,
    disclaimer: TEXT.DISCLAIMER,
  });

  /** Final, authoritative lookup: the same function the public protocol page uses. null = not (or no longer) published. */
  async function resolvePublished(slug) {
    const d = await publicProtocols.getDetail(slug);
    if (!d) return null;
    return {
      slug: d.slug,
      name: d.name,
      displayName: d.displayName,
      // The short description if there is one, otherwise the start of the full description, so a match always has a line of context.
      shortDescription: d.shortDescription || String(d.description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      category: d.category ? { name: d.category.name } : null,
      conditions: d.conditions.map((c) => ({ name: c.name })),
    };
  }

  /** What the evidence says: 'recommend' (with the hit), 'ambiguous' (several fit), 'weak' (related only), or 'none'. */
  function judge(ranked) {
    const [best, second] = ranked;
    const { STRONG, WEAK, AMBIGUITY_MARGIN, AMBIGUITY_FLOOR } = THRESHOLDS;
    if (best && best.score >= STRONG) {
      // The person typed a published protocol's exact name and nothing else is an equally exact name: that is the one asked for.
      if (best.tier === 'name_exact' && !(second && second.tier === 'name_exact')) return { kind: 'recommend', hit: best };
      const ambiguous = second && second.score >= AMBIGUITY_FLOOR && best.score - second.score < AMBIGUITY_MARGIN;
      return ambiguous ? { kind: 'ambiguous', best, second } : { kind: 'recommend', hit: best };
    }
    if (best && best.score >= WEAK) return { kind: 'weak', best, second };
    return { kind: 'none' };
  }

  /**
   * After the ONE clarifying question, the short answer on its own ("neck", "lower back") is the most telling thing the
   * person has said. It may be accepted at a slightly lower bar than a first request — they were asked, and answered —
   * but only when it points at a single protocol clearly ahead of the rest.
   */
  const ANSWER_ACCEPT = 60;
  function judgeAnswerAlone(ranked) {
    const [best, second] = ranked;
    if (!best || best.score < ANSWER_ACCEPT) return null;
    if (second && second.score >= WEAK && best.score - second.score < THRESHOLDS.AMBIGUITY_MARGIN) return null;
    return best;
  }

  /** The assistant's internal decision. Not the public response: see respond(). */
  async function decide({ message, followUpAnswer = null }) {
    const answered = Boolean(followUpAnswer);
    const text = answered ? `${message}. ${followUpAnswer}` : message;

    const catalogue = await loadCatalogue();
    const analysis = await analyse(text, vocabularyOf(catalogue), answered);
    const ranked = rankDetailed([text, ...analysis.searchPhrases], catalogue);
    const verdict = judge(ranked);

    const noMatch = () => respondInternal(analysis.intent, OUTCOMES.NO_MATCH, { message: TEXT.NO_MATCH });
    const ask = (question) => respondInternal(analysis.intent, OUTCOMES.FOLLOW_UP, { followUp: question });
    const recommend = async (hit) => {
      const recommendation = await resolvePublished(hit.slug);
      if (!recommendation) return noMatch(); // unpublished a moment ago: never show it
      // The backend, not the provider, has the last word on the label: a strong catalogue match is never "UNKNOWN".
      const intent = analysis.intent === INTENTS.UNKNOWN ? INTENTS.GENERAL_PROTOCOL_SEARCH : analysis.intent;
      const reason = intent === INTENTS.DIRECT_PROTOCOL_REQUEST && hit.field === 'name' ? TEXT.REASON_DIRECT : TEXT.REASON_RELEVANT;
      return respondInternal(intent, OUTCOMES.RECOMMENDATION, { message: reason, recommendation });
    };

    if (verdict.kind === 'recommend') return recommend(verdict.hit);

    if (answered) {
      // Asked once already: resolve from the answer, or decline. Never a second question, never a guess between near-equals.
      const alone = judgeAnswerAlone(rankDetailed([followUpAnswer], catalogue));
      if (alone) return recommend(alone);
      return noMatch(); // still a tie after the one question: never guess between near-equals
    }

    if (verdict.kind === 'ambiguous') return ask(TEXT.FOLLOW_UP_AMBIGUOUS);
    if (verdict.kind === 'weak') {
      // Related, not clearly relevant. Ask once (never for a named protocol — we do not guess at those).
      if (analysis.intent !== INTENTS.UNKNOWN && analysis.intent !== INTENTS.DIRECT_PROTOCOL_REQUEST) return ask(analysis.followUp || TEXT.FOLLOW_UP_WEAK);
      return noMatch();
    }
    if (analysis.isVague && analysis.intent !== INTENTS.UNKNOWN) return ask(analysis.followUp || TEXT.FOLLOW_UP_VAGUE);
    return noMatch();
  }

  return {
    validateInput,

    /** The internal decision ({ intent, outcome, ... }). Kept for the backend's own tests; the public route uses respond(). */
    handle: decide,

    /** What the public receives: the strict contract in responseContract.js (status match | clarification | no_match). */
    async respond(input) {
      return toPublicResponse(await decide(input));
    },
  };
}

module.exports = { createAssistantService, validateInput, sanitizeFollowUp, normalizeAnalysis, cleanUserText };
