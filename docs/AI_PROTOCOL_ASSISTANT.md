# AI Protocol Assistant — Stages 1 and 2

A public feature, **OFF by default**, that helps a visitor find a relevant **published** protocol from a sentence of their own.
It is **not** a diagnosis tool and it never invents a protocol.

* **Stage 1** built the foundation and the public page (`/find-protocol`), the provider abstraction and the flag.
* **Stage 2 (this version, ₹0)** makes it much smarter **without any paid AI, SDK or API key**: an administrator switch,
  better natural-language matching driven entirely by protocol metadata, an explicit confidence ladder, safer clarification, a
  strict response contract, and tests for all of it.

```
person's words ──► backend validation ──► AI provider (intent + signals only; untrusted)      ← mock provider today
                                              │
                          published catalogue ──► deterministic matcher (backend-owned ranking)
                                              │
              decide: recommend / ask ONE question / no match
                                              │
        winner re-resolved through the existing public lookup ──► strict response contract (our wording + public fields)
                                              │
                    /protocols/:slug  (the existing public page, PDF and share link)
```

## The one rule

**The doctor's published protocols are always the source of truth.** The interpretation layer may read the person's words; it can never
invent a protocol, a disease or a treatment, diagnose anyone, recommend an unpublished protocol, or write protocol content. The only
thing that can be recommended is a protocol that the public site itself would show right now (`publicProtocols.getDetail`).

## Switching it on and off (admin)

The assistant is controlled by the **existing** `AI_ASSESSMENT` feature flag — there is no second flag system. It is OFF in a fresh
database (code default *and* stored value). Only an administrator can change it:

* **Admin page:** sign in as an admin → Dashboard → **AI Assistant** (`/admin/ai`). It shows **ON / OFF**, with **Enable AI Assistant** /
  **Disable AI Assistant** buttons (each asks for confirmation) and tells the admin if it is on but unusable because the public website
  or protocol browser is off.
* **API (admin session required):**

  | Endpoint | Purpose |
  | --- | --- |
  | `GET /api/admin/ai` | `{ key: "AI_ASSESSMENT", enabled, available, blockedBy }` — `enabled` is the switch; `available` is whether visitors can use it right now |
  | `POST /api/admin/ai/enable` | turn it on (same body back) |
  | `POST /api/admin/ai/disable` | turn it off |

  These sit on `featureFlags.setFlag` (the same service as `npm run flags -- enable AI_ASSESSMENT` and the `requireFlag` middleware).
  They can change **only** `AI_ASSESSMENT` — whatever the request body says — and record the admin as `updated_by`. Anonymous callers get
  `401`; doctors and patients get `403`; nothing changes. The change takes effect on the very next request (no restart, no deploy) and
  survives restarts (it lives in the database). Nothing is migrated: the existing `feature_flags` table is used as it is.
* **Doctors, patients and visitors cannot change it**, and the public side never learns more than "available or not":
  `GET /api/public/ai/status` → `{ "enabled": boolean }`, and the assistant answers `{ "status": "disabled" }` while off.

With the switch OFF, `/find-protocol` shows the existing safe "isn't available right now" page (and the header / home-page links stay
hidden), and every other page and API behaves exactly as before.

## What the visitor sees

`/find-protocol` ("Find a Relevant Protocol"). A text box (500 characters), **Find Protocol**, then one of:

* **Recommended Protocol** — name, short description, "Based on the information you provided, this protocol may be relevant to the
  concern you described.", and the actions the backend listed: **View Protocol** (the existing `/protocols/:slug` page), **Download PDF**
  (the existing published-snapshot PDF) and **Copy Link** (the existing public URL). Nothing new renders a protocol.
* **One clarifying question** (at most one per search) when the request is vague, or when more than one protocol fits about equally.
* **We couldn't find a suitable protocol** + **Try Again** (and a link to browse all protocols).
* A calm error message if the assistant is unavailable, or "isn't available right now" if it is switched off.

Every answer carries: *"This protocol recommendation is not a medical diagnosis. If you have severe, worsening, or concerning symptoms,
seek appropriate medical care."*

## The response contract (`backend/src/ai/responseContract.js`)

`POST /api/public/ai/protocol-assistant` with `{ "message": string (1–500), "followUpAnswer"?: string (1–300) }` answers `200` with
**exactly one** of:

```json
{ "status": "match",
  "protocol": { "slug": "back-pain", "name": "Back Pain", "description": "A gentle routine for the back." },
  "message": "Based on the information you provided, this protocol may be relevant to the concern you described.",
  "actions": [ { "type": "view_protocol", "label": "View Protocol" },
               { "type": "download_pdf",  "label": "Download PDF" },
               { "type": "copy_link",     "label": "Copy Link" } ],
  "disclaimer": "This protocol recommendation is not a medical diagnosis. …" }

{ "status": "clarification", "question": "Which part of the body, or what concern, would you like to find a protocol for?", "disclaimer": "…" }
{ "status": "no_match",      "message": "We couldn't find a published protocol that closely matches the information provided.", "disclaimer": "…" }
{ "status": "disabled" }
```

* Every response is built field by field in one function (`toPublicResponse`) from the backend's own decision plus the published
  protocol's public fields. A provider cannot add HTML, links, ids, protocol content or its own sentences: the two possible `message`
  values and the three questions are constants; the `slug` must be a plain slug and is re-resolved through the public lookup; the
  `description` is plain text capped at 300 characters.
* `actions` carries a fixed **type** and **label** only — never a URL. The page builds the protocol link itself (`/protocols/<slug>`),
  and ignores any action type it does not know.
* **Never exposed:** intent, scores, ranks, evidence tiers, runner-up candidates, internal ids, anything about unpublished protocols, the
  flag's name or state (beyond `disabled`).
* Errors: `400 INVALID_INPUT` (fixed wording, never echoing the input), `503` when the provider is unavailable. Responses are
  `Cache-Control: no-store` and set no cookies. A switched-off assistant answers `200 { "status": "disabled" }` *before* looking at the
  request. *(Stage 1 answered `404` and a different shape; this is the one intentional contract change in Stage 2.)*
* The clarification is stateless: the page sends the **original** message together with the answer; the server remembers nothing.

## Deterministic matching (`backend/src/ai/protocolMatcher.js`, `text.js`)

The catalogue is built **only from published snapshots** (`publicProtocols.listForMatching()`) plus the admin-recorded synonyms of those
protocols' still-active conditions. Nothing in the matcher, the service or the text rules mentions any condition: **the words come only
from the data**, so any doctor-created protocol works the moment it is published, with no JavaScript change.

### Metadata drives matching (what doctors and admins fill in)

| Where | Field | Used as |
| --- | --- | --- |
| Studio → Protocol | name / display name | protocol name |
| Studio → Protocol | conditions | condition names |
| Admin → Conditions | search terms / synonyms | condition synonyms ("lower back pain", "lumbar pain", "back ache") |
| Studio → Protocol | search terms | search terms / phrases ("pain after sitting", "stiff lower back") |
| Studio → Protocol | category, descriptions | weak hint only |

Condition synonyms are read live (an admin edit applies at once; an archived condition contributes none); protocol fields come from the
**published snapshot** (a doctor's later draft edits are invisible until published). To make a new concern findable, add the words people
would use as a search term or a condition synonym — nothing else is needed.

### The evidence ladder

Each protocol gets a score from its best evidence (plus a little for independent agreement). Exact matches are ordered:

1. exact **protocol name** (100)  >  2. exact **condition** (94)  >  3. exact **search term** (90)  >  4. exact **synonym** (86)
5. strong **phrase** match (a phrase contained in the request, or every word of a name/term/condition present in any order)
6. **concept / token** match (below)

A typed exact name wins outright unless another protocol has the identical exact name. Scores are internal and never exposed.

### Natural-language understanding without AI

* **Normalisation** on both sides: case, accents, punctuation, plurals, light stemming ("stiffness"=stiff, "sitting"=sit,
  "tension"=tense), and everyday "pain" words ("hurts", "ache", "discomfort", "sore") treated as one concept.
* **Concept matching.** A request's *identifying* words (not "pain", not describing words like "lower", "after", "area") are compared with
  each protocol's whole vocabulary (name + conditions + synonyms + search terms). **All** of them present → a match, even when spread over
  several phrases ("my back is stiff after sitting" reads "back" from the name and "stiff"/"sit" from search terms). Only some present → at
  most a question, never a recommendation.
* **Typo tolerance** against the catalogue's own words ("lumber" → "lumbar", "shouder" → "shoulder"): one edit (two for 9+ letters), same
  first letter, a single unambiguous closest word; four-letter words only for swapped neighbours. A corrected request ranks just below the
  same request spelt correctly.
* **Weak matches are rejected.** One shared word among unrelated ones, a generic word alone, or one identifying word ("shoulder") against a
  request for a protocol that does not exist ("I want the Shoulder Pain protocol") never recommend: "rocket engines" → *no match*.

### Decision and clarification (never more than one question)

| Evidence | First request | After the one answer |
| --- | --- | --- |
| strong and clearly ahead | recommend | recommend |
| strong, a near-equal exists | ask once ("More than one protocol may be relevant…") | recommend only if the answer separates them, else *no match* |
| weak (related, not clear) | ask once — never for a *named* protocol | recommend if the answer (alone or combined) is clear, else *no match* |
| vague ("I have pain.") | ask "Which part of the body, or what concern, would you like to find a protocol for?" | resolve from the answer ("lower back") or *no match* |
| nothing | *no match* | *no match* |

The answer is judged on its own as well as combined with the first message, so "I have pain in my back or neck" + "neck" picks Neck Pain.
The questions are three fixed, non-diagnostic sentences; there is no chain of medical questions and no second question.

## The provider abstraction (`backend/src/ai/providers/`) — unchanged, ready for a real model

A provider turns free text into **structured signals**. It is given no database and no ids, so it cannot choose a protocol.

```
AIProvider
  analyzeUserRequest(input) -> { intent, signals: { isVague, searchPhrases? }, followUp? }   // default: composes the three below
  determineIntent(input)    -> { intent }
  extractSignals(input)     -> { isVague, searchPhrases? }
  suggestFollowUp(input)    -> string | null
input = { message, vocabulary: { protocolNames, conditionNames, searchPhrases }, followUpAnswered }   // PUBLISHED words only
```

Everything a provider returns is **untrusted** and normalised (`normalizeAnalysis`): an unknown intent becomes `UNKNOWN`; ids, slugs,
recommendations and messages in the answer are dropped; search phrases are limited; a suggested question is used only if it is short,
plain and free of diagnosis wording. **No sentence a provider writes is ever shown as-is.** Selection: `AI_PROVIDER` in the backend
environment (default `mock`); an unavailable name makes *this feature* answer "temporarily unavailable" and can never stop the server.

The development (mock) provider is deterministic, rule-based, English-only, with no network, key or SDK. It classifies direct / guided /
general / unknown requests and reports whether a request is vague. Its list of body and health words only helps it label a request as
health-related; it never selects a protocol.

### Why no API key is needed in this stage

Everything above — the switch, the ranking, typo tolerance, concept matching, clarification, the contract, the safety and privacy rules —
runs inside the backend on the published data. No text leaves the server and nothing is paid for. The code does not read
`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` or `AI_API_KEY`, there is no AI SDK in `package.json`, and a test fails if one
appears. Setting such a variable in the environment changes nothing.

### Connecting a real model later (without redesigning anything)

1. Add one class that extends `AIProvider` (implement `analyzeUserRequest` — or the three small methods) and register it in
   `providers/index.js`. It reads its key from `AI_API_KEY` on the **backend** only (never the browser, never logged) and is selected with
   `AI_PROVIDER=<name>`.
2. Its job is only to return `{ intent, signals: { isVague, searchPhrases }, followUp }`. Good `searchPhrases` (the person's concern
   rephrased in the catalogue's own words) are fed to the same deterministic matcher, so a model can make matching *better* but still
   cannot choose, invent or describe a protocol: the contract, the published-only lookup and the wording constants stay in force.
3. Before turning it on with a paid provider: add **rate limiting** (see limitations), a spending cap and a provider timeout/retry policy,
   send the model only the person's text plus the published vocabulary (never user ids), and re-run the privacy tests with the real
   provider's logging in mind (its SDK must not log request bodies).

## Privacy

* The text is **never stored** (no table, no file, no cache) and **never logged**: the only log line names the provider and the error
  *class*. A provider failure is converted into a fixed, text-free 503 before it can reach the central error handler.
* The text travels only in the POST body — never in a URL or query string. The browser keeps it in page memory only (no localStorage,
  sessionStorage, IndexedDB, cookies or history state). Responses never echo it.
* No external provider exists in this stage, so no user text is sent anywhere. The admin switch stores only the flag value and who changed it.
* Tests prove it at the database level (row counts identical; the text is in no column of any row of any table), at the log level, in the
  browser code, and by scanning the AI source for logging, writes and network calls.

## Medical safety

This is protocol discovery, **not** diagnosis. It never says "You have…", "diagnosed", "this confirms…", "this will cure…" or "you should
definitely use…"; it does not prescribe, claim effectiveness, confirm a condition or advise about medication. It says a protocol "may be
relevant" to what the person described. The disclaimer is on every answer. Wording is constants we wrote; anything a provider could
suggest is screened; tests assert the wording over a corpus of hostile prompts ("cure my back pain", "should I stop my medication").

## Known limitations

* **No rate limiting.** No mechanism exists and the server does not set `trust proxy`, so behind Render's proxy every visitor would look
  like one IP. **Required before a real (paid) provider is connected.** Today each request does bounded work (500 characters).
* English only; the stemmer is deliberately light. Typo tolerance needs 5+ letters (4 for swaps) and a same-letter start.
* No emergency-symptom detection beyond the disclaimer.
* A tie between two protocols after the one question ends in "no match" rather than offering both.
* The matcher rebuilds its catalogue on every request (fine for dozens of protocols; cache when it grows). Quality depends on the
  metadata: a concern with no matching search term, synonym or name will (correctly) find nothing.
* Malformed JSON is rejected (400) by the existing global body parser before the assistant runs.

## Tests

Backend: `ai.text-matcher.test.js` and `ai.provider-service.test.js` (Stage 1: text, matcher, providers, validation, untrusted provider
output, decisions, wording, privacy); `ai.assistant.http.test.js` (real server + database: flag, matching, published-only, snapshot-only,
input, provider failure, privacy, wording, existing site and doctor workflow); **Stage 2:** `ai.stage2.matching.test.js` (natural
language from metadata, no hard-coded conditions, fuzzy matching, the ranking ladder, weak-match rejection, one-question clarification,
published-only, the response contract, safety wording, provider abstraction, no key, privacy), `ai.admin-flag.http.test.js` (the admin
switch: default OFF, admin enable/disable, doctor/patient/anonymous refused, one flag only, public side, restart, nothing else disturbed),
`ai.stage2.http.test.js` (the examples end to end over real admin/doctor-entered metadata). Frontend: `findProtocol.test.mjs` (entry
point, every state, actions, the client and contract normalisation, browser-code privacy), `adminAiSettings.render.test.mjs` (the admin
page and who can reach it).
