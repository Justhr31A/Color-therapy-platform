'use strict';

const express = require('express');
const db = require('../db');
const asyncRoute = require('../utils/asyncRoute');
const { createFeatureFlagService } = require('../services/featureFlags');
const { createPublicProtocolService } = require('../services/publicProtocols');
const { createProvider } = require('../ai/providers');
const { createAssistantService } = require('../ai/assistantService');
const { disabledResponse } = require('../ai/responseContract');

/**
 * PUBLIC AI Protocol Assistant (Stage 2). No login. Mounted at /api/public/ai.
 *
 *   GET  /status               { enabled: boolean } — always 200, so the website can decide whether to show the entry
 *                              point. It reveals nothing but that one boolean.
 *   POST /protocol-assistant   { message, followUpAnswer? } -> exactly one of (see ai/responseContract.js)
 *                                { status: 'match', protocol: { slug, name, description }, message, actions, disclaimer }
 *                                { status: 'clarification', question, disclaimer }
 *                                { status: 'no_match', message, disclaimer }
 *                                { status: 'disabled' }
 *
 * The assistant is OFF unless an administrator turns the AI_ASSESSMENT feature flag on (it is off by default; see
 * admin.ai.routes.js). It also needs the public website and protocol browser to be on, because everything it can
 * return is a published protocol shown on those pages. When off, POST answers 200 { status: 'disabled' } BEFORE it
 * looks at the request, so a switched-off assistant neither reads nor reacts to what was sent, and says nothing about
 * why it is off (the same single fact GET /status already gives).
 *
 * Privacy: the person's words travel only in the POST body (never in a URL, so never in an access log). They are
 * processed and returned — not stored, not logged. Responses are marked no-store.
 */
const router = express.Router();
const flags = createFeatureFlagService(db);
const publicProtocols = createPublicProtocolService(db);

// The provider is chosen from the backend environment on first use and kept once it works. A bad AI_PROVIDER makes
// THIS feature answer "unavailable"; it can never stop the server from starting or break any other page.
let provider = null;
const getProvider = () => {
  if (!provider) provider = createProvider(process.env);
  return provider;
};
const assistant = createAssistantService({ publicProtocols, db, getProvider });

const assistantEnabled = async () => (await flags.areEnabled(['WEBSITE', 'PROTOCOL_BROWSER', 'AI_ASSESSMENT'])).every(Boolean);

router.get('/status', asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ enabled: await assistantEnabled() });
}));

router.post('/protocol-assistant', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!(await assistantEnabled())) return res.json(disabledResponse());
    const input = assistant.validateInput(req.body);
    return res.json(await assistant.respond(input));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
