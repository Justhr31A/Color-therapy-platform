/**
 * The AI provider interface (Stage 1: an abstraction plus a development provider; a real model plugs in later).
 *
 * A provider turns the person's free text into STRUCTURED SIGNALS. That is all it does. It is deliberately given no
 * database, no protocol ids and no way to choose a protocol: the backend owns the lookup (see protocolMatcher.js and
 * assistantService.js), and treats everything a provider returns as untrusted input that is validated before use.
 *
 * Input every method receives:
 *   {
 *     message:      the person's request (already length-limited and cleaned; for a follow-up turn it is the
 *                   original request followed by the answer),
 *     vocabulary:   { protocolNames: string[], conditionNames: string[], searchPhrases: string[] } — PUBLISHED catalogue
 *                   words only, so a provider can recognise that someone named a protocol. Never ids, never drafts,
 *     followUpAnswered: boolean — true when the one clarifying question has already been asked and answered
 *   }
 *
 * What a provider returns (analyzeUserRequest):
 *   {
 *     intent:  one of INTENTS (anything else is treated as UNKNOWN),
 *     signals: { isVague: boolean, searchPhrases?: string[] }   // searchPhrases = optional extra words to SEARCH with
 *     followUp: string | null                                    // an optional clarifying question
 *   }
 * Any other field (for example a protocol id or slug) is ignored: it cannot influence which protocol is returned.
 *
 * To add a real model: subclass AIProvider, override `analyzeUserRequest` (one call is cheapest) or the three
 * smaller methods, register it in providers/index.js, and set AI_PROVIDER / AI_API_KEY on the BACKEND only.
 */
class AIProvider {
  /** Short stable name used in logs (never the key, never user text). */
  get name() { return 'abstract'; }

  /** @returns {Promise<{ intent: string }>} */
  async determineIntent(input) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.name}: determineIntent() is not implemented`);
  }

  /** @returns {Promise<{ isVague: boolean, searchPhrases?: string[] }>} */
  async extractSignals(input) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.name}: extractSignals() is not implemented`);
  }

  /** @returns {Promise<string|null>} one short clarifying question, or null */
  async suggestFollowUp(input) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.name}: suggestFollowUp() is not implemented`);
  }

  /**
   * Everything in one go. The default composes the three methods above; a real model usually overrides this with a
   * single request that returns all three parts.
   */
  async analyzeUserRequest(input) {
    const { intent } = await this.determineIntent(input);
    const signals = await this.extractSignals({ ...input, intent });
    const followUp = await this.suggestFollowUp({ ...input, intent, signals });
    return { intent, signals, followUp };
  }
}

module.exports = { AIProvider };
