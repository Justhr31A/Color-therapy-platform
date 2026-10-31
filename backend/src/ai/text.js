/**
 * Small, pure text helpers for matching a person's words against protocol names, conditions and search terms.
 * English only in Stage 1 (other scripts normalise to nothing and simply find no match).
 *
 * Words are normalised the same way on BOTH sides (the user's request and the catalogue's own text), so
 * "Back Pain", "back-pain", "BACK  PAIN" and "backpain?" style variations meet in the middle, and
 * "stiffness"/"stiff", "aches"/"ache" and "migraines"/"migraine" compare equal after light stemming.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'you', 'your', 'it', 'its', 'im', 'ive', 'id', 'ill',
  'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'dont', 'doesnt', 'didnt', 'cant', 'wont',
  'have', 'has', 'had', 'having', 'want', 'wants', 'wanted', 'need', 'needs', 'needed', 'looking', 'look', 'find', 'show',
  'give', 'get', 'got', 'take', 'open', 'see', 'tell', 'like', 'would', 'could', 'should', 'can', 'will', 'shall', 'may', 'might',
  'to', 'of', 'for', 'in', 'on', 'at', 'with', 'about', 'around', 'from', 'into', 'by', 'and', 'or', 'but', 'so', 'if', 'when', 'while',
  'that', 'this', 'these', 'those', 'which', 'what', 'who', 'how', 'there', 'any', 'some', 'something', 'anything', 'one', 'ones',
  'protocol', 'protocols', 'relevant', 'suitable', 'right', 'best', 'use', 'using', 'used', 'know', 'sure', 'unsure', 'please', 'help',
  'also', 'just', 'much', 'more', 'than', 'very', 'really', 'quite', 'bit', 'little', 'lately', 'recently', 'since', 'been',
  'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'few', 'couple', 'not', 'no', 'yes', 'ok', 'okay',
  'here', 'now', 'then', 'too', 'still', 'again', 'always', 'sometimes', 'often', 'maybe', 'perhaps',
]);

// Everyday ways of saying "pain" are treated as one concept, so "discomfort around my lower back" meets "Back Pain".
const PAIN_WORDS = new Set(['pain', 'pains', 'painful', 'ache', 'aches', 'aching', 'achy', 'discomfort', 'hurt', 'hurts', 'hurting', 'sore', 'soreness']);

// Tokens (already stemmed) too generic to identify a protocol on their own: "pain" alone must not match "Back Pain".
const GENERIC_TERMS = new Set(['pain', 'problem', 'issue', 'feel', 'symptom', 'trouble', 'bad', 'unwell', 'sick', 'uncomfortable', 'thing']);

// Words that narrow or describe a request without naming what it is about ("lower back", "after sitting", "a sharp pain").
// They never count for or against a protocol; "lower back" is about "back". General English, not tied to any condition.
const QUALIFIERS = new Set([
  'lower', 'upper', 'left', 'right', 'middle', 'mid', 'side', 'front', 'top', 'bottom', 'inner', 'outer', 'deep', 'whole', 'entire',
  'mild', 'moderate', 'severe', 'slight', 'sharp', 'dull', 'constant', 'chronic', 'acute', 'sudden', 'general', 'overall',
  'after', 'before', 'during', 'because', 'without', 'within', 'every', 'each', 'all', 'both', 'other', 'another', 'long', 'area', 'region', 'part', 'spot', 'place',
  'go', 'going', 'goes', 'get', 'feeling', 'feel', 'feels', 'felt', 'seem', 'seems', 'start', 'started', 'starts', 'wake', 'woke',
].map((w) => stem(w)));

/** Lower-case ASCII words separated by single spaces: accents removed, apostrophes dropped, punctuation turned into spaces. */
function normalizeText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019`]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "sitt" -> "sit", "stopp" -> "stop": the doubled consonant that -ing / -ed adds, so "sitting" and "sit" agree. (ll/ss/ff/zz stay: "stiff", "pass".) */
function undouble(t) {
  return t.length > 3 && /([bdgmnprt])\1$/.test(t) ? t.slice(0, -1) : t;
}

/** Light, consistent stemming — good enough to make plural / -ness / -ing forms meet; it is not linguistics. */
function stem(token) {
  let t = token;
  if (t.length <= 3) return t;
  if (t.endsWith('ies') && t.length > 4) t = `${t.slice(0, -3)}y`;
  else if (t.endsWith('sses')) t = t.slice(0, -2);
  else if (t.endsWith('ness') && t.length > 6) t = t.slice(0, -4);
  else if (t.endsWith('ing') && t.length > 5) t = undouble(t.slice(0, -3));
  else if (t.endsWith('ed') && t.length > 4) t = undouble(t.slice(0, -2));
  else if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) t = t.slice(0, -1);
  if (t.endsWith('ion') && t.length > 6) t = t.slice(0, -3); // tension/tense, infection/infect
  if (t.endsWith('e') && t.length > 4) t = t.slice(0, -1); // ache/aches, migraine/migraines, stiffene/stiffen all agree
  return t;
}

/** The meaningful words of a text: stop-words dropped, pain-words unified, the rest stemmed, duplicates removed (order kept). */
function contentTokens(value) {
  const out = [];
  for (const raw of normalizeText(value).split(' ')) {
    if (!raw || STOPWORDS.has(raw)) continue;
    const t = PAIN_WORDS.has(raw) ? 'pain' : stem(raw);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** True when `needle` occurs in `haystack` as whole words (both already normalised). */
function containsPhrase(haystack, needle) {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

/** A phrase prepared for comparison: its meaningful tokens and the tokens joined back into one comparable string. */
function phraseInfo(value) {
  const tokens = contentTokens(value);
  return { tokens, phrase: tokens.join(' ') };
}

/**
 * Optimal-string-alignment distance (insert / delete / substitute / swap two neighbours), or Infinity once it must
 * exceed `max`. Small inputs only (single words).
 */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  const rows = [];
  for (let i = 0; i <= a.length; i += 1) { rows.push(new Array(b.length + 1).fill(0)); rows[i][0] = i; }
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2][j - 2] + 1);
      rows[i][j] = d;
    }
  }
  return rows[a.length][b.length] <= max ? rows[a.length][b.length] : Infinity;
}

/**
 * Typo tolerance against the catalogue's OWN words. A request word the catalogue does not contain is replaced by the
 * single closest catalogue word when that is clearly a misspelling of it:
 *   - at least 5 letters (4 only for two swapped neighbours: "bakc" -> "back"), the same first letter,
 *   - 1 edit away (2 edits for words of 9+ letters),
 *   - and exactly one best candidate (a tie is left alone rather than guessed).
 * Words that are already in the catalogue, generic words and short words are never changed.
 * @returns {{ tokens: string[], corrected: number }}
 */
function snapToLexicon(tokens, lexicon) {
  let corrected = 0;
  const out = tokens.map((t) => {
    if (lexicon.has(t) || GENERIC_TERMS.has(t) || t.length < 4) return t;
    const max = t.length >= 9 ? 2 : 1;
    let best = Infinity; let pick = null; let tie = false;
    for (const w of lexicon) {
      if (w[0] !== t[0] || w === t) continue;
      const d = editDistance(t, w, max);
      if (d === Infinity) continue;
      if (t.length === 4 && !(d === 1 && w.length === 4 && [...t].sort().join('') === [...w].sort().join(''))) continue; // 4 letters: swaps only
      if (d < best) { best = d; pick = w; tie = false; } else if (d === best && w !== pick) tie = true;
    }
    if (pick && !tie) { corrected += 1; return pick; }
    return t;
  });
  return { tokens: out, corrected };
}

module.exports = { STOPWORDS, GENERIC_TERMS, QUALIFIERS, normalizeText, stem, contentTokens, containsPhrase, phraseInfo, editDistance, snapToLexicon };
