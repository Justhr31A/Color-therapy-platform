const path = require('path');
// Anchored to this file's own directory (backend/), not to process.cwd(). dotenv's default looks for
// `.env` relative to the current working directory, which is only backend/ if the process happens to be
// started from there; started any other way (repo root, an IDE run config, a different shell), it would
// silently find no file and leave JWT_SECRET (and everything else in .env) unset with no error, only
// surfacing later as "secretOrPrivateKey must have a value" the first time a token is signed.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

// PostgreSQL only. Nothing here (or anywhere in the runtime) opens SQLite; there is no fallback database.
// The connection is proven and migrations applied in start() below, BEFORE the server accepts requests.
const db = require('./db');

const authRoutes = require('./routes/auth.routes');
const protocolRoutes = require('./routes/protocols.routes');
const assetRoutes = require('./routes/assets.routes');
const patientRoutes = require('./routes/patient.routes');
const publicRoutes = require('./routes/public.routes');
const publicAiRoutes = require('./routes/public.ai.routes');
const publicPaymentRoutes = require('./routes/public.payments.routes');
const publicCameraRoutes = require('./routes/public.camera.routes');
const catalogRoutes = require('./routes/catalog.routes');
const adminAiRoutes = require('./routes/admin.ai.routes');
const adminCameraRoutes = require('./routes/admin.camera.routes');
const adminPaymentRoutes = require('./routes/admin.payments.routes');
const adminCategoryRoutes = require('./routes/admin.categories.routes');
const adminConditionRoutes = require('./routes/admin.conditions.routes');
const adminProtocolRoutes = require('./routes/admin.protocols.routes');

const app = express();
const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',');

app.use(morgan('dev'));
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

// Static hand/organ diagram assets. These are the exact provided reference
// images (cropped from the supplied sheet) — served read-only, never edited
// by the app itself.
app.use('/static/hands', express.static(path.join(__dirname, '..', 'assets', 'hands')));
app.use('/static/organs', express.static(path.join(__dirname, '..', 'assets', 'organs')));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'colour-therapy-backend' }));

app.use('/api/auth', authRoutes);
app.use('/api/protocols', protocolRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/patient', patientRoutes);
app.use('/api/catalog', catalogRoutes); // read-only categories/conditions for the Studio (doctor or admin)
app.use('/api/public/ai', publicAiRoutes); // AI Protocol Assistant (off by default: AI_ASSESSMENT flag)
app.use('/api/public/camera', publicCameraRoutes); // is the public Camera (live AR) view switched on? (off by default: CAMERA + AR flags)
app.use('/api/public', publicPaymentRoutes); // free-launch protocol access (payment-ready; no gateway, no charge)
app.use('/api/public', publicRoutes); // read-only, no login, published protocols only
app.use('/api/admin/ai', adminAiRoutes); // admin-only on/off switch for the AI Protocol Assistant (AI_ASSESSMENT)
app.use('/api/admin/camera', adminCameraRoutes); // admin-only on/off switch for the public Camera view (CAMERA + AR)
app.use('/api/admin/payments', adminPaymentRoutes); // admin-only payment-access settings (FREE/PAID mode)
app.use('/api/admin/categories', adminCategoryRoutes);
app.use('/api/admin/conditions', adminConditionRoutes);
app.use('/api/admin/protocols', adminProtocolRoutes);

// 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // A PostgreSQL "data exception" (class 22: a value of the wrong type or out of range that slipped past
  // validation) is the caller's input, not a server fault. SQLite stored such values loosely instead.
  if (!err.status && typeof err.code === 'string' && err.code.startsWith('22') && err.code.length === 5) {
    return res.status(400).json({ error: 'A value in the request is not valid.', code: 'INVALID_INPUT' });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  // Errors that carry an HTTP status (validation, not-found, conflict, ...) are safe to describe to the caller.
  // An unexpected failure (no status) never leaks its internal message.
  const body = { error: err.status ? err.message : 'Internal server error.' };
  if (status < 500) {
    if (err.code) body.code = err.code;
    if (err.details) body.details = err.details;
  }
  res.status(status).json(body);
});

async function start() {
  try {
    await db.initDatabase();
  } catch (err) {
    // Never start without the database, and never fall back to another one.
    console.error(`[startup] PostgreSQL is not available: ${err && err.message ? err.message : err}`);
    await db.close().catch(() => {});
    process.exit(1);
  }
  const server = app.listen(PORT, () => {
    console.log(`Colour Therapy Protocol backend listening on http://localhost:${PORT}`);
  });
  const shutdown = (signal) => {
    console.log(`[shutdown] ${signal} received, closing.`);
    server.close(() => {
      db.close().catch(() => {}).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) start();

module.exports = { app, start };
