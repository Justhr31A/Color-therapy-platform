'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { createUserRepository } = require('../repositories/users.repo');
const { isUniqueViolation } = require('../db/errors');
const asyncRoute = require('../utils/asyncRoute');
const { hashPassword, comparePassword } = require('../utils/password');
const { signToken } = require('../utils/jwt');
const { requireAuth, COOKIE_NAME } = require('../middleware/auth');

const router = express.Router();
const users = createUserRepository(db);

/**
 * Auth cookie policy.
 *
 * In production the frontend and the API are on DIFFERENT sites (for example colour-therapy-platform.onrender.com and
 * colour-therapy-platforms.onrender.com; onrender.com is a public suffix, so each subdomain is its own site). A browser
 * only stores - and later sends - a cookie that arrives on a cross-site API response when it is `SameSite=None; Secure`.
 * A `Lax` cookie is silently dropped: login "succeeds" but the very next request carries no cookie (401 Not authenticated).
 *
 * So `SameSite=None; Secure` is used whenever the app runs in production. That is decided by, in order:
 *   1. COOKIE_SECURE, if set to true/false (case- and whitespace-insensitive, so "True" or " true " still work);
 *   2. otherwise NODE_ENV=production, or RENDER=true (Render sets it on every service).
 * Localhost development (nothing set) keeps `SameSite=Lax`, non-Secure, which works over plain http.
 * Set COOKIE_SECURE=false to opt out (for example a plain-http staging server).
 * The cookie is always httpOnly: the JWT is never readable by JavaScript.
 */
function useCrossSiteCookie() {
  const flag = String(process.env.COOKIE_SECURE || '').trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
}

/** The attributes that identify the cookie. Used to set it AND to clear it, so logout removes exactly what login set. */
function authCookieOptions() {
  const crossSite = useCrossSiteCookie();
  return {
    httpOnly: true,
    secure: crossSite,
    sameSite: crossSite ? 'none' : 'lax',
    path: '/',
  };
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    ...authCookieOptions(),
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Public DOCTOR registration — TEMPORARILY RE-ENABLED (small team of doctors for now).
 *
 * Anyone can create an ordinary doctor account here. What this endpoint can and cannot do:
 *   - The role is ALWAYS 'doctor' and the status 'active'. They are written as literals below; nothing from the
 *     request body (role, status, id, ...) is ever read, so a caller cannot ask for 'admin' (or anything else).
 *     Admin accounts are still created only by an operator (`npm run admin:create`).
 *   - It cannot take over an existing account: an email that already has a password is refused (409), and so is an
 *     email reserved for a pending patient invite - a patient row is never overwritten with doctor credentials.
 *     Activating a patient account is a different route (/patient/activate), unchanged.
 *   - A doctor account has exactly the access doctors already have; this route does not touch ownership, publishing
 *     or any admin route.
 * To turn registration off again, replace this handler with a 403 response (git history has the previous version).
 */
router.post('/register', asyncRoute(async (req, res) => {
  const { name, email, password } = req.body || {};

  // Strings only: a non-string name/password (a number, an array, an object) must be a 400, never a thrown error
  // inside this async handler (an unhandled rejection would take the whole server down).
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const normalizedEmail = email.toLowerCase();
  const existing = await users.findByEmail(normalizedEmail);
  if (existing && existing.password_hash) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  if (existing && !existing.password_hash) {
    // This email was pre-created as a "pending" patient invite by a doctor. Registering here would collide with
    // that role, which is not switched automatically - refuse clearly rather than overwrite a patient record.
    return res
      .status(409)
      .json({ error: 'That email is already reserved for a patient account. Use a different email.' });
  }

  const passwordHash = await hashPassword(password);
  const id = uuidv4();

  try {
    // Role and status are literals here: nothing from the request body can choose them.
    await users.create({ id, name: name.trim(), email: normalizedEmail, passwordHash, role: 'doctor', status: 'active' });
  } catch (err) {
    // Two simultaneous sign-ups with the same email both pass the check above; the UNIQUE constraint decides.
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    throw err;
  }

  const token = signToken({ sub: id, role: 'doctor' });
  setAuthCookie(res, token);

  return res.status(201).json({ id, name: name.trim(), email: normalizedEmail, role: 'doctor' });
}));

/**
 * Patient account activation.
 */
router.post('/patient/activate', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};

  if (!isValidEmail(email)) {
    return res.status(400).json({
      error: 'A valid email is required.',
    });
  }

  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters.',
    });
  }

  const user = await users.findByEmail(email.toLowerCase());

  if (
    !user ||
    user.role !== 'patient' ||
    user.status !== 'pending' ||
    user.password_hash
  ) {
    return res.status(404).json({
      error:
        'No pending invitation was found for that email. Ask your doctor to assign you a protocol first.',
    });
  }

  const passwordHash = await hashPassword(password);

  await users.setPasswordAndStatus(user.id, passwordHash, 'active');

  const token = signToken({
    sub: user.id,
    role: 'patient',
  });

  setAuthCookie(res, token);

  return res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: 'patient',
  });
}));

router.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};

  if (!isValidEmail(email) || !password) {
    return res.status(400).json({
      error: 'Email and password are required.',
    });
  }

  const user = await users.findByEmail(email.toLowerCase());

  if (!user || user.status !== 'active') {
    return res.status(401).json({
      error: 'Invalid email or password.',
    });
  }

  const ok = await comparePassword(password, user.password_hash);

  if (!ok) {
    return res.status(401).json({
      error: 'Invalid email or password.',
    });
  }

  const token = signToken({
    sub: user.id,
    role: user.role,
  });

  setAuthCookie(res, token);

  return res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  });
}));

router.post('/logout', (req, res) => {
  // Must carry the same Secure/SameSite/Path as when it was set, or a browser will not remove it across sites.
  res.clearCookie(COOKIE_NAME, authCookieOptions());
  return res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  return res.json(req.user);
});

module.exports = router;