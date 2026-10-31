const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!SECRET || SECRET === 'replace-this-with-a-long-random-secret') {
  // eslint-disable-next-line no-console
  console.warn(
    '[auth] WARNING: JWT_SECRET is missing or still set to the placeholder value. ' +
      'Set a real random secret in your .env file before deploying this anywhere real users can reach it.'
  );
}

function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { signToken, verifyToken };
