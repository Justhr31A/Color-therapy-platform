'use strict';

const { verifyToken } = require('../utils/jwt');
const db = require('../db');
const { createUserRepository } = require('../repositories/users.repo');

const users = createUserRepository(db);

const COOKIE_NAME = 'ctpp_token';

/**
 * Requires a valid session (JWT stored in an httpOnly cookie).
 * Attaches the current user row (minus password_hash) to req.user.
 * This is enforced on the server for every protected route — the frontend
 * hiding buttons for other roles is a UX nicety only, never the real gate.
 */
async function requireAuth(req, res, next) {
  const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  try {
    const payload = verifyToken(token);
    const user = await users.findSessionUser(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'Session no longer valid.' });
    }
    req.user = user;
    return next();
  } catch (err) {
    if (err && (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError')) {
      return res.status(401).json({ error: 'Session expired or invalid.' });
    }
    return next(err);
  }
}

module.exports = { requireAuth, COOKIE_NAME };
