/**
 * Shared constants for the AI Protocol Assistant (Stage 1).
 *
 * EVERY sentence the public sees from the assistant lives here, written by us and reviewed once. Nothing a provider
 * returns is ever shown to a user as-is (a provider can only suggest an optional clarifying question, and even that
 * is length-limited and screened — see assistantService.sanitizeFollowUp), so a model can never put diagnosis-style
 * or treatment wording in front of a patient.
 */

/** What kind of request the user made. The set is closed: anything else a provider returns becomes UNKNOWN. */
const INTENTS = Object.freeze({
  DIRECT_PROTOCOL_REQUEST: 'DIRECT_PROTOCOL_REQUEST', // "I want the Back Pain protocol."
  GENERAL_PROTOCOL_SEARCH: 'GENERAL_PROTOCOL_SEARCH', // "Do you have something for back stiffness?"
  GUIDED_REQUEST: 'GUIDED_REQUEST', //                   "I have pain in my lower back but I'm not sure which protocol I need."
  UNKNOWN: 'UNKNOWN', //                                 nothing the catalogue could be about
});

/** What the assistant did about it. */
const OUTCOMES = Object.freeze({
  RECOMMENDATION: 'recommendation',
  FOLLOW_UP: 'follow_up',
  NO_MATCH: 'no_match',
});

const LIMITS = Object.freeze({
  MESSAGE_MAX: 500, //        characters of the user's request
  FOLLOW_UP_ANSWER_MAX: 300, // characters of the answer to our one clarifying question
  FOLLOW_UP_QUESTION_MAX: 200, // characters of a clarifying question a provider may suggest
  VOCABULARY_MAX: 300, //     catalogue terms handed to a provider so it can recognise protocol names
  SEARCH_PHRASES_MAX: 8, //   extra search phrases a provider may suggest
  SEARCH_PHRASE_CHARS_MAX: 80,
  PROVIDER_TIMEOUT_MS: 8000,
});

const TEXT = Object.freeze({
  DISCLAIMER: 'This protocol recommendation is not a medical diagnosis. If you have severe, worsening, or concerning symptoms, seek appropriate medical care.',
  REASON_RELEVANT: 'Based on the information you provided, this protocol may be relevant to the concern you described.',
  REASON_DIRECT: 'Based on the information provided, this is the published protocol that matches the name you gave.',
  NO_MATCH: "We couldn't find a published protocol that closely matches the information provided.",
  FOLLOW_UP_VAGUE: 'Which part of the body, or what concern, would you like to find a protocol for?',
  FOLLOW_UP_AMBIGUOUS: 'More than one protocol may be relevant. Could you tell us a little more about the area or type of concern you are thinking of?',
  FOLLOW_UP_WEAK: 'We could not find a clear match yet. Could you describe the area or type of concern in a few more words?',
  INVALID_INPUT: 'Please enter a request of between 1 and 500 characters.',
  INVALID_ANSWER: 'Please keep your answer to 300 characters or fewer.',
  UNAVAILABLE: 'The protocol assistant is temporarily unavailable. You can still browse all published protocols.',
});

/**
 * Wording the assistant must never produce (applied to anything a provider suggests, and asserted over every
 * response string in the tests). "You have…", "diagnosed", "this confirms…" read as a diagnosis; we only ever say
 * that a protocol "may be relevant" based on what the person told us. The disclaimer is the one sentence allowed
 * to contain the word "diagnosis" (it says there is none).
 */
const FORBIDDEN_WORDING = Object.freeze([
  /\byou (have|are suffering|suffer from|are diagnosed|are experiencing|probably have|likely have)\b/i,
  /\bdiagnos(e|ed|es|ing|is)\b/i,
  /\bthis confirms\b/i,
  /\byou should (use|take|do|try) this\b/i,
  /\bbecause you have\b/i,
  /\b(cure|cures|treat|treats|treatment for)\b/i,
]);

module.exports = { INTENTS, OUTCOMES, LIMITS, TEXT, FORBIDDEN_WORDING };
