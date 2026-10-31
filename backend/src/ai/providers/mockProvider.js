const { AIProvider } = require('./AIProvider');
const { INTENTS, TEXT } = require('../constants');
const { normalizeText, contentTokens, containsPhrase, GENERIC_TERMS, stem } = require('../text');

/**
 * The development provider: deterministic, rule-based, no network, no key, no SDK. It lets the whole assistant flow
 * be built and tested for free, and it is a genuine (if modest) classifier, not a stub that always says yes.
 *
 * What it recognises (English only):
 *   DIRECT_PROTOCOL_REQUEST  "I want the Back Pain protocol" — a request verb plus the word "protocol", or a published
 *                            protocol's name in the message with a request verb / "protocol"
 *   GUIDED_REQUEST           the person says they are unsure ("I don't know which protocol I should use")
 *   GENERAL_PROTOCOL_SEARCH  a concern or condition without either of the above ("Do you have something for back stiffness?")
 *   UNKNOWN                  nothing health-related, no protocol word, no catalogue word ("what's the weather")
 *
 * It never sees or returns protocol ids; it only classifies and reports how specific the request is.
 */

const REQUEST_VERBS = /\b(i want|i would like|id like|show me|open|take me to|find me|find|looking for|im looking for|i need|give me|get me|can i have|can i see)\b/;
const UNCERTAINTY = /\b(not sure|unsure|dont know|do not know|no idea|not certain|cant decide|help me (find|choose|decide|pick)|guide me|confused)\b/;
const CONCERN_QUESTION = /\b(something for|anything for|do you have|is there|are there)\b/;
const GENERAL_CUES = /\b(do you have|is there|are there|any protocol|something for|anything for|protocol for|which protocol|what protocol|looking for something)\b/;

// Words that tell us a message is about the body or how someone feels, so it is not "unrelated" even if no protocol matches.
const HEALTH_WORDS = [
  'back', 'neck', 'shoulder', 'knee', 'hip', 'elbow', 'wrist', 'ankle', 'foot', 'feet', 'leg', 'arm', 'hand', 'finger', 'head', 'jaw',
  'chest', 'stomach', 'abdomen', 'belly', 'throat', 'eye', 'ear', 'skin', 'joint', 'muscle', 'spine', 'headache', 'migraine', 'sciatica',
  'pain', 'ache', 'stiff', 'stiffness', 'sore', 'tension', 'tight', 'tightness', 'numbness', 'tingling', 'swelling', 'cramp', 'fatigue',
  'tired', 'tiredness', 'sleep', 'insomnia', 'stress', 'stressed', 'anxiety', 'anxious', 'nausea', 'dizzy', 'dizziness', 'cough', 'fever',
  'allergy', 'digestion', 'bloating', 'constipation', 'discomfort', 'hurt', 'injury', 'strain', 'sprain', 'unwell', 'sick', 'ill', 'uncomfortable',
].map((w) => stem(w));
const HEALTH_STEMS = new Set(HEALTH_WORDS);

class MockProvider extends AIProvider {
  get name() { return 'mock'; }

  async determineIntent({ message, vocabulary = {} }) {
    const norm = normalizeText(message);
    const tokens = contentTokens(message);
    const hasProtocolWord = /\bprotocols?\b/.test(norm);
    const hasRequestVerb = REQUEST_VERBS.test(norm);
    const names = (vocabulary.protocolNames || []).map(normalizeText).filter(Boolean);
    const nameNamed = names.some((n) => containsPhrase(norm, n)); // a published protocol's name appears in the message
    const bareName = names.some((n) => norm === n || norm === `the ${n}` || norm === `${n} protocol` || norm === `the ${n} protocol`); // the message IS just a name
    const healthHit = tokens.some((t) => HEALTH_STEMS.has(t));
    const catalogueHit = this._catalogueHit(tokens, vocabulary);

    if (UNCERTAINTY.test(norm)) return { intent: INTENTS.GUIDED_REQUEST };
    if (hasRequestVerb && hasProtocolWord) return { intent: INTENTS.DIRECT_PROTOCOL_REQUEST };
    if (!hasProtocolWord && CONCERN_QUESTION.test(norm)) return { intent: INTENTS.GENERAL_PROTOCOL_SEARCH }; // "something for back pain" is a concern, not a named protocol
    if (nameNamed && (hasRequestVerb || hasProtocolWord || bareName)) return { intent: INTENTS.DIRECT_PROTOCOL_REQUEST };
    if (GENERAL_CUES.test(norm) || healthHit || catalogueHit) return { intent: INTENTS.GENERAL_PROTOCOL_SEARCH };
    return { intent: INTENTS.UNKNOWN };
  }

  async extractSignals({ message }) {
    const contentTerms = contentTokens(message);
    const specificTerms = contentTerms.filter((t) => !GENERIC_TERMS.has(t));
    return { isVague: specificTerms.length === 0, searchPhrases: [] };
  }

  async suggestFollowUp({ signals }) {
    // Only a vague request gets the "where / what" question here; the backend supplies the wording for the other reasons.
    return signals && signals.isVague ? TEXT.FOLLOW_UP_VAGUE : TEXT.FOLLOW_UP_WEAK;
  }

  _catalogueHit(tokens, vocabulary) {
    const words = new Set();
    [...(vocabulary.conditionNames || []), ...(vocabulary.searchPhrases || [])].forEach((p) => contentTokens(p).forEach((t) => { if (!GENERIC_TERMS.has(t)) words.add(t); }));
    return tokens.some((t) => words.has(t));
  }
}

module.exports = { MockProvider };
