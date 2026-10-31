const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { HAND_ASSETS, HAND_VIEW_ORDER } = require('../config/handAssets');
const { ORGAN_ASSETS } = require('../config/organAssets');

const router = express.Router();

router.use(requireAuth);

router.get('/hands', (req, res) => {
  const list = HAND_VIEW_ORDER.map((key) => {
    const a = HAND_ASSETS[key];
    return { ...a, url: `/static/hands/${a.file}` };
  });
  res.json(list);
});

router.get('/organs', (req, res) => {
  const list = Object.values(ORGAN_ASSETS).map((a) => ({ ...a, url: `/static/organs/${a.file}` }));
  res.json(list);
});

module.exports = router;
